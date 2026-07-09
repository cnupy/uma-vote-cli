// Staking & rewards dashboard. Usage: nub run uma
// Interactive-only (full-screen Ink): piped/non-TTY runs are pointed at
// `nub run status` instead. Read-only until an action needs the signer.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { getAddress } from 'viem'
import { ROOT, EXPECTED_VOTER } from './config'

if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('nub run uma is interactive (needs a terminal) — use `nub run status` for a scriptable overview.')
    process.exit(1)
}

// Identity: EXPECTED_VOTER → first address in .signing-key.json → give up.
// Only an address — the wallet itself is connected lazily at the first send.
function resolveVoter(): `0x${string}` {
    if (EXPECTED_VOTER) return getAddress(EXPECTED_VOTER.toLowerCase())
    const keyCachePath = path.join(ROOT, '.signing-key.json')
    if (existsSync(keyCachePath)) {
        const cache = JSON.parse(readFileSync(keyCachePath, 'utf8')) as Record<string, { address: `0x${string}` }>
        const first = Object.values(cache)[0]
        if (first) return getAddress(first.address)
    }
    console.error('No voter identity: set EXPECTED_VOTER in .env or run `nub run init`.')
    process.exit(1)
}

const voter = resolveVoter()
const { runUmaDashboard } = await import('./uma-ui')
await runUmaDashboard(voter)
// USB/WalletConnect signer sessions hold the event loop open — exit explicitly
process.exit(0)
