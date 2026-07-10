// Live/past round results: per-request quorum, consensus, and price
// distribution aggregated from VoteRevealed events, with your own vote marked
// green (matches current majority), red (differs), or gray (committed but not
// revealed / not committed). fetchRoundResults returns the structured data;
// renderRoundResults prints the static table on top of it. Used by
// `nub run results` (static + interactive explorer) and by status during
// the reveal phase.
import { parseAbiItem } from 'viem'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './config'
import { publicClient, votingContract, decodeIdentifier, getAnswers, titleFromAncillary, titleFromText, derivedRoundId, ROUND_SECONDS as ROUND_SECONDS_N, PHASE_SECONDS as PHASE_SECONDS_N, P1_VALUE, P2_VALUE, P3_VALUE, P4_VALUE, type Answer } from './common'
import { getOnChainCommitments, priceLabel, GREEN, RED, DIM, RESET } from './compare'
import { voterIdentity } from './crypto'
import { fetchVoteSlashes, slashFor, roundSlashStats, fmtSlash, type VoteSlashes, type VoteSlash } from './slashes'

// ~10-char slash column cell: signed amount (green/red), dim "pending" for
// entries the voter's slashing trackers haven't settled (NEVER shown as 0),
// blank when the voter had nothing at stake
const renderSlashCell = (s: VoteSlash | undefined): string =>
    !s ? ` ${' '.repeat(10)}`
        : s.pending ? ` ${DIM}${'pending'.padStart(10)}${RESET}`
        : ` ${Number(s.slashAmount) < 0 ? RED : GREEN}${fmtSlash(s.slashAmount).padStart(10)}${RESET}`

export const voteRevealedEvent = parseAbiItem(
    'event VoteRevealed(address indexed voter, address indexed caller, uint32 roundId, bytes32 indexed identifier, uint256 time, bytes ancillaryData, int256 price, uint128 numTokens)'
)

const ROUND_SECONDS = BigInt(ROUND_SECONDS_N)
const PHASE_SECONDS = BigInt(PHASE_SECONDS_N)

// Find the last block at or below `ts` by Newton iteration on the ~12s slot
// time (converges in a few probes). Clamped to post-merge blocks: nodes with
// EIP-4444 history expiry (e.g. Geth ≥1.17) prune pre-merge blocks, and all
// VotingV2 activity is post-merge anyway.
const MIN_BLOCK = 15_537_394n // the merge
async function findBlockByTimestamp(ts: bigint): Promise<bigint> {
    let block = await publicClient.getBlock()
    if (ts >= block.timestamp) return block.number
    for (let i = 0; i < 20 && block.timestamp !== ts; i++) {
        const delta = (block.timestamp - ts) / 12n
        if (delta === 0n) break
        let next = block.number - delta
        if (next < MIN_BLOCK) next = MIN_BLOCK
        if (next === block.number) break
        block = await publicClient.getBlock({ blockNumber: next })
    }
    // Land exactly on the boundary: last block with timestamp <= ts
    while (block.timestamp > ts && block.number > MIN_BLOCK) {
        block = await publicClient.getBlock({ blockNumber: block.number - 1n })
    }
    while (true) {
        const next = await publicClient.getBlock({ blockNumber: block.number + 1n })
        if (next.timestamp > ts) break
        block = next
    }
    return block.number
}

export const fmtTokens = (wei: bigint) => {
    const t = Number(wei) / 1e18
    return t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : t >= 1e3 ? `${(t / 1e3).toFixed(0)}k` : t.toFixed(0)
}
export const pct = (num: bigint, den: bigint) => den === 0n ? '—' : `${(Number(num * 10_000n / den) / 100).toFixed(1)}%`
// Progress toward a threshold, capped at 100% once met
export const pctOfThreshold = (num: bigint, den: bigint) => den === 0n ? '—' : num >= den ? '100%' : `${(Number(num * 10_000n / den) / 100).toFixed(1)}%`

type RequestTally = {
    identifier: `0x${string}`
    time: bigint
    ancillaryData: `0x${string}`
    byPrice: Map<string, bigint> // price (decimal string) → tokens
    total: bigint
    myPrice?: bigint
}

export type PriceSlice = { price: bigint; tokens: bigint }

export type RequestResult = {
    identifier: `0x${string}`
    time: bigint
    ancillaryData: `0x${string}`
    question: string
    needsTitle?: boolean        // placeholder question — UIs resolve the real title lazily
    prices: PriceSlice[]        // every distinct revealed price, sorted by tokens desc
    total: bigint
    leadingPrice: bigint
    leadingTokens: bigint
    quorumOk: boolean
    consensusOk: boolean
    myPrice?: bigint
    myCommitted: boolean        // committed but not (yet) revealed
}

export type RoundResults = {
    roundId: number
    // no-votes = round was never frozen · not-started = reveal phase not reached
    // yet · no-reveals = reveal phase open but nothing revealed so far
    status: 'ok' | 'no-votes' | 'not-started' | 'no-reveals'
    minParticipation: bigint
    minAgreement: bigint
    cumulativeStake: bigint
    requests: RequestResult[]
    // Address my-vote markers are matched against (EXPECTED_VOTER, else the
    // cached signing key); undefined = no identity at all, so votes CANNOT be
    // marked (callers must surface this, not show "none")
    myAddress?: string
    fetchedAt: number
}

// ---------- disk cache ----------
// Past rounds are final, so their results persist in .cache/results/ across
// runs (getLogs sweeps take seconds). Entries invalidate when the signing key
// changes (my-vote markers are baked into the data) or the schema bumps.
const CACHE_VERSION = 2
const cachePath = (roundId: number) => path.join(ROOT, '.cache', 'results', `${roundId}.json`)
const jsonReplacer = (_k: string, v: unknown) => typeof v === 'bigint' ? { $bigint: v.toString() } : v
const jsonReviver = (_k: string, v: unknown) =>
    v && typeof v === 'object' && '$bigint' in (v as object) ? BigInt((v as { $bigint: string }).$bigint) : v
// A round is final once its 48h window has fully elapsed
export const isFinal = (roundId: number) => roundId < derivedRoundId()

// onProgress receives short human-readable stage lines ("scanning reveal
// logs — chunk 3/8") so a UI can show liveness during the multi-second sweep
export async function fetchRoundResults(roundId: number, fresh = false, onProgress?: (stage: string) => void): Promise<RoundResults> {
    if (!fresh && isFinal(roundId) && existsSync(cachePath(roundId))) {
        try {
            const c = JSON.parse(readFileSync(cachePath(roundId), 'utf8'), jsonReviver) as { version: number; data: RoundResults }
            if (c.version === CACHE_VERSION && c.data.myAddress === currentMyAddress()) return c.data
        } catch { /* unreadable cache entry — refetch below overwrites it */ }
    }
    const data = await fetchRoundResultsUncached(roundId, onProgress)
    if (isFinal(roundId)) {
        try {
            mkdirSync(path.dirname(cachePath(roundId)), { recursive: true })
            writeFileSync(cachePath(roundId), JSON.stringify({ version: CACHE_VERSION, data }, jsonReplacer))
        } catch { /* cache write is best-effort */ }
    }
    return data
}

// Reveal logs are public, so marking "my" votes needs only an ADDRESS —
// EXPECTED_VOTER works without any signing key (the key is only needed to
// decrypt unrevealed commitments for the "cmtd" marker).
const currentMyAddress = (): string | undefined => voterIdentity()

async function fetchRoundResultsUncached(roundId: number, onProgress?: (stage: string) => void): Promise<RoundResults> {
    onProgress?.('reading round parameters')
    const round = await publicClient.readContract({
        ...votingContract, functionName: 'rounds', args: [BigInt(roundId)],
    }) as readonly [string, bigint, bigint, bigint, number]
    const [, minParticipation, minAgreement, cumulativeStake] = round

    // My address (for marking my votes) — cached signing key, no wallet needed
    const myAddress = currentMyAddress()
    const base = { roundId, minParticipation, minAgreement, cumulativeStake, requests: [] as RequestResult[], myAddress }
    if (minParticipation === 0n) return { ...base, status: 'no-votes', fetchedAt: Date.now() }

    // Reveals happen only in the round's reveal phase — scan exactly that block range
    const revealStartTs = BigInt(roundId) * ROUND_SECONDS + PHASE_SECONDS
    const roundEndTs = BigInt(roundId + 1) * ROUND_SECONDS
    const latest = await publicClient.getBlock()
    if (latest.timestamp < revealStartTs) return { ...base, status: 'not-started', fetchedAt: Date.now() }
    onProgress?.('locating the reveal-phase block range')
    const fromBlock = await findBlockByTimestamp(revealStartTs)
    const toBlock = latest.timestamp < roundEndTs ? latest.number : await findBlockByTimestamp(roundEndTs)

    // ≤9k-block chunks for free-tier range caps; on result-count caps (e.g. Geth's
    // 20k logs per query on busy reveal days) recursively halve the range.
    async function getLogsRange(from: bigint, to: bigint, depth = 0): Promise<any[]> {
        try {
            return await publicClient.getLogs({
                address: votingContract.address, event: voteRevealedEvent, fromBlock: from, toBlock: to,
            })
        } catch (e) {
            if (to - from < 50n || depth > 10) {
                if (depth === 0) { // transient failure on a small range — one retry
                    await new Promise(r => setTimeout(r, 3000))
                    return getLogsRange(from, to, depth + 1)
                }
                throw e
            }
            const mid = (from + to) / 2n
            return [...await getLogsRange(from, mid, depth + 1), ...await getLogsRange(mid + 1n, to, depth + 1)]
        }
    }
    const CHUNK = 9_000n
    const logs = []
    const chunks = Number((toBlock - fromBlock) / CHUNK) + 1
    let chunk = 0
    for (let from = fromBlock; from <= toBlock; from += CHUNK) {
        onProgress?.(`scanning reveal logs — chunk ${++chunk}/${chunks}`)
        logs.push(...await getLogsRange(from, from + CHUNK - 1n > toBlock ? toBlock : from + CHUNK - 1n))
    }

    const tallies = new Map<string, RequestTally>()
    for (const log of logs) {
        const a = log.args as any
        if (Number(a.roundId) !== roundId) continue
        const key = `${a.identifier}-${a.time}-${a.ancillaryData}`.toLowerCase()
        let t = tallies.get(key)
        if (!t) {
            t = { identifier: a.identifier, time: a.time, ancillaryData: a.ancillaryData, byPrice: new Map(), total: 0n }
            tallies.set(key, t)
        }
        const priceKey = (a.price as bigint).toString()
        t.byPrice.set(priceKey, (t.byPrice.get(priceKey) ?? 0n) + a.numTokens)
        t.total += a.numTokens
        if (myAddress && (a.voter as string).toLowerCase() === myAddress) t.myPrice = a.price
    }
    if (tallies.size === 0) return { ...base, status: 'no-reveals', fetchedAt: Date.now() }

    // My unrevealed commitments → gray "committed" marker
    onProgress?.('checking your commitments')
    const myCommits = await getOnChainCommitments(roundId).catch(() => undefined)

    // Question titles: local answers cache → GitHub (past rounds are merged) →
    // title embedded in ancillaryData (cross-chain Polymarket requests carry only
    // a hash, but direct mainnet requests often include the text) → identifier@time
    const answers: Answer[] = (await getAnswers(roundId).catch(() => undefined))?.answers ?? []
    const questionFor = (t: RequestTally): { question: string; needsTitle: boolean } => {
        const known = answers.find(x => x.ancillaryData.toLowerCase() === t.ancillaryData.toLowerCase() && (x.timestamp === undefined || BigInt(x.timestamp) === t.time))?.question
            ?? titleFromAncillary(t.ancillaryData)
        return known ? { question: known, needsTitle: false } : { question: `${decodeIdentifier(t.identifier)} @ ${t.time}`, needsTitle: true }
    }

    const requests = [...tallies.values()].map(t => {
        const prices = [...t.byPrice.entries()]
            .map(([p, tokens]) => ({ price: BigInt(p), tokens }))
            .sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0))
        const leading = prices[0]
        return {
            identifier: t.identifier, time: t.time, ancillaryData: t.ancillaryData,
            ...questionFor(t),
            prices, total: t.total,
            leadingPrice: leading.price, leadingTokens: leading.tokens,
            quorumOk: t.total >= minParticipation,
            consensusOk: leading.tokens >= minAgreement,
            myPrice: t.myPrice,
            myCommitted: t.myPrice === undefined && (myCommits?.commitments.some(c =>
                c.ancillaryData.toLowerCase() === t.ancillaryData.toLowerCase() && c.time === t.time) ?? false),
        }
    })
    return { ...base, status: 'ok', requests, fetchedAt: Date.now() }
}

export async function renderRoundResults(roundId: number, pre?: RoundResults): Promise<void> {
    const d = pre ?? await fetchRoundResults(roundId)
    if (d.status === 'no-votes') {
        console.log(`Round ${roundId}: no reveals recorded (round was never frozen — nothing was voted).`)
        return
    }

    // Placeholder questions (hash-only cross-chain requests with no answers
    // file) resolve BEFORE rendering — a static table can't fill them in
    // lazily like the explorer does. .cache/ancillary hits are instant;
    // misses ask the dApp resolver once and persist. Failures keep the
    // identifier@time placeholder.
    if (d.status === 'ok' && d.requests.some(r => r.needsTitle)) {
        const { resolveAncillaryText, mapLimit } = await import('./resolve')
        await mapLimit(d.requests.filter(r => r.needsTitle), 5, async r => {
            const text = await resolveAncillaryText(r.identifier, r.time, r.ancillaryData)
            const title = text && titleFromText(text)
            if (title) { r.question = title; r.needsTitle = false }
        })
    }

    console.log(`Round ${roundId}: staked ${fmtTokens(d.cumulativeStake)} · quorum needs ${fmtTokens(d.minParticipation)} revealed · consensus needs ${fmtTokens(d.minAgreement)} on one outcome`)
    if (d.status === 'not-started') {
        console.log(`Reveal phase hasn't started yet.`)
        return
    }
    if (d.status === 'no-reveals') {
        console.log(`No reveals yet in round ${roundId}.`)
        return
    }

    const P = { P1: P1_VALUE, P2: P2_VALUE, P3: P3_VALUE, P4: P4_VALUE }

    // Per-vote UMA earned/lost via slashing — the Earnings column shows on
    // every final round; without a voter identity (no signing key) or a
    // subgraph answer its cells are a dim "-"
    let slashes: VoteSlashes | undefined
    const showEarnings = isFinal(roundId)
    const slashVoter = d.myAddress
    if (showEarnings && slashVoter) slashes = await fetchVoteSlashes(slashVoter)

    console.log(`\n  #  Mine${showEarnings ? `${'Earnings'.padStart(15)} ` : '     '}Question                                  Quorum                Consensus             P1      P2      P3      P4      other`)
    console.log(`  ${'-'.repeat(showEarnings ? 149 : 138)}`)
    let row = 0, passing = 0
    for (const t of d.requests) {
        row++
        if (t.quorumOk && t.consensusOk) passing++

        let mine = `${DIM}${'–'.padEnd(7)}${RESET}`
        if (t.myPrice !== undefined) {
            mine = t.myPrice === t.leadingPrice
                ? `${GREEN}${('✓' + priceLabel(t.myPrice)).padEnd(7)}${RESET}`
                : `${RED}${('✗' + priceLabel(t.myPrice)).padEnd(7)}${RESET}`
        } else if (t.myCommitted) {
            mine = `${DIM}${'cmtd'.padEnd(7)}${RESET}` // committed, not (yet) revealed
        }

        const tokensFor = (price: bigint) => t.prices.find(s => s.price === price)?.tokens ?? 0n
        const pctOf = (price: bigint) => pct(tokensFor(price), t.total).padStart(6)
        const known = tokensFor(P.P1) + tokensFor(P.P2) + tokensFor(P.P3) + tokensFor(P.P4)
        const other = pct(t.total - known, t.total).padStart(6)

        const quorum = `${pctOfThreshold(t.total, d.minParticipation).padStart(6)} ${fmtTokens(t.total)}/${fmtTokens(d.minParticipation)}${t.quorumOk ? '✓' : '✗'}`
        const consensus = `${pctOfThreshold(t.leadingTokens, d.minAgreement).padStart(6)} ${fmtTokens(t.leadingTokens)}/${fmtTokens(d.minAgreement)}${t.consensusOk ? '✓' : '✗'}`

        const earningsCell = !showEarnings ? ''
            // Rolled requests settle in a later round — their slash entry
            // (keyed per request, not per round) must not show here
            : (!t.quorumOk || !t.consensusOk) ? ` ${DIM}${'rolled'.padStart(10)}${RESET}`
            : slashes ? renderSlashCell(slashFor(slashes, t.identifier, t.time, t.ancillaryData))
            : ` ${DIM}${'-'.padStart(10)}${RESET}`
        console.log(`  ${String(row).padStart(2)}  ${mine}${earningsCell} ${t.question.slice(0, 40).padEnd(41)} ${quorum.padEnd(21)} ${consensus.padEnd(21)} ${pctOf(P.P1)} ${pctOf(P.P2)} ${pctOf(P.P3)} ${pctOf(P.P4)} ${other}`)
    }
    console.log(`\n${passing}/${d.requests.length} request(s) currently pass quorum + consensus.`)
    if (slashes) {
        const { net, pending, matched } = roundSlashStats(slashes, d.requests)
        if (matched > 0) {
            const netStr = `${net > 0 ? '+' : ''}${net.toFixed(3)}`
            console.log(`Your net for round ${roundId}: ${net < 0 ? RED : GREEN}${netStr} UMA${RESET}${pending > 0 ? `${DIM} · ${pending} pending${RESET}` : ''}`)
        }
    }
    if (showEarnings) {
        console.log(`${DIM}Earnings: UMA earned/lost through slashing (UMA subgraph) · pending = trackers not settled yet · rolled = settles in a later round · - = unknown (no signing key).${RESET}`)
    }
    console.log(`${DIM}Quorum/Consensus: progress toward the threshold (revealed/required · leading-outcome/required), capped at 100%.${RESET}`)
    console.log(`${DIM}Mine: ✓ = matches current majority · ✗ = differs · cmtd = committed but not revealed · – = no vote${RESET}`)
    if (!d.myAddress) console.log(`⚠️  Your votes can't be marked — no EXPECTED_VOTER and no .signing-key.json (run \`nub run init\` or \`nub run verify-key\`).`)
}
