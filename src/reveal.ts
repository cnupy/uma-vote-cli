// Reveal committed votes for the current round. Thin entrypoint: parses the
// flags and runs the extracted pipeline (src/flows/reveal-flow.ts) with
// console output.
import { hasFlag, handleHelp, startPerfDrain } from './common'
import { runRevealFlow } from './flows/reveal-flow'

handleHelp(`Usage: nub run reveal [options]
Reveal the current round's committed votes (reveal phase only).
  --dry-run         print what would be revealed, send nothing
  --force           re-send reveals the chain already has
  --max-fee <gwei>  max fee override (or MAX_FEE_GWEI)
  --tip <gwei>      priority fee override (or PRIORITY_FEE_GWEI)
  --reconnect       discard the stored signer session (WalletConnect/Lattice) and pair afresh
  --help, -h        show this help`)

// Reveal can render a long-lived Ink screen — drain React's leaked
// performance.measure entries so it never trips Node's buffer warning
if (process.stdout.isTTY) void startPerfDrain()

// USB/WalletConnect signer sessions hold the event loop open — exit explicitly
process.exit(await runRevealFlow({ dryRun: hasFlag('--dry-run'), force: hasFlag('--force') }))
