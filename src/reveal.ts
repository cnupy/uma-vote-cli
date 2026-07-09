// Reveal committed votes for the current round. Thin entrypoint: parses the
// flags and runs the extracted pipeline (src/flows/reveal-flow.ts) with
// console output.
import { hasFlag } from './common'
import { runRevealFlow } from './flows/reveal-flow'

// USB/WalletConnect signer sessions hold the event loop open — exit explicitly
process.exit(await runRevealFlow({ dryRun: hasFlag('--dry-run'), force: hasFlag('--force') }))
