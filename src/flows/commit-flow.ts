// Commit pipeline, extracted from src/commit.ts so a shell app can call it as
// a function. Pure lift-and-parameterize: the flags arrive as options, every
// print of the original script goes through the output sink (console-backed by
// default) and the process.exit codes become return values. The interactive
// hooks stay pluggable: the full-screen review via a reviewVotes-style
// callback, confirm prompts via ask()'s PromptBridge. Fee lines and
// sendMulticallBatched/pendingTxGuard output also flow through the sink; a
// declined pending-tx guard surfaces as AbortSend (handled here) instead of
// exiting, so an embedding app survives. Only the uncaught-error handler still
// prints directly.
import path from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { encodeFunctionData, getAddress } from 'viem'
import { umaContractAbi } from '../umaAbi'
import { EXPECTED_VOTER, ROOT } from '../config'
import { getSigningKey, deterministicSalt, encryptVote, type SigningKey } from '../crypto'
import { ask } from '../signers/prompt'
import { loadAddons } from '../addons'
import { collectAnswers, answersForGate, lookupVote, roundOverview, rowTitle, reconcile, nextBasis, nextDecided, batchAnswer, blockedInBatch, committedContested, keepsCommitment, rowProblem, voteKey, type Suggestion, type Conflict } from '../answers'
import { getOnChainCommitments, takeCommitment, priceLabel, GREEN, RED, DIM, RESET } from '../compare'
import {
    publicClient, votingContract, getWalletAccount, getVotePhase, getCurrentRoundId,
    getPendingRequests, getVoterFromDelegate, decodeIdentifier, encodePrice, describePrice, priceProblem, multipleValuesLabels,
    randomSalt, commitHash, loadRound, saveRound, phaseEndsAt, fmtCountdown, derivedPhase, computeFees, describeFees, feeWarning,
    sendMulticallBatched, AbortSend, isPlaceholderTitle, sanitizeText, type StoredVote, type Answer,
} from '../common'
import { resolveAncillaryText } from '../resolve'
import { fetchRoundResults, rollSummary } from '../round-results'
import type { ReviewOpts, ReviewOutcome } from '../commit-ui'
import { ensName } from '../ens'
import { consoleSink, captureConsole, type OutputSink } from './sink'

export type CommitFlowOpts = {
    dryRun: boolean             // --dry-run: simulate + print calldata, send nothing
    force: boolean              // --force: skip the verification and diff aborts; re-send rows whose commitment already matches (a differing one stays, unless the diff itself failed)
    yes: boolean                // --yes: skip the batch path's y/N confirm
    // On a terminal the full-screen review (adjust answers, inspect details/docs/
    // comments, confirm) replaces the printed table and the y/N prompt. --yes,
    // --dry-run and piped runs keep the non-interactive table.
    interactive: boolean
    // Re-ask every addon and make pulling addons pull before using their cache
    // (the embedded review's r key): a source often publishes mid-commit-phase,
    // so a run that opened all-unanswered can refresh without restarting the
    // app. Your saved review still overlays the result, and a source that
    // returns nothing keeps what you saved.
    refetch?: boolean
    review?: (opts: ReviewOpts) => Promise<ReviewOutcome>  // defaults to commit-ui's reviewVotes (lazy import)
    out?: OutputSink
}

// Runs the commit pipeline and returns the process exit code. Signer/RPC
// errors still propagate — the CLI entrypoint relies on common.ts's uncaught
// handler, exactly as before.
export async function runCommitFlow(opts: CommitFlowOpts): Promise<number> {
    const { dryRun, force, interactive } = opts
    const out = opts.out ?? consoleSink
    const review = opts.review ?? (async (o: ReviewOpts) => (await import('../commit-ui')).reviewVotes(o))

    let phase = await getVotePhase()
    // Phase-boundary lag: the contract derives the phase from the LATEST
    // BLOCK's timestamp, which trails the wall clock by up to a block or two
    // right after 00:00 UTC — while the app's rollover has already mounted
    // this flow. Wait for the chain to cross instead of bailing.
    if (phase !== 0 && derivedPhase() === 0) {
        out.log('Chain still shows the reveal phase (latest block predates the boundary) — waiting for it to cross…')
        for (let i = 0; i < 12 && phase !== 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 15_000))
            phase = await getVotePhase().catch(() => phase)
        }
    }
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

    // Answers: ANSWERS_FILE override, else every installed addon asked and
    // merged per vote (src/answers.ts). Each addon then gets a pre-commit gate
    // over the answers it supplied and a provenance report slot (see
    // src/addons.ts). --refetch (the review's r key) makes every pulling addon
    // pull again before falling back to its cache.
    // Addon-phase output (pull progress, provenance, trust warnings) is teed
    // into `addonNotices` besides the sink: the log panel is transient and the
    // review covers it, but the review must keep showing the trust warnings.
    const addonNotices: string[] = []
    const noticed = (fwd: (line: string) => void) => (line: string) => {
        // sanitized at the tee: notices render in the review (banner, confirm
        // modal, p view), whose other inputs are all sanitized at ingestion —
        // addon errors can echo remote text (HTTP error bodies etc.)
        addonNotices.push(...sanitizeText(line).split('\n').filter(l => l.trim()))
        fwd(line)
    }
    const teeSink: OutputSink = { log: noticed(out.log), warn: noticed(out.warn), error: noticed(out.error) }

    // captureConsole inside: addons print progress/provenance with console.*
    // — inside an Ink app that must land in the sink. `review` tells each
    // addon whether a human will see its answers before anything is signed.
    const answersResult = await collectAnswers(roundId, { pull: true, refetch: opts.refetch, review: interactive, out: teeSink })
    for (const s of answersResult.sources) teeSink.log(`Answers from ${s.addon}: ${s.answered} of ${s.total} vote(s) answered — ${s.label}`)
    // A dead or failing source is one plain line, in the log and the review's
    // banner (⚠), and everything else carries on
    for (const f of answersResult.failures) teeSink.warn(f)
    // Counted per request with the same timed/untimed join the rows get below
    // (lookupVote), so the banner and the rows agree on what a disagreement is
    const { disagreements, anyAnswer } = roundOverview(answersResult.votes, active.map(r => ({ ancillaryData: r.ancillaryData, timestamp: r.time })), answersResult.saved)
    if (disagreements.length > 0) teeSink.warn(`⚠ ${disagreements.length} vote(s) where the sources disagree or a source reports a conflict — left for you to decide.`)

    // No source answered anything: interactively you can answer every request
    // from scratch (like the dApp) or from your saved review; the batch flow
    // has nothing to work with and aborts.
    if (!anyAnswer) {
        if (!interactive) {
            out.error(`No answers for round ${roundId}.`)
            out.error(`Provide them via ANSWERS_FILE=<path>, save answers/${roundId}.json, install an answers addon (see README) — or run on a terminal without --yes to answer interactively.`)
            return 1
        }
        out.log(`No source answered — opening the review${answersResult.source.includes('saved review') ? ' from your saved review' : ' with every request unanswered'}.`)
    }
    out.log(`Answers: ${answersResult.source}`)
    if (answersResult.overrideFile) {
        out.log(`ANSWERS_FILE override — the only source; your saved review is not read, every addon gate still checks it.\n`)
    }
    for (const addon of await captureConsole(out, loadAddons)) {
        // Each gate checks only what its own addon supplied (ANSWERS_FILE goes
        // through every gate). An addon that supplied nothing has nothing to
        // verify and no report to give.
        const own = answersForGate(answersResult, addon.name)
        if (!own) continue
        if (addon.verifyBeforeCommit) {
            // A failed gate fails closed only when nobody can react: the batch
            // path (--yes/piped/--dry-run) aborts. Interactively the ❌ is teed
            // into the review's warnings banner instead — the human sees the
            // divergence and either re-pulls fresh upstream answers (r) or
            // reviews the differences deliberately before confirming.
            try {
                const v = await captureConsole(teeSink, () => addon.verifyBeforeCommit!(roundId, own))
                if (v.ok) teeSink.log(`✓ ${addon.name}: ${v.detail}`)
                else {
                    teeSink.error(`\n❌ ${addon.name}: ${v.detail}`)
                    if (!force && !interactive) return 1
                    if (interactive && !force) out.log(`Opening the review with this warning — press r to re-pull upstream, or review the differences.`)
                    else teeSink.error(`--force set: proceeding anyway.`)
                }
            } catch (e) {
                teeSink.error(`\n❌ ${addon.name}: verification failed (${(e as Error).message.split('\n')[0]}).`)
                if (!force && !interactive) {
                    out.error(`Aborting — re-run to retry, or --force to skip verification.`)
                    return 1
                }
                if (interactive && !force) out.log(`Opening the review anyway — press r to re-pull upstream, or review before committing.`)
                else teeSink.error(`--force set: proceeding without verification.`)
            }
        }
        if (addon.report) await captureConsole(teeSink, () => addon.report!(roundId))
    }
    out.log('')

    // Match every active request to its merged vote. Requests without a
    // committable answer (unknown to every source / disagreed / unencodable)
    // are kept too: the interactive review can still answer them, the batch
    // path reports them as problems. The owner's saved review (none under
    // ANSWERS_FILE) is laid over each row by `reconcile`: a row he decided
    // stays his, a source that moved since is flagged (sourceChanged), never
    // applied over him; a row that only held a suggestion follows the sources
    // and is flagged when the suggestion changed; a source that returns
    // nothing keeps what he saved. A source that reports a conflict on a vote
    // leaves it blank like a disagreement, reason shown. A batch run signs
    // only decided answers and what the sources say now (`batchAnswer`),
    // never a saved suggestion, and never over a commitment already on chain
    // that differs, his own decided answer included (`keepsCommitment`,
    // below).
    type PlannedVote = StoredVote & { priceBig: bigint; saltBig: bigint; timeBig: bigint; changed?: boolean }
    type PlannedRequest = {
        identifier: `0x${string}`; identifierDecoded: string
        time: bigint; ancillaryData: `0x${string}`
        question: string
        needsTitle?: boolean        // placeholder question — the review resolves the real title lazily
        answer: string              // planned: the owner's decided answer or the sources' agreed one; '' = nothing usable
        decided: boolean            // the answer is the owner's own (typed or confirmed); false = a suggestion
        sourceAnswer: string        // the sources' agreed answer as delivered ('' when none or disagreed)
        suggestions: Suggestion[]   // every source's non-empty answer, with its confidence
        conflicts: Conflict[]       // sources that found the vote contested, with their reasons
        disagree: boolean
        sourceChanged?: { from: string; to: string }
        suggestionChanged?: { from: string; to: string }
        basis: string               // persisted with the row (see the save below)
        labels?: string[]           // MULTIPLE_VALUES: the request's labels, one value each; undefined = count unknown
        price?: bigint              // undefined = not committable as-is
        onchainPrice?: bigint
        problem?: string
        rollCount: number           // rounds this request rolled through before this one
        lastRound?: string          // rolled: how the last round voted on it (filled for the review)
    }
    const planned: PlannedRequest[] = []
    const saved = answersResult.saved

    for (const r of active) {
        const identifierDecoded = decodeIdentifier(r.identifier)
        const base = { identifier: r.identifier, identifierDecoded, time: r.time, ancillaryData: r.ancillaryData }
        const vote = lookupVote(answersResult.votes, { ancillaryData: r.ancillaryData, timestamp: r.time })
        const s = saved?.get(voteKey({ ancillaryData: r.ancillaryData, timestamp: r.time }))
        const merged = reconcile(vote, s)
        const answer = interactive ? merged.answer : batchAnswer(merged, vote)
        // A MULTIPLE_VALUES vote carries one value per label, and the labels
        // are in the request's text (resolved via the dApp for cross-chain
        // requests, cached on disk). Without them the count is unknown and a
        // value list is refused rather than packed on a guess.
        let labels: string[] | undefined
        if (identifierDecoded === 'MULTIPLE_VALUES') {
            const text = await resolveAncillaryText(r.identifier, r.time, r.ancillaryData).catch(() => undefined)
            labels = text ? multipleValuesLabels(text) : undefined
        }
        // Display copies of the sources' text — sanitized here (post
        // verification gate: the gate must hash the answers exactly as
        // delivered, so ingestion can't do it). Price encoding runs on the raw
        // value. With every source gone the saved review's title still shows.
        const question = rowTitle(vote, s, r.ancillaryData) || `${identifierDecoded} @ ${r.time}`
        // A saved file can carry the previous review's placeholder instead of a
        // title — flag it so the review resolves it like an unmatched request
        const needsTitle = isPlaceholderTitle(question)
        const row: PlannedRequest = {
            ...base, question, needsTitle,
            answer: sanitizeText(answer), decided: merged.decided, sourceAnswer: sanitizeText(vote?.answer ?? ''),
            suggestions: (vote?.suggestions ?? []).map(x => ({ addon: sanitizeText(x.addon), answer: sanitizeText(x.answer), confidence: sanitizeText(x.confidence) })),
            conflicts: (vote?.conflicts ?? []).map(c => ({ addon: sanitizeText(c.addon), reason: sanitizeText(c.reason) })),
            disagree: vote?.disagree ?? false, sourceChanged: merged.sourceChanged, suggestionChanged: merged.suggestionChanged, basis: merged.basis, labels,
            rollCount: r.rollCount,
        }
        row.problem = rowProblem({ ...row, answer, mergedAnswer: sanitizeText(merged.answer), known: !!vote || !!s })
        if (row.problem === undefined) {
            const price = encodePrice(answer, identifierDecoded, labels?.length)
            if (price === undefined) row.problem = `NO PRICE   "${question}" — answer "${row.answer}": ${priceProblem(answer, identifierDecoded, labels?.length)}`
            else row.price = price
        }
        planned.push(row)
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
        // A rolled request rolled from the round just before this one. That
        // round is final, so after the first read its results come from the
        // disk cache.
        const rolled = planned.filter(p => p.rollCount > 0)
        if (rolled.length > 0) {
            out.log(`Reading round ${roundId - 1} results for ${rolled.length} rolled vote(s)…`)
            const prev = await fetchRoundResults(roundId - 1).catch(() => undefined)
            for (const p of rolled) p.lastRound = `rolled from ${roundId - 1}: ${(prev && rollSummary(prev, p.ancillaryData, p.time)) ?? 'no result found'}`
        }
        // The review opens on the reconciled rows (planned above): the sources'
        // agreed answer, or your decided answer, with every source's
        // suggestion and confidence beside it, disagreements left blank, a
        // moved source and a changed suggestion flagged.
        const reviewed = await review({
            roundId, phaseEnd: phaseEndsAt(), diffAvailable: !!onchain, force,
            notices: addonNotices,
            rows: planned.map(p => ({
                question: p.question, needsTitle: p.needsTitle, identifier: p.identifier, identifierDecoded: p.identifierDecoded,
                time: p.time, ancillaryData: p.ancillaryData,
                answer: p.answer, decided: p.decided,
                sourceAnswer: p.sourceAnswer || undefined, sources: p.suggestions, conflicts: p.conflicts.length > 0 ? p.conflicts : undefined, disagree: p.disagree || undefined,
                sourceChanged: p.sourceChanged, suggestionChanged: p.suggestionChanged, onchainPrice: p.onchainPrice, labels: p.labels,
                rollCount: p.rollCount, lastRound: p.lastRound,
            })),
        })
        // Persist the review — confirmed OR aborted — so the next run prefills
        // instead of starting blank. Saved BEFORE sending (a rejected tx or a
        // quit must not lose the selections) and to a separate .local.json — a
        // pulled answers file is never overwritten. Confirming means pressing
        // y on the "Commit N vote(s)?" modal, in `nub run commit` and in the
        // uma app's commit screen alike; the file is written at that moment,
        // before the wallet is touched.
        toSend = []
        let unanswered = 0
        type LocalAnswer = Answer & { source?: string; decided?: boolean }
        const answered: LocalAnswer[] = []
        const prefilled = new Map(planned.map(p => [voteKey({ ancillaryData: p.ancillaryData, timestamp: p.time }), p]))
        for (const r of reviewed.rows) {
            // Persist every row (blanks included) WITH the source value it was
            // judged against (`source` = the basis) and whether it is yours
            // (`decided`): a row you changed, or any answered row when you
            // confirmed. A row you left as suggested and did not confirm is
            // saved as a suggestion: the next review prefills it, a batch run
            // does not sign it. A row you changed in this review takes the
            // sources' current agreed value as its basis; a row you left alone
            // keeps the basis `reconcile` settled on, so a flagged move stays
            // flagged until you re-enter it. Sources that returned nothing
            // never blank the basis: the row keeps what was saved. A deliberate
            // CLEAR (blank answer) is yours too, and survives.
            const p = prefilled.get(voteKey({ ancillaryData: r.ancillaryData, timestamp: r.time }))
            const basis = p ? nextBasis({ answer: r.answer, prefilled: p.answer, sourceAnswer: p.sourceAnswer, basis: p.basis }) : ''
            const decided = p ? nextDecided({ answer: r.answer, prefilled: p.answer, decided: p.decided }, reviewed.confirmed) : r.answer !== ''
            answered.push({ ancillaryData: r.ancillaryData, timestamp: Number(r.time), question: r.question, answer: r.answer, source: basis, decided })
            const price = r.answer ? encodePrice(r.answer, r.identifierDecoded, r.labels?.length) : undefined
            if (price === undefined) { unanswered++; continue }
            // Committing a subset is safe: VotingV2.commitVote overwrites the hash
            // per request, other requests' commitments are untouched.
            if (onchain && !force && r.onchainPrice === price) continue
            toSend.push(toPlannedVote(r, price))
        }
        if (answered.length > 0) {
            mkdirSync(path.join(ROOT, 'answers'), { recursive: true })
            writeFileSync(path.join(ROOT, 'answers', `${roundId}.local.json`), JSON.stringify(answered, null, 2))
        }
        if (!reviewed.confirmed) {
            const yours = answered.filter(a => a.decided).length
            out.log(`Aborted — nothing sent.${answered.length > 0 ? ` Saved: ${yours} answer(s) of yours, ${answered.length - yours} suggestion(s) you did not confirm; both prefill the next review, only yours count in a batch run.` : ''}`)
            return 0
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
        // Batch: nobody can pick a side, so a vote the sources disagree on and
        // you never decided aborts the run outright (--force does not override
        // this: it skips verification, it does not choose answers). One
        // exception: a vote you already committed on chain, where nothing
        // would be sent anyway (below, keepsCommitment); it is left as
        // committed and listed with the others, and the rest of the run goes
        // on. Without the on-chain diff it blocks like the rest. A source
        // that moved after you decided is noted; your decided answer stands. A
        // suggestion that changed since you last saw it is noted too; the
        // sources' current answer is what a batch run signs for such a row.
        const sides = (p: PlannedRequest) => [...p.suggestions.map(x => `${x.addon} ${x.answer} (${x.confidence})`), ...p.conflicts.map(c => `${c.addon} sees a conflict (${c.reason})`)].join(' vs ')
        const blocked = blockedInBatch(planned)
        if (blocked.length > 0) {
            out.error(`\n❌ ${blocked.length} vote(s) where the sources disagree or a source reports a conflict, and you have not decided:`)
            for (const p of blocked) out.error(`  ${p.question.slice(0, 70)} — ${sides(p)}`)
            out.error(`Aborting — decide them on a terminal without --yes (the review), or save answers/${roundId}.local.json.`)
            return 1
        }
        const contested = committedContested(planned)
        for (const p of planned.filter(p => p.sourceChanged)) {
            out.warn(`⚠ ${p.question.slice(0, 70)}: source moved ${p.sourceChanged!.from || '(blank)'} → ${p.sourceChanged!.to} since you decided; your ${p.answer || '(blank)'} stands.`)
        }
        // A commitment already on chain is a choice the owner made, whoever
        // or whatever made it for him: a batch run never replaces it, not
        // with a suggestion and not with a decided answer of his either (he
        // may have recommitted in the dApp after deciding here; this run
        // cannot tell which he meant). The row is left as committed and the
        // difference is reported.
        const kept = planned.filter(keepsCommitment)
        const whose = (p: PlannedRequest) => p.decided ? `your saved answer is ${p.answer}` : `the sources now say ${p.answer}`
        for (const p of kept) {
            out.warn(`⚠ ${p.question.slice(0, 70)}: you committed ${priceLabel(p.onchainPrice!, p.identifierDecoded, p.labels?.length)} on chain and ${whose(p)}; a batch run never replaces your commitment. It stays; change it in the review if you mean to.`)
            p.price = undefined
        }
        for (const p of planned.filter(p => p.suggestionChanged && p.price !== undefined)) {
            out.warn(`⚠ ${p.question.slice(0, 70)}: the suggestion changed ${p.suggestionChanged!.from} → ${p.suggestionChanged!.to} since you last reviewed it; you never confirmed it, so the sources' current ${p.suggestionChanged!.to} is what this run signs.`)
        }
        const votes = planned.filter(p => p.price !== undefined)
        // a contested vote left as committed is listed there, not as a problem
        const problems = planned.filter(p => p.problem && !contested.includes(p)).map(p => p.problem!)
        if (onchain) {
            out.log(`You already committed ${onchain.commitments.length} vote(s) this round with ${onchain.address} — diffing:\n`)
        }
        out.log('Votes to commit:')
        for (const [i, v] of votes.entries()) {
            let color = '', note = ''
            if (onchain) {
                if (v.onchainPrice === undefined) { color = DIM; note = '  (not committed yet)' }
                else if (v.onchainPrice === v.price) color = GREEN
                else { color = RED; note = `  (currently committed: ${priceLabel(v.onchainPrice, v.identifierDecoded, v.labels?.length)})` }
            }
            // a packed MULTIPLE_VALUES answer shows the values it encodes
            const meaning = describePrice(v.price!, v.identifierDecoded, v.labels?.length)
            out.log(`${color}  ${String(i + 1).padStart(2)}. [${v.answer}${meaning ? ` = ${meaning}` : ''}] ${v.question}  (${v.identifierDecoded})${note}${RESET}`)
        }
        if (kept.length + contested.length > 0) {
            out.log('\nLeft as committed (a batch run never replaces your on-chain commitment):')
            for (const p of kept) out.log(`  ${GREEN}✓${RESET} ${p.question.slice(0, 70)}  committed ${priceLabel(p.onchainPrice!, p.identifierDecoded, p.labels?.length)}, ${whose(p)}`)
            for (const p of contested) out.log(`  ${GREEN}✓${RESET} ${p.question.slice(0, 70)}  committed ${priceLabel(p.onchainPrice!, p.identifierDecoded, p.labels?.length)}; undecided: ${sides(p)}; change it in the review if you mean to`)
        }
        if (problems.length > 0) {
            out.log('\nNot committing:')
            for (const p of problems) out.log(`  ⚠ ${p}`)
        }
        if (votes.length === 0) {
            if (kept.length + contested.length > 0 && problems.length === 0) {
                out.log(`\n${GREEN}✓ Nothing to send — your on-chain commitments stand.${RESET}`)
                return 0
            }
            out.error('\nNothing committable. Aborting.')
            return 1
        }
        if (onchain && unclaimed.length > 0) {
            out.log(`\n⚠️  ${unclaimed.length} of your on-chain commitment(s) have no counterpart in this vote set — they stay as committed.`)
        }

        // Send only what actually changes the on-chain state. --force also
        // re-sends the rows whose commitment already matches; the differing
        // rows were zeroed above (keepsCommitment) and stay as committed
        // whatever the flag says. Only with the diff unavailable (onchain
        // undefined, --force) does this send over an existing commitment.
        const changed = votes.filter(p => p.onchainPrice === undefined || p.onchainPrice !== p.price)
        const sendReqs = onchain && !force ? changed : votes
        if (onchain && sendReqs.length === 0) {
            out.log(`\n${GREEN}✓ Your on-chain commitments already match all ${votes.length} vote(s) — nothing to change.${RESET}`)
            out.log(`--force re-sends the matching commitments as they are.`)
            return 0
        }
        if (onchain && sendReqs.length < votes.length) {
            out.log(`\nCommitting only the ${sendReqs.length} changed/uncommitted vote(s) — the other ${votes.length - sendReqs.length} on-chain commitment(s) stay valid (--force re-sends the matching ones too).`)
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
    const accountEns = await ensName(account)
    out.log(`\nSigner:  ${accountEns ? `${accountEns} (${account})` : account}${voter !== account ? `\nVoter:   ${voter} (delegated)` : ' (direct voter)'}`)

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
    const fees = await computeFees()
    out.log(describeFees(fees))
    const warn = feeWarning(fees)
    if (warn) out.log(warn)
    let txHashes: `0x${string}`[]
    try {
        txHashes = await sendMulticallBatched(datas, account, fees, 'commit', out)
    } catch (e) {
        if (e instanceof AbortSend) { out.log(e.message); return 0 }
        throw e
    }

    const round = loadRound(roundId)!
    round.commitTxHash = txHashes[txHashes.length - 1]
    saveRound(round)
    out.log(`\n✅ Committed ${toSend.length} vote(s) in round ${roundId}.`)
    out.log(`Reveal window: ${phaseEndsAt().toISOString()} → +24h. Don't miss it — run \`nub run reveal\` tomorrow.`)
    // USB/WalletConnect signer sessions hold the event loop open — the entrypoint exits explicitly
    return 0
}
