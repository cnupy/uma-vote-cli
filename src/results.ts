// Show quorum/consensus/price-distribution results for a voting round.
// Usage: nub run results [--round=N]   (defaults to the current round)
// On a terminal this opens the interactive explorer (round navigation, price
// splits, live reveal-phase refresh); piped/non-TTY runs print the static table.
import { getCurrentRoundId, argValue } from './common'
import { renderRoundResults } from './round-results'

const roundArg = argValue('round')
const roundId = roundArg ? Number(roundArg) : await getCurrentRoundId()

if (process.stdin.isTTY && process.stdout.isTTY) {
    const { runResultsExplorer } = await import('./results-ui')
    await runResultsExplorer(roundId)
    process.exit(0)
}
await renderRoundResults(roundId)
