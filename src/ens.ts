// ENS reverse resolution with a persistent cache: show "vitalik.eth" instead
// of a raw address wherever a friendly identity helps. Resolution failures
// degrade to the cached (possibly stale) name or the address — never throw.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './config'
import { publicClient, sanitizeText } from './common'

const FILE = path.join(ROOT, '.cache', 'ens.json')
const TTL_MS = 7 * 86_400_000 // names rarely move; a week keeps lookups off the hot path

type Entry = { name: string | null; at: number } // null = reverse record absent (cached too)
let mem: Record<string, Entry> | undefined
const cache = (): Record<string, Entry> => {
    if (!mem) {
        try { mem = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {} } catch { mem = {} }
    }
    return mem!
}

export async function ensName(address: `0x${string}`): Promise<string | undefined> {
    const key = address.toLowerCase()
    const hit = cache()[key]
    if (hit && Date.now() - hit.at < TTL_MS) return hit.name ?? undefined
    try {
        // viem checks the forward record matches, so spoofed reverse records don't show
        const resolved = await publicClient.getEnsName({ address })
        const name = resolved ? sanitizeText(resolved) : resolved
        cache()[key] = { name: name ?? null, at: Date.now() }
        try {
            mkdirSync(path.dirname(FILE), { recursive: true })
            writeFileSync(FILE, JSON.stringify(cache(), null, 2))
        } catch { /* cache write is best-effort */ }
        return name ?? undefined
    } catch { return hit?.name ?? undefined }
}

export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`

// "vitalik.eth" when a verified reverse record exists, else "0xd8dA…6045"
export async function friendlyAddress(address: `0x${string}`): Promise<string> {
    return await ensName(address) ?? shortAddress(address)
}
