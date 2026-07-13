// Staking & rewards dashboard. Usage: nub run uma
// Interactive-only (full-screen Ink): piped/non-TTY runs are pointed at
// `nub run status` instead. Read-only until an action needs the signer.
import { getAddress } from 'viem'
import { handleHelp } from './common'
import { voterIdentity } from './crypto'

// Single entry point: `nub run uma <subcommand>` dispatches to the other
// commands (their own flags and --help unchanged); bare `nub run uma` opens
// the full-screen app. The direct `nub run <command>` scripts keep working.
const SUBCOMMANDS: Record<string, () => Promise<unknown>> = {
    init: () => import('./init'),
    status: () => import('./status'),
    commit: () => import('./commit'),
    reveal: () => import('./reveal'),
    results: () => import('./results'),
    questions: () => import('./questions'),
    'verify-key': () => import('./verify-key'),
    addon: () => import('./run-addon'),
}
const sub = process.argv[2]
if (sub && !sub.startsWith('-')) {
    // hasOwn: "constructor"/"toString" must not resolve via Object.prototype
    const run = Object.hasOwn(SUBCOMMANDS, sub) ? SUBCOMMANDS[sub] : undefined
    if (!run) {
        console.error(`Unknown subcommand "${sub}". Available: ${Object.keys(SUBCOMMANDS).join(', ')} — or none for the app.`)
        process.exit(1)
    }
    process.argv.splice(2, 1)   // consume the subcommand — positionals/flags shift left
    await run()
    process.exit(0)             // some subcommand modules exit themselves; the rest end here
}

handleHelp(`Usage: nub run uma [<subcommand>] [options]
Bare: the whole flow as one full-screen app — votes (commit review / results),
staking header, stake/unstake/claim, reveal, wallet setup, about.
  --reconnect   discard the stored signer session (WalletConnect/Lattice) and pair afresh
  --help, -h    show this help
Subcommands (each with its own --help): ${Object.keys(SUBCOMMANDS).join(', ')}`)

if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('nub run uma is interactive (needs a terminal) — use `nub run status` for a scriptable overview.')
    process.exit(1)
}

// Identity: EXPECTED_VOTER → first address in .signing-key.json → give up.
// Only an address — the wallet itself is connected lazily at the first send.
function resolveVoter(): `0x${string}` {
    const id = voterIdentity()
    if (id) return getAddress(id)
    console.error('No voter identity: set EXPECTED_VOTER in .env or run `nub run init`.')
    process.exit(1)
}

const voter = resolveVoter()
const { runUmaDashboard } = await import('./uma-ui')
await runUmaDashboard(voter)
// USB/WalletConnect signer sessions hold the event loop open — exit explicitly
process.exit(0)
