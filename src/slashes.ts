// Per-vote UMA earned/lost through slashing, from UMA's official voting-v2
// subgraph — the same source vote.uma.xyz's history table uses. Entries are
// keyed by the subgraph's request id, verified live as
// "<DECODED_IDENTIFIER>-<time>-<keccak256(ancillaryData)>" (lowercased here);
// matching falls back to the raw ancillary hex in case older entries stored it.
// A slashAmount of exactly 0 while staking means the voter's on-chain slashing
// trackers haven't processed that request yet — PENDING, not "earned 0".
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { hexToString, keccak256 } from 'viem'
import { ROOT, SUBGRAPH_URL } from './config'

const PAGE = 1000

export type VoteSlash = {
    slashAmount: string     // signed decimal string in UMA units (subgraph precision kept)
    voted: boolean
    correctness: boolean
    staking: boolean
    pending: boolean        // trackers haven't settled this request yet — never render as 0
}

export type VoteSlashes = Map<string, VoteSlash>

// Candidate subgraph ids for one of our requests: identifier decoded (NULs
// stripped, no Admin collapsing), then keccak256 of the ancillary (the live
// format) with the raw hex as fallback. Matching is on the lowercased whole.
const slashIdsFor = (identifier: `0x${string}`, time: bigint, ancillaryData: `0x${string}`): string[] => {
    const decoded = hexToString(identifier).replace(/\0/g, '')
    return [
        `${decoded}-${time}-${keccak256(ancillaryData)}`.toLowerCase(),
        `${decoded}-${time}-${ancillaryData}`.toLowerCase(),
    ]
}

export function slashFor(
    slashes: VoteSlashes, identifier: `0x${string}`, time: bigint, ancillaryData: `0x${string}`,
): VoteSlash | undefined {
    for (const id of slashIdsFor(identifier, time, ancillaryData)) {
        const s = slashes.get(id)
        if (s) return s
    }
    return undefined
}

// "+0.049" / "-1.204" — fits the ~10-char slash columns
export const fmtSlash = (amount: string): string => {
    const n = Number(amount)
    const s = Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(3)
    return n > 0 ? `+${s}` : s
}

// Net settled amount + pending/matched counts for one round's requests.
// Only requests that RESOLVED in the viewed round count: a rolled request
// keeps its id into the next round, so its (voter, request)-keyed slash entry
// would otherwise leak the later round's settlement into the rolled view.
export function roundSlashStats(
    slashes: VoteSlashes,
    requests: Array<{ identifier: `0x${string}`; time: bigint; ancillaryData: `0x${string}`; quorumOk: boolean; consensusOk: boolean }>,
): { net: number; pending: number; matched: number } {
    let net = 0, pending = 0, matched = 0
    for (const r of requests) {
        if (!r.quorumOk || !r.consensusOk) continue // rolled — settles in a later round
        const s = slashFor(slashes, r.identifier, r.time, r.ancillaryData)
        if (!s) continue
        matched++
        if (s.pending) pending++
        else net += Number(s.slashAmount)
    }
    return { net, pending, matched }
}

// ---------- disk cache ----------
// Settled entries never change, so the full map persists in .cache/slashes/.
// A cache that contained ANY pending entry is always refetched (pending must
// resolve to a real amount eventually); a fully-settled cache is reused for
// TTL_MS since new entries only appear as later rounds settle. Skip-based
// pagination is ordered by id (not time), so incremental fetches aren't safe —
// a refetch is always the full sweep (a handful of 1000-row pages).
const CACHE_VERSION = 1
const TTL_MS = 6 * 3600_000
const cachePath = (voter: string) => path.join(ROOT, '.cache', 'slashes', `${voter}.json`)
type CacheFile = { version: number; fetchedAt: number; hadPending: boolean; entries: Array<[string, VoteSlash]> }

const readCache = (voter: string): CacheFile | undefined => {
    try {
        const c = JSON.parse(readFileSync(cachePath(voter), 'utf8')) as CacheFile
        return c.version === CACHE_VERSION ? c : undefined
    } catch { return undefined }
}

type RawSlash = { request: { id: string }; voted: boolean; correctness: boolean; slashAmount: string; staking: boolean }

async function fetchAllPages(voter: string): Promise<RawSlash[]> {
    const all: RawSlash[] = []
    for (let skip = 0; ; skip += PAGE) {
        const query = `{users(where:{address:"${voter}"}){votesSlashed(first:${PAGE},skip:${skip},orderBy:id){request{id} voted correctness slashAmount staking}}}`
        const res = await fetch(SUBGRAPH_URL, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
        })
        if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`)
        const j = await res.json() as { data?: { users?: Array<{ votesSlashed: RawSlash[] }> }; errors?: unknown[] }
        if (j.errors?.length || !j.data) throw new Error('subgraph query error')
        const page = j.data.users?.[0]?.votesSlashed ?? []
        all.push(...page)
        if (page.length < PAGE) return all
    }
}

// All slash entries for a voter, keyed by lowercase request id. undefined =
// subgraph unreachable AND nothing cached (callers skip slash rendering).
export async function fetchVoteSlashes(voter: string): Promise<VoteSlashes | undefined> {
    const v = voter.toLowerCase()
    const cached = readCache(v)
    if (cached && !cached.hadPending && Date.now() - cached.fetchedAt < TTL_MS) return new Map(cached.entries)
    try {
        const raw = await fetchAllPages(v)
        const map: VoteSlashes = new Map()
        for (const r of raw) {
            const pending = r.staking && Number(r.slashAmount) === 0
            map.set(r.request.id.toLowerCase(), {
                slashAmount: r.slashAmount, voted: r.voted, correctness: r.correctness, staking: r.staking, pending,
            })
        }
        try {
            mkdirSync(path.dirname(cachePath(v)), { recursive: true })
            const file: CacheFile = {
                version: CACHE_VERSION, fetchedAt: Date.now(),
                hadPending: [...map.values()].some(s => s.pending), entries: [...map.entries()],
            }
            writeFileSync(cachePath(v), JSON.stringify(file))
        } catch { /* cache write is best-effort */ }
        return map
    } catch {
        // Stale cache beats nothing (pending entries stay marked pending)
        return cached ? new Map(cached.entries) : undefined
    }
}
