import { existsSync } from 'node:fs'
import path from 'node:path'
import { getAddress } from 'viem'
import {
    getVotePhase, getCurrentRoundId, getPendingRequests, getAnswers, loadRound,
    phaseEndsAt, fmtCountdown, handleHelp, detectStuckTx,
} from './common'
import { voterIdentity } from './crypto'
import { ROOT } from './config'

handleHelp(`Usage: nub run status
Current round, phase, your commitments (chain-first) and the suggested action.
No options. --help, -h show this help.`)
import { fetchRoundResults, renderRoundResults } from './round-results'
import { getOnChainCommitments, renderAnswersDiff, GREEN, DIM, RESET } from './compare'

const [phase, roundId, pending] = await Promise.all([getVotePhase(), getCurrentRoundId(), getPendingRequests()])
const active = pending.filter(r => r.lastVotingRound === roundId)
const round = loadRound(roundId)
const answers = active.length > 0 ? await getAnswers(roundId).catch(() => undefined) : undefined

console.log(`Round:    ${roundId}`)
console.log(`Phase:    ${phase === 0 ? 'COMMIT' : 'REVEAL'} — ends ${phaseEndsAt().toISOString()} (${fmtCountdown(phaseEndsAt())} left)`)
console.log(`Requests: ${active.length} votable this round (${pending.length} pending total)`)
console.log(`Answers:  ${answers ? `${answers.answers.length} entries from ${answers.source}` : active.length > 0 ? 'none local — `nub run commit` pulls from installed addons' : 'n/a'}`)
console.log(`Local:    ${round ? `rounds/${roundId}.json — committed: ${round.commitTxHash ?? 'no'}, revealed: ${round.revealTxHash ?? 'no'}` : 'no round file'}`)

// A provably-unminable pending tx blocks every later nonce — surface it here
// too, not only when the next send trips over it
const voter = voterIdentity()
const stuckTx = voter ? await detectStuckTx(getAddress(voter)).catch(() => undefined) : undefined
if (stuckTx) console.log(`\n⚠️  Pending tx nonce ${stuckTx.nonce} is UNMINABLE (max fee ${stuckTx.capGwei} gwei < base ${stuckTx.baseGwei} gwei) — it blocks later txs; commit/reveal will offer a fee-bump replacement.`)

// Reveal-phase verdicts come from the CHAIN, not the local round file — reveal
// is chain-first, so a missing/unreachable round file must not read as "nothing
// to reveal" when on-chain commitments exist. (Fetched once, reused for the table.)
const results = phase === 1 ? await fetchRoundResults(roundId).catch(() => undefined) : undefined
const mine = results?.status === 'ok' ? results.requests : []
const myRevealed = mine.filter(r => r.myPrice !== undefined).length
const myUnrevealed = mine.filter(r => r.myCommitted).length

// Commit phase is chain-first like reveal: a fresh machine has no rounds/
// file, but the chain knows what's committed — status must not suggest a
// fresh commit over an existing one it could have seen (decrypting needs
// .signing-key.json; without it, say so instead of guessing).
let onchain: Awaited<ReturnType<typeof getOnChainCommitments>>
let onchainError: string | undefined
if (phase === 0 && active.length > 0) {
    try {
        onchain = await getOnChainCommitments(roundId)
    } catch (e) { onchainError = (e as Error).message.split('\n')[0] }
}

// A failed chain check must be VISIBLE — otherwise an RPC hiccup reads as
// "not committed" and nudges a fresh commit (commit itself still fails closed
// on the same error before sending anything).
if (onchainError) console.log(`\n⚠️  Couldn't check your on-chain commitments (${onchainError}) — "not committed" may be wrong; commit re-checks before sending.`)

if (active.length > 0) {
    const committed = onchain !== undefined || !!round?.commitTxHash
    const blind = !existsSync(path.join(ROOT, '.signing-key.json')) && !round
    if (phase === 0 && !committed) console.log(`\n→ Action: nub run commit${blind ? `\n  (note: no .signing-key.json and no local round file — a commitment made on another machine can't be detected)` : ''}`)
    else if (phase === 0 && !answers) console.log(`\n${GREEN}→ ${onchain ? `${onchain.commitments.length} vote(s)` : 'Votes'} committed on-chain this round — nothing to do. Re-run nub run commit to review or change them.${RESET}`)
    else if (phase === 0) { /* committed + answers: the diff table below is the verdict */ }
    else if (phase === 1 && myUnrevealed > 0) console.log(`\n→ Action: nub run reveal — ${myUnrevealed} on-chain commitment(s) not revealed yet${myRevealed > 0 ? ` (${myRevealed} already revealed)` : ''}.`)
    else if (phase === 1 && myRevealed > 0) console.log(`\n${GREEN}→ Revealed ${myRevealed} vote(s) this round — nothing to do.${RESET}`)
    else if (phase === 1 && results?.myAddress) console.log(`\n→ No on-chain commitments this round — nothing to reveal.`)
    else if (phase === 1 && round?.commitTxHash && !round.revealTxHash) console.log(`\n→ Action: nub run reveal`)
    else if (phase === 1) console.log(`\n→ Can't check your commitments on-chain (no .signing-key.json) and no local round file — if you committed, run nub run reveal.`)
    else console.log(`\n→ Nothing to do.`)
}

// Commit phase: answers table diffed against your on-chain commitments
// (same diff table answer addons use)
if (phase === 0 && answers) {
    if (onchainError) console.log(`\n⚠️  On-chain commitments unavailable — table below is uncompared.`)
    if (onchain) console.log(`\nCommitted ${onchain.commitments.length} vote(s) with ${onchain.address} — diff vs ${answers.source}:`)
    const { mismatches, unclaimed } = renderAnswersDiff(answers.answers, onchain)
    if (onchain) {
        if (mismatches === 0 && unclaimed.length === 0) console.log(`\n${GREEN}✓ All your committed votes match the answers file.${RESET}`)
        else console.log(`\n⚠️  ${mismatches} difference(s)${unclaimed.length > 0 ? ` + ${unclaimed.length} commitment(s) without a counterpart` : ''} — review + fix with nub run commit.`)
    }
}

// Live tally during the reveal phase (same view as `nub run results`)
if (phase === 1) {
    console.log('')
    await renderRoundResults(roundId, results).catch(e => console.log(`⚠️  Couldn't load round results: ${(e as Error).message.split('\n')[0]}`))
    console.log(`${DIM}run \`nub run results\` to explore${RESET}`)
}
