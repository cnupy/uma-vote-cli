// Commit pipeline, extracted from src/commit.ts so a shell app can call it as
// a function. Pure lift-and-parameterize: the flags arrive as options, every
// print of the original script goes through the output sink (console-backed by
// default) and the process.exit codes become return values. The interactive
// hooks stay pluggable: the full-screen review via a reviewVotes-style
// callback, confirm prompts via ask()'s PromptBridge. Note: the common.ts
// helpers used here (resolveFees, sendMulticallBatched and its pendingTxGuard,
// the uncaught-error handler) still print to the console directly — the shell
// can revisit that later.
import path from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { encodeFunctionData, getAddress } from 'viem'
import { umaContractAbi } from '../umaAbi'
import { EXPECTED_VOTER, ANSWERS_FILE, ROOT } from '../config'
import { getSigningKey, deterministicSalt, encryptVote, type SigningKey } from '../crypto'
import { ask } from '../signers/prompt'
import { loadAddons } from '../addons'
import { getOnChainCommitments, takeCommitment, priceLabel, GREEN, RED, DIM, RESET } from '../compare'
import {
    publicClient, votingContract, getWalletAccount, getVotePhase, getCurrentRoundId,
    getPendingRequests, getVoterFromDelegate, matchAnswer, decodeIdentifier, encodePrice,
    randomSalt, commitHash, loadRound, saveRound, phaseEndsAt, fmtCountdown, short, resolveFees,
    sendMulticallBatched, getAnswers, titleFromAncillary, type StoredVote, type Answer,
} from '../common'
import type { ReviewOpts, ReviewRow } from '../commit-ui'
import { consoleSink, type OutputSink } from './sink'

export type CommitFlowOpts = {
    dryRun: boolean             // --dry-run: simulate + print calldata, send nothing
    force: boolean              // --force: skip verification/diff aborts, re-send everything
    yes: boolean                // --yes: skip the batch path's y/N confirm
    // On a terminal the full-screen review (adjust answers, inspect details/docs/
    // comments, confirm) replaces the printed table and the y/N prompt. --yes,
    // --dry-run and piped runs keep the non-interactive table.
    interactive: boolean
    review?: (opts: ReviewOpts) => Promise<ReviewRow[] | null>  // defaults to commit-ui's reviewVotes (lazy import)
    out?: OutputSink
}

// Runs the commit pipeline and returns the process exit code. Signer/RPC
// errors still propagate — the CLI entrypoint relies on common.ts's uncaught
// handler, exactly as before.
export async function runCommitFlow(opts: CommitFlowOpts): Promise<number> {
    const { dryRun, force, interactive } = opts
    const out = opts.out ?? consoleSink
    const review = opts.review ?? (async (o: ReviewOpts) => (await import('../commit-ui')).reviewVotes(o))

    const phase = await getVotePhase()
    if (phase !== 0) {
        out.error(`Not commit phase (current phase: reveal). Commit phase starts ${phaseEndsAt().toISOString()}.`)
        return 1
    }

    const roundId = await getCurrentRoundId()
    out.log(`Round ${roundId} — commit phase, ends ${phaseEndsAt().toISOString()} (${fmtCountdown(phaseEndsAt())} left)\n`)

    const pending = await getPendingRequests()
    const active = pending.filter(r => r.lastVotingRound === roundId)
    const rolled = pending.length - active.length
    if (rolled > 0) out.log(`Note: ${rolled} pending request(s) belong to a different round and are excluded.`)
    if (active.length === 0) {
        out.log('No votable requests this round. Nothing to do.')
        return 0
    }
    out.log(`${active.length} votable request(s) this round.`)

    // Answers: ANSWERS_FILE override → local answers/<roundId>.json → addons.
    // Installed addons then get a pre-commit verification gate and a provenance
    // report slot (see src/addons.ts).
    let answersResult = await getAnswers(roundId)

    // Nothing local — let addons pull from upstream right here (the verification
    // gate below still hash-checks whatever they deliver).
    if (!answersResult) {
        for (const addon of await loadAddons()) {
            if (!addon.pullAnswers) continue
            out.log(`No local answers for round ${roundId} — pulling via addon "${addon.name}"...`)
            try {
                answersResult = await addon.pullAnswers(roundId)
            } catch (e) {
                out.error(`⚠ ${addon.name}: pull failed (${(e as Error).message.split('\n')[0]}).`)
            }
            if (answersResult) break
        }
    }

    // Still nothing: interactively you can answer every request from scratch
    // (like the dApp); the batch flow has nothing to work with and aborts.
    if (!answersResult) {
        if (!interactive) {
            out.error(`No answers for round ${roundId}.`)
            out.error(`Provide them via ANSWERS_FILE=<path>, save answers/${roundId}.json, install an answers addon (see README) — or run on a terminal without --yes to answer interactively.`)
            return 1
        }
        out.log(`No answers source — opening the review with every request unanswered.`)
        answersResult = { source: '(none — answered interactively)', answers: [] }
    }
    out.log(`Answers: ${answersResult.source} (${answersResult.answers.length} entries)`)
    if (ANSWERS_FILE) {
        out.log(`ANSWERS_FILE override — addon verification still applies.\n`)
    }
    for (const addon of answersResult.answers.length > 0 ? await loadAddons() : []) {
        if (addon.verifyBeforeCommit) {
            try {
                const v = await addon.verifyBeforeCommit(roundId, answersResult.answers)
                if (v.ok) out.log(`✓ ${addon.name}: ${v.detail}`)
                else {
                    out.error(`\n❌ ${addon.name}: ${v.detail}`)
                    if (!force) return 1
                    out.error(`--force set: proceeding anyway.`)
                }
            } catch (e) {
                out.error(`\n❌ ${addon.name}: verification failed (${(e as Error).message.split('\n')[0]}).`)
                if (!force) {
                    out.error(`Aborting — re-run to retry, or --force to skip verification.`)
                    return 1
                }
                out.error(`--force set: proceeding without verification.`)
            }
        }
        await addon.report?.(roundId)
    }
    out.log('')

    // Match every active request to an answer. Requests without a committable
    // answer (unmatched / marked skip / unencodable) are kept too: the interactive
    // review can still answer them, the batch path reports them as problems.
    const pool = [...answersResult.answers]
    type PlannedVote = StoredVote & { priceBig: bigint; saltBig: bigint; timeBig: bigint; changed?: boolean }
    type PlannedRequest = {
        identifier: `0x${string}`; identifierDecoded: string
        time: bigint; ancillaryData: `0x${string}`
        question: string
        needsTitle?: boolean        // placeholder question — the review resolves the real title lazily
        answer: string              // '' when the source gave nothing usable
        price?: bigint              // undefined = not committable as-is
        onchainPrice?: bigint
        problem?: string
    }
    const planned: PlannedRequest[] = []

    for (const r of active) {
        const identifierDecoded = decodeIdentifier(r.identifier)
        const base = { identifier: r.identifier, identifierDecoded, time: r.time, ancillaryData: r.ancillaryData }
        const answer = matchAnswer(r, pool)
        if (!answer) {
            const title = titleFromAncillary(r.ancillaryData)
            planned.push({
                ...base, question: title ?? `${identifierDecoded} @ ${r.time}`, needsTitle: !title, answer: '',
                problem: `UNMATCHED  ${identifierDecoded} @ ${r.time} — no answer for ancillaryData ${short(r.ancillaryData)}`,
            })
            continue
        }
        if (answer.skip === true) {
            planned.push({ ...base, question: answer.question, answer: '', problem: `SKIPPED    "${answer.question}" — marked skip in answers file` })
            continue
        }
        const price = encodePrice(answer.answer, identifierDecoded)
        if (price === undefined) {
            planned.push({
                ...base, question: answer.question, answer: answer.answer,
                problem: `NO PRICE   "${answer.question}" — can't encode answer "${answer.answer}" for identifier ${identifierDecoded}`,
            })
            continue
        }
        planned.push({ ...base, question: answer.question, answer: answer.answer, price })
    }

    // Diff against what's already committed on-chain this round (tool or dApp).
    // If the fetch fails we ABORT rather than proceed diff-less — otherwise an RPC
    // hiccup would silently re-send all votes instead of only the changes.
    let onchain: Awaited<ReturnType<typeof getOnChainCommitments>>
    try {
        onchain = await getOnChainCommitments(roundId)
    } catch (e) {
        out.error(`\n❌ Couldn't fetch your existing on-chain commitments (${(e as Error).message.split('\n')[0]}).`)
        if (!force) {
            out.error(`Aborting — without them the diff is unavailable and this run would re-send ALL votes.`)
            out.error(`Re-run to retry (RPC log index can lag right after a tx), or --force to send everything without diffing.`)
            return 1
        }
        out.error(`--force set: proceeding without a diff — ALL matched votes will be sent.`)
        onchain = undefined
    }
    // Attach each request's existing commitment — covers unmatched requests too,
    // so the interactive review also shows votes committed via the dApp that the
    // answers source doesn't know about.
    const unclaimed = onchain ? [...onchain.commitments] : []
    if (onchain) {
        for (const p of planned) p.onchainPrice = takeCommitment(unclaimed, p.ancillaryData, p.time)?.price
    }

    const toPlannedVote = (p: { identifier: `0x${string}`; identifierDecoded: string; time: bigint; ancillaryData: `0x${string}`; question: string; answer: string }, price: bigint): PlannedVote => ({
        identifier: p.identifier, identifierDecoded: p.identifierDecoded,
        time: p.time.toString(), timeBig: p.time,
        ancillaryData: p.ancillaryData,
        question: p.question, answer: p.answer,
        price: price.toString(), priceBig: price,
        salt: '0', saltBig: 0n,
    })

    let toSend: PlannedVote[]

    if (interactive) {
        const reviewed = await review({
            roundId, phaseEnd: phaseEndsAt(), diffAvailable: !!onchain, force,
            rows: planned.map(p => ({
                question: p.question, needsTitle: p.needsTitle, identifier: p.identifier, identifierDecoded: p.identifierDecoded,
                time: p.time, ancillaryData: p.ancillaryData,
                answer: p.answer, sourceAnswer: p.answer || undefined, onchainPrice: p.onchainPrice,
            })),
        })
        if (!reviewed) {
            out.log('Aborted — nothing sent.')
            return 0
        }
        toSend = []
        let unanswered = 0
        const answered: Answer[] = []
        for (const r of reviewed) {
            const price = r.answer ? encodePrice(r.answer, r.identifierDecoded) : undefined
            if (price === undefined) { unanswered++; continue }
            answered.push({ ancillaryData: r.ancillaryData, timestamp: Number(r.time), question: r.question, answer: r.answer })
            // Committing a subset is safe: VotingV2.commitVote overwrites the hash
            // per request, other requests' commitments are untouched.
            if (onchain && !force && r.onchainPrice === price) continue
            toSend.push(toPlannedVote(r, price))
        }
        // Persist the review so a re-run prefills instead of starting blank. Saved
        // BEFORE sending (a rejected tx must not lose the review) and to a separate
        // .local.json — a pulled answers file is never overwritten and keeps precedence.
        if (answered.length > 0) {
            mkdirSync(path.join(ROOT, 'answers'), { recursive: true })
            writeFileSync(path.join(ROOT, 'answers', `${roundId}.local.json`), JSON.stringify(answered, null, 2))
        }
        if (unanswered > 0) out.log(`⚠ ${unanswered} unanswered request(s) skipped — no commit for them.`)
        if (onchain && unclaimed.length > 0) {
            out.log(`⚠️  ${unclaimed.length} of your on-chain commitment(s) have no counterpart in this round's requests — they stay as committed.`)
        }
        if (toSend.length === 0) {
            out.log(`${GREEN}✓ Nothing to send — your on-chain commitments already match the reviewed answers.${RESET}`)
            return 0
        }
        out.log(`Round ${roundId}: committing ${toSend.length} vote(s).`)
    } else {
        const votes = planned.filter(p => p.price !== undefined)
        const problems = planned.filter(p => p.problem).map(p => p.problem!)
        if (onchain) {
            out.log(`You already committed ${onchain.commitments.length} vote(s) this round with ${onchain.address} — diffing:\n`)
        }
        out.log('Votes to commit:')
        for (const [i, v] of votes.entries()) {
            let color = '', note = ''
            if (onchain) {
                if (v.onchainPrice === undefined) { color = DIM; note = '  (not committed yet)' }
                else if (v.onchainPrice === v.price) color = GREEN
                else { color = RED; note = `  (currently committed: ${priceLabel(v.onchainPrice)})` }
            }
            out.log(`${color}  ${String(i + 1).padStart(2)}. [${v.answer}] ${v.question}  (${v.identifierDecoded})${note}${RESET}`)
        }
        if (problems.length > 0) {
            out.log('\nNot committing:')
            for (const p of problems) out.log(`  ⚠ ${p}`)
        }
        if (votes.length === 0) {
            out.error('\nNothing committable. Aborting.')
            return 1
        }
        if (onchain && unclaimed.length > 0) {
            out.log(`\n⚠️  ${unclaimed.length} of your on-chain commitment(s) have no counterpart in this vote set — they stay as committed.`)
        }

        // Send only what actually changes the on-chain state; --force re-sends everything.
        const changed = votes.filter(p => p.onchainPrice === undefined || p.onchainPrice !== p.price)
        const sendReqs = onchain && !force ? changed : votes
        if (onchain && sendReqs.length === 0) {
            out.log(`\n${GREEN}✓ Your on-chain commitments already match all ${votes.length} vote(s) — nothing to change.${RESET}`)
            out.log(`Re-send anyway with --force.`)
            return 0
        }
        if (onchain && sendReqs.length < votes.length) {
            out.log(`\nCommitting only the ${sendReqs.length} changed/uncommitted vote(s) — the other ${votes.length - sendReqs.length} on-chain commitment(s) stay valid (--force re-sends all).`)
        }
        toSend = sendReqs.map(p => toPlannedVote(p, p.price!))

        // Explicit go-ahead before touching the wallet (skip with --yes; dry runs don't send)
        if (!dryRun && !opts.yes) {
            const reply = await ask(`\nCommit ${toSend.length} vote(s) for round ${roundId}? (y/N)`)
            if (!/^y(es)?$/i.test(reply)) {
                out.log('Aborted — nothing sent.')
                return 0
            }
        }
    }

    // Resolve signer + voter (handles both direct voting and delegate setups).
    // Dry runs can use EXPECTED_VOTER so Frame doesn't need to be running.
    const account = dryRun && EXPECTED_VOTER ? getAddress(EXPECTED_VOTER.toLowerCase()) : await getWalletAccount()
    const voter = await getVoterFromDelegate(account)
    out.log(`\nSigner:  ${account}${voter !== account ? `\nVoter:   ${voter} (delegated)` : ' (direct voter)'}`)

    // Signing key: enables deterministic salts + dApp-compatible encrypted blobs, so
    // reveal works from any machine (this tool or vote.uma.xyz) with just the HW wallet.
    let signingKey: SigningKey | undefined
    try {
        signingKey = await getSigningKey(account)
    } catch (e) {
        if (!dryRun) throw e
        out.log(`⚠ dry-run without Frame/cached key: using random salts, no encrypted blob.`)
    }

    // Salts + hashes, persisted BEFORE sending — losing salts before reveal means a slash.
    // (With a signing key the salts are also recoverable by re-signing on any machine.)
    for (const v of toSend) {
        v.saltBig = signingKey
            ? deterministicSalt(signingKey.signedMessage, roundId, v.identifier, v.timeBig, v.ancillaryData)
            : randomSalt()
        v.salt = v.saltBig.toString()
    }
    // Merge into the existing round file: only entries actually (re)committed now get
    // their salts recorded; prior entries (e.g. from an earlier commit) are kept.
    const keyOf = (x: { identifier: string; time: string; ancillaryData: string }) => `${x.identifier}-${x.time}-${x.ancillaryData}`.toLowerCase()
    const priorVotes = (loadRound(roundId)?.votes ?? []).filter(e => !toSend.some(t => keyOf(t) === keyOf(e)))
    const roundFilePath = saveRound({
        roundId, caller: account, voter,
        answersSource: answersResult.source,
        createdAt: new Date().toISOString(),
        votes: [...priorVotes, ...toSend.map(({ priceBig, saltBig, timeBig, changed, ...stored }) => stored)],
    })
    if (signingKey) {
        out.log(`Salts cached in ${path.relative(process.cwd(), roundFilePath)} (recoverable anytime via your hardware wallet — deterministic salts + on-chain encrypted blobs).\n`)
    } else {
        out.log(`Salts saved to ${roundFilePath} — BACK THIS FILE UP. Random salts, no encrypted blob: this file is the ONLY way to reveal.\n`)
    }

    const datas = await Promise.all(toSend.map(async v => encodeFunctionData({
        abi: umaContractAbi,
        functionName: 'commitAndEmitEncryptedVote',
        args: [
            v.identifier,
            v.timeBig,
            v.ancillaryData,
            commitHash(v.priceBig, v.saltBig, voter, v.timeBig, v.ancillaryData, roundId, v.identifier),
            // dApp-compatible blob: published in the EncryptedVote event so vote.uma.xyz
            // (or this tool's recovery) can decrypt price+salt and reveal from anywhere
            signingKey ? await encryptVote(signingKey.publicKey, v.priceBig, v.saltBig) : '0x',
        ],
    })))

    out.log('Simulating multicall...')
    await publicClient.simulateContract({ ...votingContract, functionName: 'multicall', args: [datas], account })
    out.log('Simulation OK.')

    if (dryRun) {
        const calldata = encodeFunctionData({ abi: umaContractAbi, functionName: 'multicall', args: [datas] })
        out.log(`\n--dry-run: not sending. To submit manually:\n  to:   ${votingContract.address}\n  data: ${calldata}`)
        return 0
    }

    out.log('')
    const fees = await resolveFees()
    const txHashes = await sendMulticallBatched(datas, account, fees, 'commit')

    const round = loadRound(roundId)!
    round.commitTxHash = txHashes[txHashes.length - 1]
    saveRound(round)
    out.log(`\n✅ Committed ${toSend.length} vote(s) in round ${roundId}.`)
    out.log(`Reveal window: ${phaseEndsAt().toISOString()} → +24h. Don't miss it — run \`nub run reveal\` tomorrow.`)
    // USB/WalletConnect signer sessions hold the event loop open — the entrypoint exits explicitly
    return 0
}
