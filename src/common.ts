import { createPublicClient, http, fallback, getAddress, encodePacked, keccak256, hexToString, parseAbiItem, parseGwei, formatGwei, parseUnits } from 'viem'
import { mainnet } from 'viem/chains'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { umaContractAbi } from './umaAbi'
import { UMA_VOTING_V2, RPC_URLS, ANSWERS_FILE, EXPECTED_VOTER, ROUNDS_DIR, ROOT } from './config'
import { getWallet, signerKind } from './signers'
import { ask } from './signers/prompt'

// ---------- clients ----------

export const publicClient = createPublicClient({
    chain: mainnet,
    transport: fallback(RPC_URLS.map(u => http(u))),
})

// Signing goes through the SIGNER backend (frame/trezor/ledger/lattice/
// walletconnect — see src/signers/); `nub run init` configures it.
export { getWallet } from './signers'

export async function getWalletAccount(): Promise<`0x${string}`> {
    const { account } = await getWallet()
    const address = getAddress(account.address)
    if (EXPECTED_VOTER && getAddress(EXPECTED_VOTER.toLowerCase()) !== address) {
        throw new Error(`${signerKind()} account ${address} != EXPECTED_VOTER ${EXPECTED_VOTER}. Wrong account selected.`)
    }
    return address
}

// ---------- contract reads ----------

export type PendingRequest = {
    lastVotingRound: number
    isGovernance: boolean
    time: bigint
    rollCount: number
    identifier: `0x${string}`
    ancillaryData: `0x${string}`
}

export const votingContract = { address: UMA_VOTING_V2, abi: umaContractAbi } as const

// 0 = commit, 1 = reveal
export async function getVotePhase(): Promise<number> {
    return Number(await publicClient.readContract({ ...votingContract, functionName: 'getVotePhase' }))
}

export async function getCurrentRoundId(): Promise<number> {
    return Number(await publicClient.readContract({ ...votingContract, functionName: 'getCurrentRoundId' }))
}

export async function getPendingRequests(): Promise<PendingRequest[]> {
    return await publicClient.readContract({ ...votingContract, functionName: 'getPendingRequests' }) as unknown as PendingRequest[]
}

// The address a vote is recorded against. Equals the caller itself for direct
// voting, or the staker when the caller is a registered delegate.
export async function getVoterFromDelegate(caller: `0x${string}`): Promise<`0x${string}`> {
    return getAddress(await publicClient.readContract({
        ...votingContract, functionName: 'getVoterFromDelegate', args: [caller],
    }) as `0x${string}`)
}

// ---------- identifiers & prices ----------

export const P1_VALUE = 0n
export const P2_VALUE = 1_000000000000000000n
export const P3_VALUE = 500000000000000000n
export const P4_VALUE = -57896044618658097711785492504343953926634992332820282019728792003956564819968n // min int256, "too early"

const YES_ANSWERS = ['yes', 'true', 'valid', 'p2', '1']
const NO_ANSWERS = ['no', 'false', 'invalid', 'p1', '0']

export function decodeIdentifier(identifier: `0x${string}`): string {
    const decoded = hexToString(identifier).replace(/\0/g, '')
    return decoded.startsWith('Admin') ? 'Admin' : decoded
}

// Encoded on-chain price for an answer value, or undefined if it can't be determined
export function encodePrice(answer: string, decodedIdentifier: string): bigint | undefined {
    const a = answer.trim().toLowerCase()
    if (decodedIdentifier === 'YES_OR_NO_QUERY') {
        if (a === 'p1') return P1_VALUE
        if (a === 'p2') return P2_VALUE
        if (a === 'p3') return P3_VALUE
        if (a === 'p4') return P4_VALUE
    } else if (decodedIdentifier === 'ACROSS-V2' || decodedIdentifier === 'ASSERT_TRUTH' || decodedIdentifier === 'Admin') {
        if (YES_ANSWERS.includes(a)) return 1_000000000000000000n
        if (NO_ANSWERS.includes(a)) return 0n
    }
    // Custom numeric price in human units, scaled to 1e18 — the dApp's custom-input
    // scheme. Also the only way to vote on identifiers without a yes/no mapping.
    if (/^-?\d+(\.\d+)?$/.test(a)) return parseUnits(a, 18)
    return undefined
}

// Human-readable title embedded in ancillaryData, when present (cross-chain
// Polymarket requests carry only a hash; direct mainnet requests often include text)
export function titleFromAncillary(ancillaryData: `0x${string}`): string | undefined {
    try {
        const text = Buffer.from(ancillaryData.slice(2), 'hex').toString('utf8')
        const m = /title:\s*(.*?),\s*description:/s.exec(text) ?? /q:\s*"?([^"\n]{4,})/.exec(text)
        return m?.[1]?.trim()
    } catch { return undefined }
}

// ---------- answers ----------

export type Answer = {
    ancillaryData: `0x${string}`
    timestamp?: number
    question: string
    answer: string
    skip?: boolean
}

// Answer resolution precedence: ANSWERS_FILE override → locally saved
// answers/<roundId>.json → installed addons (see src/addons.ts).
export async function getAnswers(roundId: number): Promise<{ source: string; answers: Answer[] } | undefined> {
    if (ANSWERS_FILE) {
        return { source: ANSWERS_FILE, answers: JSON.parse(readFileSync(ANSWERS_FILE, 'utf8')) }
    }
    const local = path.join(ROOT, 'answers', `${roundId}.json`)
    if (existsSync(local)) {
        return { source: `answers/${roundId}.json (local)`, answers: JSON.parse(readFileSync(local, 'utf8')) }
    }
    // Answers saved by an interactive commit review. Kept in a separate file so
    // a pulled answers file is never overwritten and, once pulled, wins again.
    const localInteractive = path.join(ROOT, 'answers', `${roundId}.local.json`)
    if (existsSync(localInteractive)) {
        return { source: `answers/${roundId}.local.json (your last interactive review)`, answers: JSON.parse(readFileSync(localInteractive, 'utf8')) }
    }
    // Dynamic import: addons import this module, so the host loads lazily
    const { loadAddons } = await import('./addons')
    for (const addon of await loadAddons()) {
        const r = await addon.getAnswers(roundId).catch(() => undefined)
        if (r) return r
    }
    return undefined
}

// Match each request to an answer by ancillaryData (+ timestamp when available).
// Each answer is consumed at most once, so duplicated ancillaryData (e.g.
// repeated ACROSS-V2 requests) resolves by timestamp instead of first-match.
export function matchAnswer(request: PendingRequest, pool: Answer[]): Answer | undefined {
    const ad = request.ancillaryData.toLowerCase()
    const candidates = pool.filter(a => a.ancillaryData.toLowerCase() === ad)
    if (candidates.length === 0) return undefined
    const exact = candidates.find(a => a.timestamp !== undefined && BigInt(a.timestamp) === request.time)
    const match = exact ?? candidates[0]
    pool.splice(pool.indexOf(match), 1)
    return match
}

// ---------- commit hash & salt ----------

export function randomSalt(): bigint {
    return BigInt('0x' + randomBytes(31).toString('hex')) // < 2^248, always a valid positive int256
}

// Must mirror VotingV2: keccak256(abi.encodePacked(price, salt, voter, time, ancillaryData, roundId, identifier))
export function commitHash(
    price: bigint, salt: bigint, voter: `0x${string}`, time: bigint,
    ancillaryData: `0x${string}`, roundId: number, identifier: `0x${string}`,
): `0x${string}` {
    return keccak256(encodePacked(
        ['int256', 'int256', 'address', 'uint256', 'bytes', 'uint256', 'bytes32'],
        [price, salt, voter, time, ancillaryData, BigInt(roundId), identifier],
    ))
}

// ---------- round file persistence ----------

export type StoredVote = {
    identifier: `0x${string}`
    identifierDecoded: string
    time: string
    ancillaryData: `0x${string}`
    question: string
    answer: string
    price: string
    salt: string
}

export type RoundFile = {
    roundId: number
    caller: `0x${string}`
    voter: `0x${string}`
    answersSource: string
    createdAt: string
    commitTxHash?: `0x${string}`
    revealTxHash?: `0x${string}`
    votes: StoredVote[]
}

function roundPath(roundId: number): string {
    return path.join(ROUNDS_DIR, `${roundId}.json`)
}

export function loadRound(roundId: number): RoundFile | undefined {
    const p = roundPath(roundId)
    if (!existsSync(p)) return undefined
    return JSON.parse(readFileSync(p, 'utf8')) as RoundFile
}

export function saveRound(round: RoundFile): string {
    mkdirSync(ROUNDS_DIR, { recursive: true })
    const p = roundPath(round.roundId)
    writeFileSync(p, JSON.stringify(round, null, 2))
    return p
}

// ---------- EncryptedVote events (dApp-compatible recovery) ----------

export type EncryptedVoteEvent = {
    identifier: `0x${string}`
    time: bigint
    ancillaryData: `0x${string}`
    encryptedVote: `0x${string}`
    roundId: number
    transactionHash: `0x${string}`
}

const encryptedVoteEventAbi = parseAbiItem(
    'event EncryptedVote(address indexed caller, uint32 indexed roundId, bytes32 indexed identifier, uint256 time, bytes ancillaryData, bytes encryptedVote)'
)

// Same source the voter dApp uses to restore commits: EncryptedVote events by caller.
// Deduped to the latest event per request (re-commits override earlier ones).
// Lookback default ~15k blocks ≈ 50h — covers a full 48h round.
export async function getEncryptedVoteEvents(
    caller: `0x${string}`, roundId?: number, lookbackBlocks = 15_000n,
): Promise<EncryptedVoteEvent[]> {
    const latest = await publicClient.getBlockNumber()
    // Chunked ≤9k-block windows: free-tier RPCs cap eth_getLogs ranges (drpc: 10k)
    const CHUNK = 9_000n
    const logs = []
    for (let from = latest - lookbackBlocks; from <= latest; from += CHUNK) {
        const params = {
            address: votingContract.address,
            event: encryptedVoteEventAbi,
            args: roundId !== undefined ? { caller, roundId } : { caller },
            fromBlock: from,
            toBlock: from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n,
        } as const
        try {
            logs.push(...await publicClient.getLogs(params))
        } catch {
            await new Promise(r => setTimeout(r, 3000)) // free-tier rate limit — retry once
            logs.push(...await publicClient.getLogs(params))
        }
    }
    const byRequest = new Map<string, EncryptedVoteEvent>()
    for (const log of logs) { // getLogs returns logs in ascending order — later entries win
        const { identifier, time, ancillaryData, encryptedVote, roundId: rid } = log.args as any
        byRequest.set(`${identifier}-${time}-${ancillaryData}`.toLowerCase(), {
            identifier, time, ancillaryData, encryptedVote,
            roundId: Number(rid), transactionHash: log.transactionHash,
        })
    }
    return [...byRequest.values()]
}

// ---------- gas fees ----------

// Fee defaults: tip 0.0001 gwei, max fee = current base fee + 20% + tip.
// Note: base fee can rise 12.5% per full block, so 20% headroom covers ~1.5
// blocks — if it climbs past the cap the tx waits in the mempool until base
// drops back (no cost; unused headroom is refunded by EIP-1559 either way).
// Override with --max-fee=<gwei> / --tip=<gwei> or MAX_FEE_GWEI / PRIORITY_FEE_GWEI
// env vars. Values are still editable in Frame's approval window before signing.
export const DEFAULT_TIP_GWEI = '0.0001'

export async function resolveFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const maxFeeArg = argValue('max-fee') ?? process.env.MAX_FEE_GWEI
    const tipArg = argValue('tip') ?? process.env.PRIORITY_FEE_GWEI

    const block = await publicClient.getBlock()
    const baseFee = block.baseFeePerGas ?? 0n

    const maxPriorityFeePerGas = parseGwei(tipArg ?? DEFAULT_TIP_GWEI)
    const maxFeePerGas = maxFeeArg ? parseGwei(maxFeeArg) : (baseFee * 120n) / 100n + maxPriorityFeePerGas

    console.log(`Fees: base ${formatGwei(baseFee)} gwei → max fee ${formatGwei(maxFeePerGas)} gwei ${maxFeeArg ? '(override)' : '(base + 20% + tip)'} · tip ${formatGwei(maxPriorityFeePerGas)} gwei ${tipArg ? '(override)' : '(default)'}`)
    if (maxFeePerGas < baseFee) console.log(`⚠️  max fee is below the current base fee — the tx will not be included until base fee drops.`)
    return { maxFeePerGas, maxPriorityFeePerGas }
}

// ---------- batched sending ----------

// Sends calls as one multicall; if the wallet rejects oversized calldata
// (GridPlus Lattice caps signable payloads at ~1.5KB), falls back to
// size-bounded chunks, each needing its own device approval.
// Tune the chunk size with TX_DATA_LIMIT_BYTES (default 1400).
// Warn before queuing behind a stuck transaction: a re-run gets the next pending
// nonce and waits for the stuck tx to clear — replacing it (Frame's Speed Up,
// same nonce + ≥10% higher fees) is usually what you actually want.
async function pendingTxGuard(account: `0x${string}`): Promise<void> {
    const [pending, latest] = await Promise.all([
        publicClient.getTransactionCount({ address: account, blockTag: 'pending' }),
        publicClient.getTransactionCount({ address: account, blockTag: 'latest' }),
    ])
    const stuck = pending - latest
    if (stuck <= 0) return
    console.log(`\n⚠️  ${account} has ${stuck} pending transaction(s) (nonce ${latest}${stuck > 1 ? `-${pending - 1}` : ''}).`)
    console.log(`This transaction will be QUEUED BEHIND them and won't mine until they clear.`)
    console.log(`If one is stuck on a low fee, use Speed Up on it in Frame instead of re-sending here.`)
    const reply = await ask(`Queue behind the pending transaction(s) anyway? (y/N)`)
    if (!/^y(es)?$/i.test(reply)) {
        console.log('Aborted — nothing sent.')
        process.exit(0)
    }
}

export async function sendMulticallBatched(
    datas: `0x${string}`[],
    account: `0x${string}`,
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    label: string,
): Promise<`0x${string}`[]> {
    await pendingTxGuard(account)
    const wallet = await getWallet()
    const send = async (batch: `0x${string}`[]): Promise<`0x${string}`> => {
        const txHash = await wallet.client.writeContract({
            ...votingContract, functionName: 'multicall', args: [batch],
            account: wallet.account, chain: wallet.client.chain, ...fees,
        })
        console.log(`Sent: https://etherscan.io/tx/${txHash}`)
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
        if (receipt.status !== 'success') throw new Error(`Transaction ${txHash} REVERTED — the ${label}s in it did NOT take effect.`)
        return txHash
    }

    try {
        console.log(`\nSending ${datas.length} ${label}(s) as one multicall — confirm on your hardware wallet...`)
        return [await send(datas)]
    } catch (e) {
        const msg = ((e as Error & { details?: string }).details ?? (e as Error).message ?? '')
        if (datas.length < 2 || !/invalid request|too large|payload|exceeds/i.test(msg)) throw e

        const limit = Number(process.env.TX_DATA_LIMIT_BYTES ?? 1400)
        const chunks: `0x${string}`[][] = []
        let cur: `0x${string}`[] = [], curBytes = 0
        for (const d of datas) {
            const bytes = (d.length - 2) / 2
            if (cur.length > 0 && curBytes + bytes > limit) { chunks.push(cur); cur = []; curBytes = 0 }
            cur.push(d); curBytes += bytes
        }
        if (cur.length > 0) chunks.push(cur)

        console.log(`\n⚠️  Wallet rejected the large transaction (${msg.split('\n')[0]}) — likely the GridPlus Lattice ~1.5KB calldata limit.`)
        console.log(`Splitting into ${chunks.length} smaller transaction(s); confirm EACH on the device.`)
        const hashes: `0x${string}`[] = []
        for (const [i, chunk] of chunks.entries()) {
            console.log(`\n[${i + 1}/${chunks.length}] Sending ${chunk.length} ${label}(s)...`)
            hashes.push(await send(chunk))
        }
        return hashes
    }
}

// ---------- friendly error handling ----------

// Uncaught errors (rejected wallet requests, RPC failures, viem dumps) print a
// one-line message; the full error + stack goes to a log file instead of the console.
export function logErrorToFile(e: unknown): string {
    const logsDir = path.join(ROOT, 'logs')
    mkdirSync(logsDir, { recursive: true })
    const file = path.join(logsDir, `error-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
    const err = e as Error & { details?: string; metaMessages?: string[] }
    writeFileSync(file, [
        `time: ${new Date().toISOString()}`,
        `argv: ${process.argv.join(' ')}`,
        ``,
        err?.stack ?? String(e),
        ``,
        err?.details ? `details: ${err.details}` : '',
        err?.metaMessages ? err.metaMessages.join('\n') : '',
    ].join('\n'))
    return file
}

const friendly = (e: unknown) => {
    const err = e as Error & { shortMessage?: string }
    const msg = err?.shortMessage ?? (err?.message ?? String(e)).split('\n')[0]
    if (/reject|declin|denied/i.test(msg)) {
        console.error(`\n🚫 Rejected on the wallet — nothing was sent.`)
    } else {
        const file = logErrorToFile(e)
        console.error(`\n❌ ${msg}`)
        console.error(`Full details: ${path.relative(process.cwd(), file)}`)
    }
    process.exit(1)
}
process.on('uncaughtException', friendly)
process.on('unhandledRejection', friendly)

// ---------- misc ----------

export const hasFlag = (flag: string) => process.argv.includes(flag)

// Flag value in either syntax: --round 10319 or --round=10319
export function argValue(name: string): string | undefined {
    const eq = process.argv.find(a => a.startsWith(`--${name}=`))
    if (eq) return eq.slice(name.length + 3)
    const i = process.argv.indexOf(`--${name}`)
    if (i !== -1 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
    return undefined
}

export function phaseEndsAt(): Date {
    const now = Math.floor(Date.now() / 1000)
    return new Date((Math.floor(now / 86400) + 1) * 86400 * 1000)
}

export function fmtCountdown(to: Date): string {
    const s = Math.max(0, Math.floor((to.getTime() - Date.now()) / 1000))
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function short(hex: string, n = 10): string {
    return hex.length > 2 * n ? `${hex.slice(0, n)}…${hex.slice(-4)}` : hex
}
