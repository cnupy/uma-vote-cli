// Full question text for cross-chain price requests, via the voter dApp's
// public resolver: mainnet carries only `ancillaryDataHash:…, childBlockNumber:…`
// for requests bridged from other chains (Polymarket on Polygon, Base, …); the
// dApp's endpoint reads the origin chain server-side, so no per-chain RPCs are
// needed here. Resolutions are immutable → persisted in .cache/ancillary/.
// Also: the dApp's per-outcome AI summary of each vote's Discord discussion.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { ROOT, DAPP_URL } from './config'
import { sanitizeText } from './common'
import { dappTitle } from './discord'

const utf8 = (hex: `0x${string}`) => Buffer.from(hex.slice(2), 'hex').toString('utf8')
const cachePath = (identifier: string, time: bigint, ancillaryData: string) =>
    path.join(ROOT, '.cache', 'ancillary',
        `${createHash('sha256').update(`${identifier}-${time}-${ancillaryData}`.toLowerCase()).digest('hex').slice(0, 24)}.txt`)

// Decoded question text: the L1 data itself when it already carries text,
// otherwise the origin-chain data via the dApp resolver. undefined = can't be
// resolved (old bridge format without childBlockNumber — the dApp can't either).
export async function resolveAncillaryText(
    identifier: `0x${string}`, time: bigint, ancillaryData: `0x${string}`,
): Promise<string | undefined> {
    const raw = utf8(ancillaryData)
    if (!raw.includes('ancillaryDataHash:')) return sanitizeText(raw)
    const file = cachePath(identifier, time, ancillaryData)
    if (existsSync(file)) return sanitizeText(readFileSync(file, 'utf8'))
    const params = new URLSearchParams({ identifier, time: time.toString(), ancillaryData })
    try {
        const res = await fetch(`${DAPP_URL}/api/resolve-l2-ancillary-data?${params}`)
        if (!res.ok) return undefined
        const { resolvedAncillaryData } = await res.json() as { resolvedAncillaryData?: `0x${string}` }
        // The endpoint echoes the input back when it can't resolve
        if (!resolvedAncillaryData || resolvedAncillaryData.toLowerCase() === ancillaryData.toLowerCase()) return undefined
        const text = sanitizeText(utf8(resolvedAncillaryData))
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, text)
        return text
    } catch { return undefined }
}

// titleFromText lives in common.ts (single home of the title regexes)

export const descriptionFromText = (text: string): string | undefined => {
    const d = /description:\s*(.*)$/s.exec(text)?.[1]?.trim()
    if (!d) return undefined
    // Protocol metadata APPENDED after the description is noise, not rules —
    // strip only a trailing chain of key:hex pairs, anchored to the end.
    // Splitting at the first match instead would let a description that
    // embeds ",initializer:" early truncate the rules the voter sees.
    return sanitizeText(d.replace(/(?:,(?:initializer|ooRequester|childRequester|childOracle|childBlockNumber|childChainId):[0-9a-fA-Fx]*)+$/, '').trim())
}

// The dApp's AI summary of the Discord discussion, grouped by outcome (P1-P4).
// Live data (discussion evolves) → not disk-cached. undefined = unavailable.
export type OutcomeSummary = { outcome: string; summary: string; sources: Array<[string, number]> }
export async function fetchAiSummary(
    time: bigint, identifierDecoded: string, title: string,
): Promise<OutcomeSummary[] | undefined> {
    const params = new URLSearchParams({ time: time.toString(), identifier: identifierDecoded, title: dappTitle(title) })
    try {
        const res = await fetch(`${DAPP_URL}/api/fetch-summary?${params}`)
        if (!res.ok) return undefined
        const j = await res.json() as { summary?: Record<string, { summary?: string; sources?: [string, number][] }> }
        if (!j.summary) return undefined
        // External text — sanitized here like every other ingestion point
        return Object.entries(j.summary)
            .map(([outcome, v]) => ({
                outcome: sanitizeText(outcome),
                summary: sanitizeText(v.summary ?? ''),
                sources: (v.sources ?? []).map(([url, n]): [string, number] => [sanitizeText(url), n]),
            }))
            .filter(o => o.summary)
    } catch { return undefined }
}

// Small concurrency limiter for firing many resolutions without a stampede
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items]
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
    }))
}
