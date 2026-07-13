import { createPublicClient, http, fallback, getAddress, encodePacked, encodeFunctionData, keccak256, hexToString, parseAbiItem, parseGwei, formatGwei, parseUnits } from 'viem'
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

// Round and phase are pure time functions on-chain (VoteTiming: roundId =
// timestamp / 172800, phase = timestamp / 86400 % 2 with 0 = commit) — these
// local versions let a long-running UI roll over at the phase boundary
// without an RPC. The contract calls above stay the authoritative check at
// startup.
export const ROUND_SECONDS = 172_800
export const PHASE_SECONDS = 86_400
export const derivedRoundId = (): number => Math.floor(Date.now() / 1000 / ROUND_SECONDS)
export const derivedPhase = (): number => Math.floor(Date.now() / 1000 / PHASE_SECONDS) % 2

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

// Strips C0 controls (except \n) + DEL: crafted question titles could carry
// ESC/cursor codes into Ink frames and spoof UI lines. Applied at ingestion.
export const sanitizeText = (s: string): string => s.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')

// Question title extracted from decoded ancillary/resolved text — the single
// home of the title regexes.
export const titleFromText = (text: string): string | undefined => {
    const t = (/title:\s*(.*?),\s*description:/s.exec(text) ?? /q:\s*"?([^"\n]{4,})/.exec(text))?.[1]?.trim()
    return t ? sanitizeText(t) : undefined
}

// Human-readable title embedded in ancillaryData, when present (cross-chain
// Polymarket requests carry only a hash; direct mainnet requests often include text)
export function titleFromAncillary(ancillaryData: `0x${string}`): string | undefined {
    try {
        return titleFromText(Buffer.from(ancillaryData.slice(2), 'hex').toString('utf8'))
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
// NOTE: answers are returned raw — addon verifyBeforeCommit gates hash the
// array as delivered, so nothing may mutate it before the gate. Display code
// sanitizes questions where they are rendered (commit-flow planning).
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

export type FeeInfo = {
    maxFeePerGas: bigint
    maxPriorityFeePerGas: bigint
    baseFee: bigint
    maxFeeOverridden: boolean
    tipOverridden: boolean
}

// Fee resolution without printing — TUI callers render it themselves
export async function computeFees(): Promise<FeeInfo> {
    const maxFeeArg = argValue('max-fee') ?? process.env.MAX_FEE_GWEI
    const tipArg = argValue('tip') ?? process.env.PRIORITY_FEE_GWEI

    const block = await publicClient.getBlock()
    const baseFee = block.baseFeePerGas ?? 0n

    const maxPriorityFeePerGas = parseGwei(tipArg ?? DEFAULT_TIP_GWEI)
    const maxFeePerGas = maxFeeArg ? parseGwei(maxFeeArg) : (baseFee * 120n) / 100n + maxPriorityFeePerGas
    return { maxFeePerGas, maxPriorityFeePerGas, baseFee, maxFeeOverridden: !!maxFeeArg, tipOverridden: !!tipArg }
}

export function describeFees(f: FeeInfo): string {
    // Wallet-mediated signers (WalletConnect, Frame) broadcast the tx
    // themselves — our fee fields are suggestions the wallet may re-price or
    // even re-type (Rabby sends legacy at its own gas price). Direct-signing
    // backends serialize the tx here, so the fees bind.
    const walletPrices = ['walletconnect', 'frame'].includes(process.env.SIGNER ?? 'frame')
    return `Fees: base ${formatGwei(f.baseFee)} gwei → max fee ${formatGwei(f.maxFeePerGas)} gwei ${f.maxFeeOverridden ? '(override)' : '(base + 20% + tip)'} · tip ${formatGwei(f.maxPriorityFeePerGas)} gwei ${f.tipOverridden ? '(override)' : '(default)'}${walletPrices ? '\n(suggestions — the connected wallet does the final pricing and may re-price or re-type the tx)' : ''}`
}

export const feeWarning = (f: FeeInfo): string | undefined =>
    f.maxFeePerGas < f.baseFee ? '⚠️  max fee is below the current base fee — the tx will not be included until base fee drops.' : undefined

export async function resolveFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const fees = await computeFees()
    console.log(describeFees(fees))
    const warn = feeWarning(fees)
    if (warn) console.log(warn)
    return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
}

// ---------- batched sending ----------

// Sends calls as one multicall; if the wallet rejects oversized calldata
// (GridPlus Lattice caps signable payloads at ~1.5KB), falls back to
// size-bounded chunks, each needing its own device approval.
// Tune the chunk size with TX_DATA_LIMIT_BYTES (default 1400).
// Warn before queuing behind a stuck transaction: a re-run gets the next pending
// nonce and waits for the stuck tx to clear — replacing it (Frame's Speed Up,
// same nonce + ≥10% higher fees) is usually what you actually want.
// Output seam so flows running inside a mounted Ink app can capture these
// lines instead of tearing frames with console prints. Defaults keep every
// standalone command byte-identical. With a sink, the guard's decline throws
// AbortSend (the app must survive) instead of the console path's process.exit.
export type SendSink = { log(line: string): void }
export class AbortSend extends Error { constructor() { super('Aborted — nothing sent.') } }

// Public RPCs can't list an account's pending txs — but every tx here is
// broadcast by this tool, so the last sent hash is recorded and stuck-tx
// detection can inspect the one that gates the nonce queue.
const PENDING_TX_FILE = path.join(ROOT, '.pending-tx.json')
export function recordSentTx(hash: `0x${string}`): void {
    try { writeFileSync(PENDING_TX_FILE, JSON.stringify({ hash })) } catch { /* best-effort */ }
}

export type StuckTx = {
    hash: `0x${string}`; nonce: number; capGwei: string; baseGwei: string
    tx: { to: `0x${string}` | null; input: `0x${string}`; value: bigint; gas: bigint; nonce: number; maxFeePerGas?: bigint; gasPrice?: bigint; maxPriorityFeePerGas?: bigint }
}

// The oldest pending tx, when it is provably UNMINABLE: still pending, gates
// the nonce queue, and its fee cap is below the CURRENT base fee. undefined =
// nothing pending, pending but minable, or a tx this tool didn't broadcast.
export async function detectStuckTx(account: `0x${string}`): Promise<StuckTx | undefined> {
    const [pending, latest] = await Promise.all([
        publicClient.getTransactionCount({ address: account, blockTag: 'pending' }),
        publicClient.getTransactionCount({ address: account, blockTag: 'latest' }),
    ])
    if (pending - latest <= 0) return undefined
    let hash: `0x${string}` | undefined
    try { hash = (JSON.parse(readFileSync(PENDING_TX_FILE, 'utf8')) as { hash?: `0x${string}` }).hash } catch { return undefined }
    if (!hash) return undefined
    const tx = await publicClient.getTransaction({ hash }).catch(() => undefined)
    if (!tx || tx.blockNumber !== null || Number(tx.nonce) !== latest || tx.from.toLowerCase() !== account.toLowerCase()) return undefined
    const base = (await publicClient.getBlock()).baseFeePerGas ?? 0n
    const cap = tx.maxFeePerGas ?? tx.gasPrice ?? 0n
    if (cap >= base) return undefined
    return {
        hash, nonce: Number(tx.nonce), capGwei: formatGwei(cap), baseGwei: formatGwei(base),
        tx: { to: tx.to, input: tx.input, value: tx.value, gas: tx.gas, nonce: Number(tx.nonce), maxFeePerGas: tx.maxFeePerGas, gasPrice: tx.gasPrice, maxPriorityFeePerGas: tx.maxPriorityFeePerGas },
    }
}

// Replacement pricing: current-market quote (base + 20%, live network tip
// estimate), floored at ≥12.5% over the stuck tx — the mempool's replacement
// minimum. Computed separately so the guard can SHOW the fees before asking.
export async function replacementFees(stuck: StuckTx): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const [fresh, marketTip] = await Promise.all([
        computeFees(),
        publicClient.estimateMaxPriorityFeePerGas().catch(() => 0n),
    ])
    const bump = (x?: bigint) => x === undefined ? 0n : x + x / 8n + 1n
    const maxBig = (...xs: bigint[]) => xs.reduce((a, b) => a > b ? a : b)
    const maxPriorityFeePerGas = maxBig(fresh.maxPriorityFeePerGas, marketTip, bump(stuck.tx.maxPriorityFeePerGas ?? stuck.tx.gasPrice))
    const maxFeePerGas = maxBig(fresh.maxFeePerGas, bump(stuck.tx.maxFeePerGas ?? stuck.tx.gasPrice), maxPriorityFeePerGas)
    return { maxFeePerGas, maxPriorityFeePerGas }
}

// Same payload, same nonce, replacement fees — a Speed Up through our signer.
export async function speedUpStuckTx(stuck: StuckTx, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<`0x${string}`> {
    const wallet = await getWallet()
    const hash = await wallet.client.sendTransaction({
        account: wallet.account, chain: wallet.client.chain,
        to: stuck.tx.to ?? undefined, data: stuck.tx.input, value: stuck.tx.value,
        gas: stuck.tx.gas, nonce: stuck.tx.nonce, ...fees,
    })
    recordSentTx(hash)
    return hash
}

// Resolves to the settled replacement when the guard unstuck a tx (so the
// caller can check whether that tx WAS the send it is about to make).
type SettledReplacement = { input: `0x${string}`; hash: `0x${string}`; success: boolean }

async function pendingTxGuard(account: `0x${string}`, out?: SendSink): Promise<SettledReplacement | undefined> {
    const [pending, latest] = await Promise.all([
        publicClient.getTransactionCount({ address: account, blockTag: 'pending' }),
        publicClient.getTransactionCount({ address: account, blockTag: 'latest' }),
    ])
    const stuck = pending - latest
    if (stuck <= 0) return undefined
    const say = out ? out.log.bind(out) : console.log

    // Autodetected unminable tx → offer the in-place fee bump. Wallet-mediated
    // signers price and nonce themselves (an explicit nonce isn't guaranteed
    // to survive), so there the wallet's own Speed Up is the right tool.
    const stuckTx = await detectStuckTx(account).catch(() => undefined)
    if (stuckTx) {
        say(`\n⚠️  Pending tx nonce ${stuckTx.nonce} is UNMINABLE: its max fee ${stuckTx.capGwei} gwei is below the current base ${stuckTx.baseGwei} gwei — it blocks every later nonce.`)
        if (!['walletconnect', 'frame'].includes(process.env.SIGNER ?? 'frame')) {
            const fees = await replacementFees(stuckTx)
            say(`Replacement fees: max ${formatGwei(fees.maxFeePerGas)} gwei · tip ${formatGwei(fees.maxPriorityFeePerGas)} gwei (current market, ≥12.5% over the stuck tx)`)
            const reply = await ask('Replace it now (same payload and nonce, wallet confirm follows)? (y/N)')
            if (/^y(es)?$/i.test(reply)) {
                const replacement = await speedUpStuckTx(stuckTx, fees)
                say(`Replacement sent: https://etherscan.io/tx/${replacement} — waiting for it to mine…`)
                // the ORIGINAL can still win the race (base may have dipped) —
                // either one mining unblocks the nonce
                const receipt = await Promise.any([
                    publicClient.waitForTransactionReceipt({ hash: replacement }),
                    publicClient.waitForTransactionReceipt({ hash: stuckTx.hash }),
                ])
                say(receipt.status === 'success' ? 'Nonce unblocked — continuing.' : `⚠️  The mined tx REVERTED (${receipt.transactionHash}) — nonce unblocked, but check what it was.`)
                return { input: stuckTx.tx.input, hash: receipt.transactionHash, success: receipt.status === 'success' }
            }
        } else {
            say(`Use your wallet's Speed Up on it, then re-run.`)
        }
    }

    say(`\n⚠️  ${account} has ${stuck} pending transaction(s) (nonce ${latest}${stuck > 1 ? `-${pending - 1}` : ''}).`)
    say(`This transaction will be QUEUED BEHIND them and won't mine until they clear.`)
    say(`If one is stuck on a low fee, use Speed Up on it in Frame instead of re-sending here.`)
    const reply = await ask(`Queue behind the pending transaction(s) anyway? (y/N)`)
    if (!/^y(es)?$/i.test(reply)) {
        if (out) throw new AbortSend()
        console.log('Aborted — nothing sent.')
        process.exit(0)
    }
    return undefined
}

// A quoted max fee can go stale between quote and send (review time, device
// confirms) — if the CURRENT base fee already exceeds the cap, the tx cannot
// mine until base falls AND it blocks every later nonce. Re-quote and
// re-confirm instead of knowingly sending a stuck tx. A --max-fee override is
// the user pinning the cap deliberately: warn, don't requote.
export async function ensureFreshFees(
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    out?: SendSink,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const say = out ? out.log.bind(out) : console.log
    const base = (await publicClient.getBlock()).baseFeePerGas ?? 0n
    if (base <= fees.maxFeePerGas) return fees
    const fresh = await computeFees()
    if (fresh.maxFeeOverridden) {
        say(`\n⚠️  Base fee is ${formatGwei(base)} gwei — above your pinned --max-fee ${formatGwei(fees.maxFeePerGas)} gwei; the tx will sit unmined until base falls.`)
        return fees
    }
    say(`\n⚠️  Base fee rose to ${formatGwei(base)} gwei — above the quoted max fee ${formatGwei(fees.maxFeePerGas)} gwei; sending would leave the tx stuck.`)
    say(describeFees(fresh))
    const reply = await ask('Send with the re-quoted fees? (y/N)')
    if (!/^y(es)?$/i.test(reply)) {
        if (out) throw new AbortSend()
        console.log('Aborted — nothing sent.')
        process.exit(0)
    }
    return { maxFeePerGas: fresh.maxFeePerGas, maxPriorityFeePerGas: fresh.maxPriorityFeePerGas }
}

export async function sendMulticallBatched(
    datas: `0x${string}`[],
    account: `0x${string}`,
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    label: string,
    out?: SendSink,
): Promise<`0x${string}`[]> {
    const say = out ? out.log.bind(out) : console.log
    const settled = await pendingTxGuard(account, out)
    // The unstuck tx is often THIS very send retried (reveal/commit calldata
    // is deterministic) — sending again would just revert ("Invalid hash
    // reveal"). Byte-compare and stop here when the intent already mined.
    if (settled?.success) {
        const intended = encodeFunctionData({ abi: votingContract.abi, functionName: 'multicall', args: [datas] })
        if (settled.input.toLowerCase() === intended.toLowerCase()) {
            say(`\n✓ The replaced transaction WAS this ${label} multicall — already mined (${settled.hash}), nothing more to send.`)
            return [settled.hash]
        }
    }
    fees = await ensureFreshFees(fees, out)
    const wallet = await getWallet()
    const send = async (batch: `0x${string}`[]): Promise<`0x${string}`> => {
        const txHash = await wallet.client.writeContract({
            ...votingContract, functionName: 'multicall', args: [batch],
            account: wallet.account, chain: wallet.client.chain, ...fees,
        })
        recordSentTx(txHash)
        say(`Sent: https://etherscan.io/tx/${txHash}`)
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
        if (receipt.status !== 'success') throw new Error(`Transaction ${txHash} REVERTED — the ${label}s in it did NOT take effect.`)
        return txHash
    }

    try {
        say(`\nSending ${datas.length} ${label}(s) as one multicall — confirm on your hardware wallet...`)
        return [await send(datas)]
    } catch (e) {
        if (e instanceof AbortSend) throw e
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

        say(`\n⚠️  Wallet rejected the large transaction (${msg.split('\n')[0]}) — likely the GridPlus Lattice ~1.5KB calldata limit.`)
        say(`Splitting into ${chunks.length} smaller transaction(s); confirm EACH on the device.`)
        const hashes: `0x${string}`[] = []
        for (const [i, chunk] of chunks.entries()) {
            say(`\n[${i + 1}/${chunks.length}] Sending ${chunk.length} ${label}(s)...`)
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
    let dump = [
        `time: ${new Date().toISOString()}`,
        `argv: ${process.argv.join(' ')}`,
        ``,
        err?.stack ?? String(e),
        ``,
        err?.details ? `details: ${err.details}` : '',
        err?.metaMessages ? err.metaMessages.join('\n') : '',
    ].join('\n')
    // RPC endpoints may carry API keys — never let them land in the dump
    for (const url of [...RPC_URLS, ...(process.env.LATTICE_RELAY_URL ? [process.env.LATTICE_RELAY_URL] : [])]) {
        dump = dump.split(url).join('<redacted-rpc>')
    }
    writeFileSync(file, dump)
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

// ANSI codes, single home (compare.ts re-exports for its older importers)
export const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', CYAN = '\x1b[36m', BOLD = '\x1b[1m', RESET = '\x1b[0m'

// package.json is the single home of the version (the about screen shows it too)
export function appVersion(): string {
    try { return (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '?' } catch { return '?' }
}

// Colored usage block (plain when piped): version header, bold Usage:, cyan flags
export function renderHelp(usage: string): string {
    if (!process.stdout.isTTY) return `uma-vote-cli v${appVersion()}\n${usage}`
    return `${DIM}uma-vote-cli v${appVersion()}${RESET}\n` + usage
        .replace(/^Usage:/m, `${BOLD}Usage:${RESET}`)
        .replace(/(--[a-zA-Z][\w-]*|(?<=\s)-[hv]\b)/g, `${CYAN}$1${RESET}`)
}

// Every command handles --help/-h and --version/-v: print and exit before
// the command's own work starts (imported modules still load first — ES
// import hoisting — so keep entrypoint imports side-effect-light).
export function handleHelp(usage: string): void {
    if (hasFlag('--version') || hasFlag('-v')) {
        console.log(appVersion())
        process.exit(0)
    }
    if (hasFlag('--help') || hasFlag('-h')) {
        console.log(renderHelp(usage))
        process.exit(0)
    }
}

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

// "45s" / "12m 3s" / "1h 10m" / "2d 5h" — the two most significant units
export function fmtAgo(since: number): string {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

export function short(hex: string, n = 10): string {
    return hex.length > 2 * n ? `${hex.slice(0, n)}…${hex.slice(-4)}` : hex
}
