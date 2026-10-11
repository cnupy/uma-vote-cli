// On-chain resolution history, cached: which request (time + ancillaryData)
// VotingV2 resolved to which price, in which round. Pure chain facts with no
// scoring in them, shared by anything that measures answers against outcomes
// (addons' audits do; each keeps its own idea of right and wrong).
//
// A resolution never changes once final, so the blocks already read are kept
// in .cache/resolutions.json and only new ones are scanned. The newest blocks
// can still be reorganised, so the cache stops FINALITY blocks short of the
// head and reads those again next time; 64 blocks is two epochs, which is when
// Ethereum treats a block as finalised. Asking for an earlier round than the
// cache holds scans backwards once and keeps that too.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseAbiItem } from 'viem'
import { ROOT } from './config'
import { publicClient, votingContract, ROUND_SECONDS } from './common'

export type Resolution = { roundId: number; price: bigint; identifier: `0x${string}` }

// The join key: a request is its time plus its ancillaryData
export const resolutionKey = (time: bigint | number | string, ancillaryData: string) => `${time}-${ancillaryData}`.toLowerCase()

const requestResolved = parseAbiItem(
    'event RequestResolved(uint32 indexed roundId, uint256 indexed resolvedPriceRequestIndex, bytes32 indexed identifier, uint256 time, bytes ancillaryData, int256 price)'
)
const FINALITY = 64n
const CHUNK = 9_000n
const MIN_BLOCK = 15_537_394n   // the merge; nothing of VotingV2's predates it
const DEFAULT_CACHE = path.join(ROOT, '.cache', 'resolutions.json')

// First block at or after a timestamp, by stepping back at 12 s per block
async function blockAt(ts: bigint): Promise<bigint> {
    let block = await publicClient.getBlock()
    if (ts >= block.timestamp) return block.number
    for (let i = 0; i < 20; i++) {
        const delta = (block.timestamp - ts) / 12n
        if (delta === 0n) break
        let next = block.number - delta
        if (next < MIN_BLOCK) next = MIN_BLOCK
        if (next === block.number) break
        block = await publicClient.getBlock({ blockNumber: next })
    }
    return block.number
}

type Cache = { fromBlock: string; toBlock: string; resolved: Record<string, { roundId: number; price: string; identifier: `0x${string}` }> }

// Every resolution from the start of `fromRound` to the chain head. `readFrom`
// and `readTo` say which blocks this call read (the rest came from the cache).
export async function loadResolutions(fromRound: number, opts: { cacheFile?: string; onProgress?: (line: string) => void } = {}) {
    const cacheFile = opts.cacheFile ?? DEFAULT_CACHE
    const progress = opts.onProgress ?? (() => {})
    const cache: Cache | undefined = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : undefined

    const resolved = new Map<string, Resolution>()
    for (const [k, v] of Object.entries(cache?.resolved ?? {})) resolved.set(k, { roundId: v.roundId, price: BigInt(v.price), identifier: v.identifier })

    let scanned = 0
    const scan = async (from: bigint, to: bigint) => {
        for (let a = from; a <= to; a += CHUNK) {
            const b = a + CHUNK - 1n > to ? to : a + CHUNK - 1n
            const read = () => publicClient.getLogs({ address: votingContract.address, event: requestResolved, fromBlock: a, toBlock: b })
            let logs
            try { logs = await read() }
            catch { await new Promise(r => setTimeout(r, 3000)); logs = await read() }   // one retry: public RPCs hiccup
            for (const log of logs) {
                const e = log.args as { roundId: number; time: bigint; ancillaryData: `0x${string}`; price: bigint; identifier: `0x${string}` }
                resolved.set(resolutionKey(e.time, e.ancillaryData), { roundId: Number(e.roundId), price: e.price, identifier: e.identifier })
            }
            if (++scanned % 40 === 0) progress(`  ...block ${b} (${resolved.size} resolutions so far)`)
        }
    }

    const wanted = await blockAt(BigInt(fromRound * ROUND_SECONDS))
    const latest = (await publicClient.getBlock()).number
    const cachedFrom = cache ? BigInt(cache.fromBlock) : undefined
    const cachedTo = cache ? BigInt(cache.toBlock) : undefined
    // Read only what the cache does not hold: anything before it and anything after it
    if (cachedFrom === undefined || cachedTo === undefined) await scan(wanted, latest)
    else {
        if (wanted < cachedFrom) await scan(wanted, cachedFrom - 1n)
        await scan(cachedTo + 1n, latest)
    }
    const newFrom = cachedFrom !== undefined && cachedFrom < wanted ? cachedFrom : wanted
    mkdirSync(path.dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify({
        fromBlock: newFrom.toString(),
        toBlock: (latest - FINALITY).toString(),
        resolved: Object.fromEntries([...resolved].map(([k, v]) => [k, { roundId: v.roundId, price: v.price.toString(), identifier: v.identifier }])),
    } satisfies Cache, null, 2))
    return { resolved, readFrom: cachedTo !== undefined ? cachedTo + 1n : wanted, readTo: latest }
}
