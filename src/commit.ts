// Commit votes for the current round. Thin entrypoint: parses the flags and
// runs the extracted pipeline (src/flows/commit-flow.ts) with console output.
import { hasFlag, handleHelp } from './common'
import { runCommitFlow } from './flows/commit-flow'

handleHelp(`Usage: nub run commit [options]
Commit votes for the current round (interactive review on a terminal).
  --dry-run         simulate and print the multicall calldata, send nothing
  --force           skip verification/diff aborts, re-send everything
  --yes             skip the review/confirmation (non-interactive table flow)
  --max-fee <gwei>  max fee override (or MAX_FEE_GWEI)
  --tip <gwei>      priority fee override (or PRIORITY_FEE_GWEI)
  --reconnect       WalletConnect: discard the stored session and pair afresh
  --help, -h        show this help`)

const dryRun = hasFlag('--dry-run')
const force = hasFlag('--force')
// On a terminal the full-screen review (adjust answers, inspect details/docs/
// comments, confirm) replaces the printed table and the y/N prompt. --yes,
// --dry-run and piped runs keep the non-interactive table.
const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !hasFlag('--yes') && !dryRun

// USB/WalletConnect signer sessions hold the event loop open — exit explicitly
process.exit(await runCommitFlow({ dryRun, force, yes: hasFlag('--yes'), interactive }))
