import {
    getVotePhase, getCurrentRoundId, getPendingRequests, getAnswers, loadRound,
    phaseEndsAt, fmtCountdown,
} from './common'
import { fetchRoundResults, renderRoundResults } from './round-results'
import { getOnChainCommitments, renderAnswersDiff, GREEN, DIM, RESET } from './compare'

const [phase, roundId, pending] = await Promise.all([getVotePhase(), getCurrentRoundId(), getPendingRequests()])
const active = pending.filter(r => r.lastVotingRound === roundId)
const round = loadRound(roundId)
const answers = active.length > 0 ? await getAnswers(roundId).catch(() => undefined) : undefined

console.log(`Round:    ${roundId}`)
console.log(`Phase:    ${phase === 0 ? 'COMMIT' : 'REVEAL'} — ends ${phaseEndsAt().toISOString()} (${fmtCountdown(phaseEndsAt())} left)`)
console.log(`Requests: ${active.length} votable this round (${pending.length} pending total)`)
console.log(`Answers:  ${answers ? `${answers.answers.length} entries from ${answers.source}` : active.length > 0 ? 'not published yet' : 'n/a'}`)
console.log(`Local:    ${round ? `rounds/${roundId}.json — committed: ${round.commitTxHash ?? 'no'}, revealed: ${round.revealTxHash ?? 'no'}` : 'no round file'}`)

// Reveal-phase verdicts come from the CHAIN, not the local round file — reveal
// is chain-first, so a missing/unreachable round file must not read as "nothing
// to reveal" when on-chain commitments exist. (Fetched once, reused for the table.)
const results = phase === 1 ? await fetchRoundResults(roundId).catch(() => undefined) : undefined
const mine = results?.status === 'ok' ? results.requests : []
const myRevealed = mine.filter(r => r.myPrice !== undefined).length
const myUnrevealed = mine.filter(r => r.myCommitted).length

if (active.length > 0) {
    if (phase === 0 && !round?.commitTxHash) console.log(`\n→ Action: nub run commit ${answers ? '' : '(once answers are published)'}`)
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
    let onchain: Awaited<ReturnType<typeof getOnChainCommitments>>
    try {
        onchain = await getOnChainCommitments(roundId)
    } catch (e) {
        console.log(`\n⚠️  Couldn't fetch your on-chain commitments (${(e as Error).message.split('\n')[0]}) — table below is uncompared.`)
        onchain = undefined
    }
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
