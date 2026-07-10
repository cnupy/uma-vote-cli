// Print quorum/consensus/price-distribution results for a voting round.
// Usage: nub run results [--round=N]
// Defaults to the round with something to show: the current round during its
// reveal phase (live tally), otherwise the last completed round — during the
// commit phase the current round has no reveals yet. Always the static table;
// the interactive explorer lives in `nub run uma`.
import { getCurrentRoundId, getVotePhase, argValue, handleHelp } from './common'

handleHelp(`Usage: nub run results [options]
Print a round's quorum/consensus/price table. Defaults to the current round
during its reveal phase (live tally), else the last completed round.
  --round N     a specific round
  --help, -h    show this help`)
import { DIM, RESET } from './compare'
import { renderRoundResults } from './round-results'

const roundArg = argValue('round')
const roundId = roundArg ? Number(roundArg) : await (async () => {
    // default to the round with something to show: reveal phase → live
    // tally, commit phase → the last completed round
    const [currentRound, phase] = await Promise.all([getCurrentRoundId(), getVotePhase()])
    return phase === 1 ? currentRound : currentRound - 1
})()

await renderRoundResults(roundId)
if (process.stdout.isTTY) console.log(`${DIM}explore interactively (rounds, price splits, live refresh) with \`nub run uma\`${RESET}`)
