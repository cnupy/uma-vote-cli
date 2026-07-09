// Commit votes for the current round. Thin entrypoint: parses the flags and
// runs the extracted pipeline (src/flows/commit-flow.ts) with console output.
import { hasFlag } from './common'
import { runCommitFlow } from './flows/commit-flow'

const dryRun = hasFlag('--dry-run')
const force = hasFlag('--force')
// On a terminal the full-screen review (adjust answers, inspect details/docs/
// comments, confirm) replaces the printed table and the y/N prompt. --yes,
// --dry-run and piped runs keep the non-interactive table.
const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !hasFlag('--yes') && !dryRun

// USB/WalletConnect signer sessions hold the event loop open — exit explicitly
process.exit(await runCommitFlow({ dryRun, force, yes: hasFlag('--yes'), interactive }))
