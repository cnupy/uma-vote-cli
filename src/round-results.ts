// Live/past round results: per-request quorum, consensus, and price
// distribution aggregated from VoteRevealed events, with your own vote marked
// green (matches current majority), red (differs), or gray (committed but not
// revealed / not committed). Used by `nub run results` and by status during
// the reveal phase.
import { parseAbiItem } from 'viem'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './config'
import { publicClient, votingContract, decodeIdentifier, getAnswers, titleFromAncillary, type Answer } from './common'
import { getOnChainCommitments, priceLabel, GREEN, RED, DIM, RESET } from './compare'

const voteRevealedEvent = parseAbiItem(
    'event VoteRevealed(address indexed voter, address indexed caller, uint32 roundId, bytes32 indexed identifier, uint256 time, bytes ancillaryData, int256 price, uint128 numTokens)'
)

const ROUND_SECONDS = 172_800n
const PHASE_SECONDS = 86_400n

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

const fmtTokens = (wei: bigint) => {
    const t = Number(wei) / 1e18
    return t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : t >= 1e3 ? `${(t / 1e3).toFixed(0)}k` : t.toFixed(0)
}
const pct = (num: bigint, den: bigint) => den === 0n ? '—' : `${(Number(num * 10_000n / den) / 100).toFixed(1)}%`
// Progress toward a threshold, capped at 100% once met
const pctOfThreshold = (num: bigint, den: bigint) => den === 0n ? '—' : num >= den ? '100%' : `${(Number(num * 10_000n / den) / 100).toFixed(1)}%`

type RequestTally = {
    identifier: `0x${string}`
    time: bigint
    ancillaryData: `0x${string}`
    byPrice: Map<string, bigint> // price (decimal string) → tokens
    total: bigint
    myPrice?: bigint
}

export async function renderRoundResults(roundId: number): Promise<void> {
    const round = await publicClient.readContract({
        ...votingContract, functionName: 'rounds', args: [BigInt(roundId)],
    }) as readonly [string, bigint, bigint, bigint, number]
    const [, minParticipation, minAgreement, cumulativeStake] = round
    if (minParticipation === 0n) {
        console.log(`Round ${roundId}: no reveals recorded (round was never frozen — nothing was voted).`)
        return
    }

    console.log(`Round ${roundId}: staked ${fmtTokens(cumulativeStake)} · quorum needs ${fmtTokens(minParticipation)} revealed · consensus needs ${fmtTokens(minAgreement)} on one outcome`)

    // Reveals happen only in the round's reveal phase — scan exactly that block range
    const revealStartTs = BigInt(roundId) * ROUND_SECONDS + PHASE_SECONDS
    const roundEndTs = BigInt(roundId + 1) * ROUND_SECONDS
    const latest = await publicClient.getBlock()
    if (latest.timestamp < revealStartTs) {
        console.log(`Reveal phase hasn't started yet.`)
        return
    }
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
    for (let from = fromBlock; from <= toBlock; from += CHUNK) {
        logs.push(...await getLogsRange(from, from + CHUNK - 1n > toBlock ? toBlock : from + CHUNK - 1n))
    }

    // My address (for marking my votes) — cached signing key, no wallet needed
    let myAddress: string | undefined
    const keyCache = path.join(ROOT, '.signing-key.json')
    if (existsSync(keyCache)) {
        const cache = JSON.parse(readFileSync(keyCache, 'utf8')) as Record<string, { address: string }>
        myAddress = Object.values(cache)[0]?.address.toLowerCase()
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
    if (tallies.size === 0) {
        console.log(`No reveals yet in round ${roundId}.`)
        return
    }

    // My unrevealed commitments → gray "committed" marker
    const myCommits = await getOnChainCommitments(roundId).catch(() => undefined)

    // Question titles: local answers cache → GitHub (past rounds are merged) →
    // title embedded in ancillaryData (cross-chain Polymarket requests carry only
    // a hash, but direct mainnet requests often include the text) → identifier@time
    const answers: Answer[] = (await getAnswers(roundId).catch(() => undefined))?.answers ?? []
    const questionFor = (t: RequestTally) =>
        answers.find(x => x.ancillaryData.toLowerCase() === t.ancillaryData.toLowerCase() && (x.timestamp === undefined || BigInt(x.timestamp) === t.time))?.question
        ?? titleFromAncillary(t.ancillaryData)
        ?? `${decodeIdentifier(t.identifier)} @ ${t.time}`

    const P = { P1: 0n, P2: 1_000000000000000000n, P3: 500000000000000000n, P4: -57896044618658097711785492504343953926634992332820282019728792003956564819968n }

    console.log(`\n  #  Mine     Question                                  Quorum                Consensus             P1      P2      P3      P4      other`)
    console.log(`  ${'-'.repeat(138)}`)
    let row = 0, passing = 0
    for (const t of tallies.values()) {
        row++
        const leading = [...t.byPrice.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))[0]
        const leadingPrice = BigInt(leading[0]), leadingTokens = leading[1]
        const quorumOk = t.total >= minParticipation
        const consensusOk = leadingTokens >= minAgreement
        if (quorumOk && consensusOk) passing++

        let mine = `${DIM}${'–'.padEnd(7)}${RESET}`
        if (t.myPrice !== undefined) {
            mine = t.myPrice === leadingPrice
                ? `${GREEN}${('✓' + priceLabel(t.myPrice)).padEnd(7)}${RESET}`
                : `${RED}${('✗' + priceLabel(t.myPrice)).padEnd(7)}${RESET}`
        } else if (myCommits?.commitments.some(c =>
            c.ancillaryData.toLowerCase() === t.ancillaryData.toLowerCase() && c.time === t.time)) {
            mine = `${DIM}${'cmtd'.padEnd(7)}${RESET}` // committed, not (yet) revealed
        }

        const pctOf = (price: bigint) => pct(t.byPrice.get(price.toString()) ?? 0n, t.total).padStart(6)
        const known = (t.byPrice.get(P.P1.toString()) ?? 0n) + (t.byPrice.get(P.P2.toString()) ?? 0n) + (t.byPrice.get(P.P3.toString()) ?? 0n) + (t.byPrice.get(P.P4.toString()) ?? 0n)
        const other = pct(t.total - known, t.total).padStart(6)

        const quorum = `${pctOfThreshold(t.total, minParticipation).padStart(6)} ${fmtTokens(t.total)}/${fmtTokens(minParticipation)}${quorumOk ? '✓' : '✗'}`
        const consensus = `${pctOfThreshold(leadingTokens, minAgreement).padStart(6)} ${fmtTokens(leadingTokens)}/${fmtTokens(minAgreement)}${consensusOk ? '✓' : '✗'}`
        console.log(`  ${String(row).padStart(2)}  ${mine} ${questionFor(t).slice(0, 40).padEnd(41)} ${quorum.padEnd(21)} ${consensus.padEnd(21)} ${pctOf(P.P1)} ${pctOf(P.P2)} ${pctOf(P.P3)} ${pctOf(P.P4)} ${other}`)
    }
    console.log(`\n${passing}/${tallies.size} request(s) currently pass quorum + consensus.`)
    console.log(`${DIM}Quorum/Consensus: progress toward the threshold (revealed/required · leading-outcome/required), capped at 100%.${RESET}`)
    console.log(`${DIM}Mine: ✓ = matches current majority · ✗ = differs · cmtd = committed but not revealed · – = no vote${RESET}`)
}
