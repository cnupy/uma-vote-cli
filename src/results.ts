// Show quorum/consensus/price-distribution results for a voting round.
// Usage: nub run results [--round=N]   (defaults to the current round)
import { getCurrentRoundId, argValue } from './common'
import { renderRoundResults } from './round-results'

const roundArg = argValue('round')
const roundId = roundArg ? Number(roundArg) : await getCurrentRoundId()
await renderRoundResults(roundId)
