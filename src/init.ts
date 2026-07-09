// Guided signer setup: pick a connector, configure it, test the connection
// (including device pairing where needed), then persist the choices to .env.
// On a TTY this runs as a full-screen ink wizard (init-ui); piped/non-TTY runs
// keep the original readline flow below.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getAddress } from 'viem'
import { ROOT, EXPECTED_VOTER } from './config'
import { SIGNER_KINDS, type SignerKind, type Wallet, getWallet } from './signers'
import { ask, note } from './signers/prompt'
import { DEFAULT_TREZOR_PATH } from './signers/trezor'
import { DEFAULT_LEDGER_PATH } from './signers/ledger'

const DESCRIPTIONS: Record<SignerKind, string> = {
    frame: 'Frame.sh desktop app — GUI approvals; drives Ledger, Trezor and Lattice',
    trezor: 'Trezor directly over USB/Bridge — close Trezor Suite while voting',
    ledger: 'Ledger directly over USB — Ethereum app open, blind signing enabled',
    lattice: 'GridPlus Lattice1 via relay — GridPlus cloud or a self-hosted relay',
    walletconnect: 'Any WalletConnect wallet (MetaMask/Rabby/mobile) — QR pairing',
}

const NEXT_STEPS = 'Next: `nub run verify-key` — one signature on the device, then checks the derived\nvote-encryption key against your past on-chain blobs (dApp compatibility).'

// Collect connector-specific settings; empty required answers throw.
async function askSettings(kind: SignerKind, note: (text: string) => void): Promise<Record<string, string>> {
    const updates: Record<string, string> = { SIGNER: kind }
    const required = (name: string, value: string): string => {
        if (!value) throw new Error(`${name} is required.`)
        return value
    }
    switch (kind) {
        case 'frame':
            updates.FRAME_URL = await ask('Frame RPC URL', process.env.FRAME_URL ?? 'http://127.0.0.1:1248')
            break
        case 'trezor':
            updates.TREZOR_PATH = await ask('Derivation path', process.env.TREZOR_PATH ?? DEFAULT_TREZOR_PATH)
            note('Close Trezor Suite before continuing — it holds the device session.')
            break
        case 'ledger':
            updates.LEDGER_PATH = await ask('Derivation path', process.env.LEDGER_PATH ?? DEFAULT_LEDGER_PATH)
            note('On the device: open the Ethereum app and enable blind signing (app settings).')
            note('Close Ledger Live before continuing.')
            break
        case 'lattice':
            updates.LATTICE_RELAY_URL = await ask('Relay URL (self-hosted lattice-connect or GridPlus cloud)',
                process.env.LATTICE_RELAY_URL ?? 'https://signing.gridpl.us')
            updates.LATTICE_DEVICE_ID = required('Device ID',
                await ask('Device ID (Lattice → Settings → Device Info)', process.env.LATTICE_DEVICE_ID))
            break
        case 'walletconnect':
            updates.WALLETCONNECT_PROJECT_ID = required('Project ID',
                await ask('WalletConnect project ID (free at https://cloud.reown.com)', process.env.WALLETCONNECT_PROJECT_ID))
            break
    }
    return updates
}

async function askPin(updates: Record<string, string>, address: `0x${string}`, note: (text: string) => void): Promise<void> {
    const pin = await ask(`Pin EXPECTED_VOTER to ${address} (aborts if another account is ever selected)? (Y/n)`, 'y')
    if (/^y(es)?$/i.test(pin)) updates.EXPECTED_VOTER = address
    else if (EXPECTED_VOTER && EXPECTED_VOTER.toLowerCase() !== address.toLowerCase()) {
        note(`⚠️  Existing EXPECTED_VOTER ${EXPECTED_VOTER} doesn't match — vote commands will refuse to run until it's updated or removed.`)
    }
}

// Update .env in place: replace existing assignments, append new ones.
function writeEnv(updates: Record<string, string>): void {
    const envPath = path.join(ROOT, '.env')
    const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : []
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (const [key, value] of Object.entries(updates)) {
        const idx = lines.findIndex(l => new RegExp(`^\\s*${key}\\s*=`).test(l))
        if (idx >= 0) lines[idx] = `${key}=${value}`
        else lines.push(`${key}=${value}`)
    }
    writeFileSync(envPath, lines.join('\n') + '\n')
}

// TUI connection test: fresh connect per attempt — getWallet() memoizes even a
// rejected connect, which would defeat the wizard's retry. Same backend entry
// points as the dispatcher in signers/index.ts.
async function connectSigner(kind: SignerKind, updates: Record<string, string>): Promise<`0x${string}`> {
    Object.assign(process.env, updates)
    const backends: Record<SignerKind, () => Promise<{ connect(): Promise<Wallet> }>> = {
        frame: () => import('./signers/frame'),
        trezor: () => import('./signers/trezor'),
        ledger: () => import('./signers/ledger'),
        lattice: () => import('./signers/lattice'),
        walletconnect: () => import('./signers/walletconnect'),
    }
    return getAddress((await (await backends[kind]()).connect()).account.address)
}

const current = (process.env.SIGNER ?? 'frame').toLowerCase()

if (process.stdin.isTTY && process.stdout.isTTY) {
    const { runInitWizard } = await import('./init-ui')
    const outcome = await runInitWizard({
        current,
        kinds: SIGNER_KINDS,
        descriptions: DESCRIPTIONS,
        nextSteps: NEXT_STEPS,
        askSettings: kind => askSettings(kind, note),
        connect: connectSigner,
        askPin: (updates, address) => askPin(updates, address, note),
        writeEnv,
    })
    process.exit(outcome === 'failed' ? 1 : 0)
}

// Original readline flow — non-TTY (piped) runs.
console.log(`uma-vote-cli signer setup — current signer: ${current}\n`)
for (const [i, kind] of SIGNER_KINDS.entries()) {
    console.log(`  ${i + 1}) ${kind.padEnd(14)} ${DESCRIPTIONS[kind]}`)
}

const choice = await ask(`\nConnector (1-${SIGNER_KINDS.length} or name)`, current)
const kind = (SIGNER_KINDS[Number(choice) - 1] ?? choice.toLowerCase()) as SignerKind
if (!SIGNER_KINDS.includes(kind)) {
    console.error(`Not a connector: "${choice}"`)
    process.exit(1)
}

console.log('')
let updates: Record<string, string>
try {
    updates = await askSettings(kind, text => console.log(text))
} catch (e) {
    console.error((e as Error).message)
    process.exit(1)
}

// Connect through the real backend so the wizard proves the exact same path
// the vote commands will use (this also runs first-time pairing flows).
Object.assign(process.env, updates)
console.log(`\nConnecting via ${kind}...`)
let address: `0x${string}`
try {
    address = getAddress((await getWallet()).account.address)
} catch (e) {
    console.error(`\n❌ ${(e as Error).message}`)
    console.error('Nothing was saved. Fix the issue and re-run `nub run init`.')
    process.exit(1)
}
console.log(`✓ Connected. Account: ${address}`)

await askPin(updates, address, text => console.log(text))

writeEnv(updates)

console.log(`\n✅ Saved to .env:`)
for (const [key, value] of Object.entries(updates)) console.log(`   ${key}=${value}`)
console.log(`\n${NEXT_STEPS}`)
process.exit(0)
