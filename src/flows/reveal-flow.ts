// Reveal pipeline, extracted from src/reveal.ts so a shell app can call it as
// a function. Pure lift-and-parameterize: the flags arrive as options, every
// print of the original script goes through the output sink (console-backed by
// default) and the process.exit codes become return values. Fee lines and
// sendMulticallBatched/pendingTxGuard output also flow through the sink; a
// declined pending-tx guard surfaces as AbortSend (handled here) instead of
// exiting, so an embedding app survives. Only the uncaught-error handler still
// prints directly.
//
// Chain-first: the price+salt for every reveal comes from decrypting your own
// on-chain EncryptedVote blobs (the latest per request wins), which covers
// commits made by this tool AND by vote.uma.xyz — including mixed rounds where
// some requests were re-committed with different salts. The local round file
// is only a fallback for legacy commits that carried no encrypted blob.
import { encodeFunctionData } from 'viem'
import { readdirSync, existsSync } from 'node:fs'
import { umaContractAbi } from '../umaAbi'
import { ROUNDS_DIR } from '../config'
import {
    publicClient, votingContract, getWalletAccount, getVotePhase, getCurrentRoundId,
    getVoterFromDelegate, getEncryptedVoteEvents, decodeIdentifier, computeFees, describeFees, feeWarning, sendMulticallBatched, AbortSend,
    loadRound, saveRound, phaseEndsAt, fmtCountdown, type RoundFile,
} from '../common'
import { getSigningKey, decryptVote } from '../crypto'
import { priceLabel } from '../compare'
import { consoleSink, type OutputSink } from './sink'

export type RevealFlowOpts = {
    dryRun: boolean             // --dry-run: simulate + print calldata, send nothing
    force: boolean              // --force: retry even if this round is already marked revealed
    out?: OutputSink
}

// Human reason from a viem revert: the useful text sits on the line AFTER
// "reverted with the following reason:", not on the first line. VotingV2
// clears the commit hash once a vote is revealed, so its "Invalid hash & salt"
// revert on a re-run almost always just means "already revealed".
function revealSkipReason(e: unknown): string {
    const err = e as Error & { cause?: { reason?: string } }
    const lines = (err.message ?? String(e)).split('\n').map(l => l.trim()).filter(Boolean)
    const after = lines.findIndex(l => l.endsWith('reverted with the following reason:'))
    const reason = err.cause?.reason ?? (after >= 0 ? lines[after + 1] : lines[0]) ?? 'unknown revert'
    return /invalid hash/i.test(reason)
        ? `already revealed (on-chain: "${reason}" — the commit hash is cleared by a reveal)`
        : reason
}

// Tool-managed rounds that were committed but never revealed before their window closed
function missedRounds(currentRoundId: number): number[] {
    if (!existsSync(ROUNDS_DIR)) return []
    return readdirSync(ROUNDS_DIR)
        .map(f => /^(\d+)\.json$/.exec(f)?.[1])
        .filter((id): id is string => id !== undefined)
        .map(Number)
        .filter(id => id < currentRoundId)
        .filter(id => { const r = loadRound(id); return r?.commitTxHash && !r.revealTxHash })
}

// Runs the reveal pipeline and returns the process exit code. Signer/RPC
// errors still propagate — the CLI entrypoint relies on common.ts's uncaught
// handler, exactly as before.
export async function runRevealFlow(opts: RevealFlowOpts): Promise<number> {
    const { dryRun, force } = opts
    const out = opts.out ?? consoleSink

    const phase = await getVotePhase()
    if (phase !== 1) {
        const currentRoundId = await getCurrentRoundId()
        out.error(`Not reveal phase (current phase: commit).`)
        const missed = missedRounds(currentRoundId)
        if (missed.length > 0) {
            out.error(`\n💀 MISSED REVEAL: round(s) ${missed.join(', ')} were committed but never revealed and their window has closed.`)
            out.error(`Those commitments count as no-shows (slashed); revealing them is no longer possible.`)
            out.error(`The reveal phase starting ${phaseEndsAt().toISOString()} is for the CURRENT round (${currentRoundId}) only.`)
        } else {
            out.error(`Reveal phase for round ${currentRoundId} starts ${phaseEndsAt().toISOString()} (${fmtCountdown(phaseEndsAt())}).`)
        }
        return 1
    }

    const roundId = await getCurrentRoundId()
    out.log(`Round ${roundId} — reveal phase, ends ${phaseEndsAt().toISOString()} (${fmtCountdown(phaseEndsAt())} left)\n`)

    const missedEarlier = missedRounds(roundId)
    if (missedEarlier.length > 0) {
        out.log(`💀 Note: earlier round(s) ${missedEarlier.join(', ')} were committed but never revealed — their window closed (slashed). Only round ${roundId} can be revealed now.\n`)
    }

    const account = await getWalletAccount()
    const fileRound = loadRound(roundId)

    if (fileRound?.revealTxHash && !force) {
        out.error(`Already revealed this round (tx ${fileRound.revealTxHash}). Use --force to retry.`)
        return 1
    }

    // Latest commitment per request, from on-chain blobs
    const events = await getEncryptedVoteEvents(account, roundId)
    type Reveal = { identifier: `0x${string}`; time: bigint; ancillaryData: `0x${string}`; price: bigint; salt: bigint; label: string }
    const reveals: Reveal[] = []
    const undecryptable: string[] = []

    if (events.length > 0) {
        const key = await getSigningKey(account)
        const fileVotes = fileRound?.votes ?? []
        for (const ev of events) {
            const label = `${decodeIdentifier(ev.identifier)} @ ${ev.time}`
            try {
                if (ev.encryptedVote === '0x' || ev.encryptedVote.length <= 4) throw new Error('empty blob')
                const { price, salt } = await decryptVote(key.privateKey, ev.encryptedVote)
                reveals.push({ identifier: ev.identifier, time: ev.time, ancillaryData: ev.ancillaryData, price: BigInt(price), salt: BigInt(salt), label })
            } catch {
                // No/foreign blob — fall back to the local round file (legacy random-salt commits)
                const v = fileVotes.find(f =>
                    f.identifier.toLowerCase() === ev.identifier.toLowerCase() &&
                    BigInt(f.time) === ev.time &&
                    f.ancillaryData.toLowerCase() === ev.ancillaryData.toLowerCase())
                if (v) reveals.push({ identifier: ev.identifier, time: ev.time, ancillaryData: ev.ancillaryData, price: BigInt(v.price), salt: BigInt(v.salt), label: `${label} (salt from local file)` })
                else undecryptable.push(label)
            }
        }
    } else if (fileRound && fileRound.votes.length > 0) {
        out.log(`No EncryptedVote events found — falling back entirely to rounds/${roundId}.json.`)
        for (const v of fileRound.votes) {
            reveals.push({ identifier: v.identifier, time: BigInt(v.time), ancillaryData: v.ancillaryData, price: BigInt(v.price), salt: BigInt(v.salt), label: v.question })
        }
    } else {
        out.error(`No commitments found for ${account} in round ${roundId} — nothing to reveal.`)
        return 1
    }

    if (undecryptable.length > 0) {
        out.log(`⚠️  ${undecryptable.length} commitment(s) can't be revealed (no decryptable blob, no local salt):`)
        for (const u of undecryptable) out.log(`  ⚠ ${u}`)
        out.log(`If these were committed by the dApp with a different signing key, reveal them on vote.uma.xyz.\n`)
    }

    out.log(`Votes to reveal (${reveals.length}):`)
    for (const [i, r] of reveals.entries()) {
        out.log(`  ${String(i + 1).padStart(2)}. [${priceLabel(r.price)}] ${r.label}`)
    }

    // Simulate each reveal individually so one already-revealed/uncommitted entry
    // doesn't block the rest of the batch.
    const datas: `0x${string}`[] = []
    const skipped: Array<{ label: string; reason: string }> = []
    for (const r of reveals) {
        const args = [r.identifier, r.time, r.price, r.ancillaryData, r.salt] as const
        try {
            await publicClient.simulateContract({ ...votingContract, functionName: 'revealVote', args: args as any, account })
            datas.push(encodeFunctionData({ abi: umaContractAbi, functionName: 'revealVote', args: args as any }))
        } catch (e) {
            skipped.push({ label: r.label, reason: revealSkipReason(e) })
        }
    }

    // Grouped by reason: re-runs after a successful reveal skip EVERY vote for
    // the same cause, and same-second Polymarket batches make the labels look
    // like duplicates — a per-vote wall of warnings reads like an error.
    if (skipped.length > 0) {
        const byReason = new Map<string, string[]>()
        for (const s of skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.label])
        out.log(`\nSkipping ${skipped.length} vote(s) — nothing to send for them:`)
        for (const [reason, labels] of byReason) {
            out.log(`  ⚠ ${labels.length} × ${reason}`)
            if (labels.length <= 4) for (const l of labels) out.log(`      ${l}`)
        }
    }
    if (datas.length === 0) {
        out.log(`\n✓ Nothing left to reveal in round ${roundId} — every commitment above is already revealed or not revealable. You're done here.`)
        return 0
    }

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
        txHashes = await sendMulticallBatched(datas, account, fees, 'reveal', out)
    } catch (e) {
        if (e instanceof AbortSend) { out.log(e.message); return 0 }
        throw e
    }
    const txHash = txHashes[txHashes.length - 1]

    const round: RoundFile = fileRound ?? {
        roundId, caller: account, voter: await getVoterFromDelegate(account),
        answersSource: 'on-chain', createdAt: new Date().toISOString(),
        votes: reveals.map(r => ({
            identifier: r.identifier, identifierDecoded: decodeIdentifier(r.identifier),
            time: r.time.toString(), ancillaryData: r.ancillaryData,
            question: r.label, answer: priceLabel(r.price), price: r.price.toString(), salt: r.salt.toString(),
        })),
    }
    round.revealTxHash = txHash
    saveRound(round)
    out.log(`\n✅ Revealed ${datas.length} vote(s) in round ${roundId}. Done for this round.`)
    // USB/WalletConnect signer sessions hold the event loop open — the entrypoint exits explicitly
    return 0
}
