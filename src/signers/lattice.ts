import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createWalletClient, fallback, getAddress, hashMessage, http, keccak256, padHex, recoverAddress, serializeTransaction, type TransactionSerializable } from 'viem'
import { toAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { ROOT, RPC_URLS } from '../config'
import { ask, note } from './prompt'
import type { Wallet } from './types'

// Pairing state (deterministic client key + session) — keep private; whoever
// holds it can request signatures, though every one still needs on-device approval.
const STORE = path.join(ROOT, '.lattice-client.json')

type Store = { deviceId: string; password: string; name?: string; clientData?: string }

// GridPlus Lattice1 via a relay — GridPlus cloud by default, or a self-hosted
// lattice-connect relay (LATTICE_RELAY_URL). Signs with the standard ETH path
// m/44'/60'/0'/0/0 (the SDK's fixed signing path).
export async function connect(): Promise<Wallet> {
    const gp = await import('gridplus-sdk')

    const stored: Store | undefined = existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : undefined
    const deviceId = process.env.LATTICE_DEVICE_ID ?? stored?.deviceId
    if (!deviceId) throw new Error('LATTICE_DEVICE_ID not set — run `nub run init` (the ID is under Lattice Settings → Device Info).')
    const baseUrl = process.env.LATTICE_RELAY_URL ?? 'https://signing.gridpl.us'

    // deviceId + password + name deterministically derive the pairing key, so
    // the same store re-pairs silently after the first approval on the device.
    // New stores get a random per-folder instance suffix in the name: the
    // device/relay allows one session per app name, so two checkouts pairing
    // as the same name lock each other out ("already connected"). Legacy
    // stores without a name keep 'uma-voter' to preserve their pairing.
    const store: Store = (stored?.deviceId === deviceId ? stored : undefined)
        ?? { deviceId, password: randomBytes(24).toString('hex'), name: `uma-voter-${10 + Math.floor(Math.random() * 90)}` }
    const save = () => writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 }) // owner-only on POSIX (no-op on Windows)
    save()

    // gridplus-sdk fetches the contract ABI from Etherscan's retired V1 API
    // to decode calldata on-device; that fetch fails with a noisy stack trace
    // and falls back to 4byte.directory, which works. Benign — drop exactly
    // that noise during signing, pass every other console line through.
    const SDK_NOISE = /deprecated V1 endpoint|Invalid JSON in response|Fetching data from external network failed|Falling back to 4byte|Failed to fetch ABI/i
    const quietSdkNoise = async <T>(fn: () => Promise<T>): Promise<T> => {
        const orig = { log: console.log, warn: console.warn, error: console.error }
        const filter = (write: (...args: unknown[]) => void) => (...args: unknown[]) => {
            if (args.some(a => SDK_NOISE.test(a instanceof Error ? a.message : String(a)))) return
            write(...args)
        }
        console.log = filter(orig.log)
        console.warn = filter(orig.warn)
        console.error = filter(orig.error)
        try { return await fn() } finally { Object.assign(console, orig) }
    }

    // A locked Lattice can't be unlocked remotely (PIN is on-device only) —
    // wait for the user instead of failing, incl. mid-run auto-lock timeouts.
    const withUnlockRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
        for (;;) {
            try {
                return await fn()
            } catch (e) {
                if (!/device locked/i.test((e as Error)?.message ?? String(e))) throw e
                await ask('Lattice is locked — enter the PIN on the device, then press Enter to retry')
            }
        }
    }

    const isPaired = await withUnlockRetry(() => gp.setup({
        deviceId, password: store.password, name: store.name ?? 'uma-voter', baseUrl, // legacy stores predate per-instance names
        getStoredClient: async () => store.clientData ?? '',
        setStoredClient: async (clientData: string | null) => { store.clientData = clientData ?? undefined; save() },
    }))
    if (!isPaired) {
        // note() so an ink app (init wizard) renders this instead of a mid-frame print
        note('Not paired yet — the Lattice should now show a pairing code.')
        const code = await ask('Pairing code from the Lattice screen')
        if (!(await gp.pair(code.toUpperCase()))) throw new Error('Lattice pairing failed — wrong or expired code.')
    }
    // wait for physical confirmation on the device instead of timing out
    ;(await gp.getClient()).timeout = 300_000

    const [addr] = await withUnlockRetry(() => gp.fetchAddresses({ n: 1 }))
    if (!addr) throw new Error('Lattice returned no address — is a wallet active on the device?')
    const address = getAddress(addr)

    const sigHex = (x: unknown): `0x${string}` => padHex(
        typeof x === 'string' ? (x.startsWith('0x') ? x as `0x${string}` : `0x${x}`)
            : `0x${Buffer.from(x as Uint8Array).toString('hex')}`,
        { size: 32 })
    // Lattice general signing returns only r/s — recover the parity bit against the signer
    const findYParity = async (hash: `0x${string}`, r: `0x${string}`, s: `0x${string}`): Promise<0 | 1> => {
        for (const yParity of [0, 1] as const) {
            const recovered = await recoverAddress({ hash, signature: { r, s, yParity } })
            if (recovered.toLowerCase() === address.toLowerCase()) return yParity
        }
        throw new Error('Lattice signature does not recover to the expected address')
    }

    const account = toAccount({
        address,
        async signMessage({ message }) {
            if (typeof message !== 'string') throw new Error('raw message signing not supported by the lattice backend')
            const res = await withUnlockRetry(() => gp.signMessage(message))
            if (!res.sig) throw new Error(`Lattice signMessage failed${res.err ? `: ${res.err}` : ''}`)
            const r = sigHex(res.sig.r), s = sigHex(res.sig.s)
            const yParity = await findYParity(hashMessage(message), r, s)
            return `0x${r.slice(2)}${s.slice(2)}${(27 + yParity).toString(16)}` as `0x${string}`
        },
        async signTransaction(tx) {
            const res = await withUnlockRetry(() => quietSdkNoise(() => gp.sign(tx as TransactionSerializable)))
            if (!res.sig) throw new Error(`Lattice signTransaction failed${res.err ? `: ${res.err}` : ''}`)
            const r = sigHex(res.sig.r), s = sigHex(res.sig.s)
            const yParity = await findYParity(keccak256(serializeTransaction(tx)), r, s)
            return serializeTransaction(tx, { r, s, yParity })
        },
        async signTypedData() { throw new Error('typed-data signing not needed by this tool') },
    })
    const client = createWalletClient({ chain: mainnet, transport: fallback(RPC_URLS.map(u => http(u))) })
    return { kind: 'lattice', client, account }
}
