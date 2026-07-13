// The `nub run uma` app (Ink). The unified votes screen is the root (commit
// review during commit phase, live/past results otherwise); a compact staking
// header sits above every screen except wallet. There is no dashboard screen:
// stake (s), unstake (u) and claim (c) deep-link from the votes screen into a
// transient action overlay — fees, pending-tx warning, simulation, y/n
// confirm, wallet signature (signer prompts render inline via the prompt
// bridge), receipt spinner — then return to votes. R opens the embedded
// reveal flow, w the signer-setup wallet screen. Read-only until an action
// needs the signer; the wallet is only connected at the first send.
import path from 'node:path'
import React, { useEffect, useRef, useState } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { formatUnits, parseUnits, getAddress } from 'viem'
import { publicClient, getWallet, computeFees, describeFees, feeWarning, fmtCountdown, getCurrentRoundId, getVotePhase, derivedRoundId, derivedPhase, phaseEndsAt, logErrorToFile, sanitizeText, recordSentTx, type FeeInfo } from './common'
import { setPromptBridge } from './signers/prompt'
import { SPINNER, maskBuf, linkifyUrls } from './tui'
import { type ExplorerOpts } from './results-ui'
import { RevealScreen } from './reveal-screen'
import { VotesScreen } from './votes-screen'
import { WalletScreen } from './wallet-screen'
import { AboutScreen } from './about-screen'
import {
    fetchDashboard, fetchVoteCount, txApprove, txStake, txRequestUnstake,
    txExecuteUnstake, txWithdrawRewards, txWithdrawAndRestake,
    type StakingSnapshot, type TxPlan,
} from './staking'
import { ensName, shortAddress } from './ens'

const fmtUma = (x: bigint, maxDecimals = 2): string =>
    Number(formatUnits(x, 18)).toLocaleString('en-US', { maximumFractionDigits: maxDecimals })

type View = 'dash' | 'stake' | 'unstake' | 'claim'
type TxState = {
    plans: TxPlan[]
    index: number
    stage: 'prepare' | 'confirm' | 'sending' | 'mining'
    fees?: FeeInfo
    stuck?: number
    hash?: `0x${string}`
}
type Prompt = { question: string; resolve: (line: string) => void }
type Notice = { text: string; color?: string }

// Header + action overlay: idle it renders the compact staking line above
// whatever screen is up; when the votes screen deep-links an action (s/u/c)
// it takes over with the amount input / claim submenu / tx runner, then
// returns via onDone. Always mounted, so the snapshot and the fallback prompt
// bridge survive across screens. `refreshTick` bumps re-fetch the snapshot
// (votes screen r).
function StakingOverlay({ voter, active, header, pendingAction, refreshTick, onDone }: { voter: `0x${string}`; active: boolean; header: boolean; pendingAction?: 'stake' | 'unstake' | 'claim'; refreshTick: number; onDone: () => void }) {
    const [snap, setSnap] = useState<StakingSnapshot | undefined>()
    const [snapError, setSnapError] = useState<string | undefined>()
    const [refreshing, setRefreshing] = useState(false)
    // undefined = subgraph still loading, null = unavailable (fetch failed)
    const [voteCount, setVoteCount] = useState<number | null | undefined>()
    const [view, setView] = useState<View>('dash')
    const [buf, setBuf] = useState('')
    const [amountError, setAmountError] = useState<string | undefined>()
    const [tx, setTx] = useState<TxState | undefined>()
    const [notice, setNotice] = useState<Notice | undefined>()
    const [notes, setNotes] = useState<string[]>([])
    const [prompt, setPrompt] = useState<Prompt | undefined>()
    const [promptBuf, setPromptBuf] = useState('')
    const [frame, setFrame] = useState(0)
    const busyRef = useRef(false)
    const confirmRef = useRef<((ok: boolean) => void) | undefined>(undefined)

    // The bridge: signer prompts (pairing codes, retries) render inline while
    // the dashboard is mounted instead of tearing frames with raw stdout
    useEffect(() => {
        setPromptBridge({
            ask: question => new Promise(resolve => { setPromptBuf(''); setPrompt({ question, resolve }) }),
            note: text => setNotes(n => [...n, text]),
        })
        return () => setPromptBridge(undefined)
    }, [])

    // 1s tick: countdowns + "refreshed Ns ago"; faster while a spinner shows
    const spinning = tx !== undefined && tx.stage !== 'confirm'
    useEffect(() => {
        const iv = setInterval(() => setFrame(f => f + 1), spinning ? 120 : 1000)
        return () => clearInterval(iv)
    }, [spinning])

    const refresh = async () => {
        setRefreshing(true)
        try {
            setSnap(await fetchDashboard(voter))
            setSnapError(undefined)
        } catch (e) {
            setSnapError(sanitizeText(((e as Error).message ?? String(e)).split('\n')[0]))
        }
        setRefreshing(false)
        setVoteCount(await fetchVoteCount(voter) ?? null)
    }
    useEffect(() => { void refresh() }, [])
    useEffect(() => { if (refreshTick > 0) void refresh() }, [refreshTick])

    // Friendly identity: the voter's ENS name when a verified reverse record exists
    const [who, setWho] = useState(() => shortAddress(voter))
    useEffect(() => { ensName(voter).then(n => { if (n) setWho(n) }) }, [voter])

    // ---------- tx runner ----------

    // One plan at a time: fees + pending-nonce check + simulation → y/n confirm
    // → wallet signature → receipt. Chained plans (approve → stake) simulate
    // each step only after the previous receipt, so the stake simulation sees
    // the new allowance.
    const runFlow = async (plans: TxPlan[]) => {
        if (busyRef.current) return
        busyRef.current = true
        setNotice(undefined)
        setNotes([])
        try {
            for (let i = 0; i < plans.length; i++) {
                const plan = plans[i]
                setTx({ plans, index: i, stage: 'prepare' })
                const [fees, pending, latest] = await Promise.all([
                    computeFees(),
                    publicClient.getTransactionCount({ address: voter, blockTag: 'pending' }),
                    publicClient.getTransactionCount({ address: voter, blockTag: 'latest' }),
                ])
                await publicClient.simulateContract({
                    address: plan.address, abi: plan.abi as never, functionName: plan.functionName as never,
                    args: plan.args as never, account: voter,
                })
                setTx({ plans, index: i, stage: 'confirm', fees, stuck: Math.max(0, pending - latest) })
                const ok = await new Promise<boolean>(resolve => { confirmRef.current = resolve })
                confirmRef.current = undefined
                if (!ok) {
                    setTx(undefined)
                    setNotice({ text: 'Aborted — nothing sent.' })
                    return
                }
                // The quote can go stale while the user sits on the confirm —
                // a max fee below the CURRENT base guarantees a stuck tx that
                // also blocks later nonces. Abort with a re-run hint instead.
                const baseNow = (await publicClient.getBlock()).baseFeePerGas ?? 0n
                if (baseNow > fees.maxFeePerGas) {
                    setTx(undefined)
                    setNotice({ text: `⚠ Base fee rose to ${formatUnits(baseNow, 9)} gwei — above the quoted max ${formatUnits(fees.maxFeePerGas, 9)} gwei; nothing sent. Run the action again to re-quote.`, color: 'yellow' })
                    return
                }
                setTx({ plans, index: i, stage: 'sending', fees })
                // Lazy wallet connect: only the first send touches the signer
                const wallet = await getWallet()
                const walletAddr = getAddress(wallet.account.address)
                if (walletAddr !== voter) throw new Error(`${wallet.kind} account ${walletAddr} != dashboard voter ${voter} — wrong account selected.`)
                const hash = await wallet.client.writeContract({
                    address: plan.address, abi: plan.abi as never, functionName: plan.functionName as never,
                    args: plan.args as never, account: wallet.account, chain: wallet.client.chain,
                    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
                })
                recordSentTx(hash)
                setTx({ plans, index: i, stage: 'mining', fees, hash })
                const receipt = await publicClient.waitForTransactionReceipt({ hash })
                if (receipt.status !== 'success') throw new Error(`Transaction ${hash} REVERTED — the ${plan.label} did not take effect.`)
            }
            setTx(undefined)
            setNotice({ text: `✅ ${plans.map(p => p.label).join(', then ')} — confirmed.`, color: 'green' })
        } catch (e) {
            setTx(undefined)
            const err = e as Error & { shortMessage?: string }
            const msg = sanitizeText(err?.shortMessage ?? (err?.message ?? String(e)).split('\n')[0])
            if (/reject|declin|denied/i.test(msg)) {
                setNotice({ text: '🚫 Rejected on the wallet — nothing was sent.', color: 'red' })
            } else {
                const file = logErrorToFile(e)
                setNotice({ text: `❌ ${msg}`, color: 'red' })
                setNotes([`Full details: ${path.relative(process.cwd(), file)}`])
            }
        } finally {
            busyRef.current = false
            void refresh()
        }
    }

    // ---------- key actions ----------

    const openAmount = (v: 'stake' | 'unstake') => {
        setBuf('')
        setAmountError(undefined)
        setNotice(undefined)
        setView(v)
    }

    const submitAmount = () => {
        if (!snap) return
        const max = view === 'stake' ? snap.walletBalance : snap.staked
        if (!/^\d+(\.\d+)?$/.test(buf)) { setAmountError('Enter a number (digits and one dot).'); return }
        let amount: bigint
        try { amount = parseUnits(buf, 18) } catch { setAmountError('Too many decimals — UMA has 18.'); return }
        if (amount <= 0n) { setAmountError('Amount must be greater than 0.'); return }
        if (amount > max) { setAmountError(`Amount exceeds the maximum of ${formatUnits(max, 18)} UMA.`); return }
        const plans = view === 'stake'
            ? snap.allowance < amount
                ? [txApprove(snap.umaToken, amount), txStake(amount)]  // auto-chain the missing approval
                : [txStake(amount)]
            : [txRequestUnstake(amount)]
        setView('dash')
        void runFlow(plans)
    }

    const unstakeKey = () => {
        if (!snap) return
        if (snap.pendingUnstake === 0n) {
            if (snap.staked === 0n) { setNotice({ text: 'Nothing staked — nothing to unstake.' }); return }
            openAmount('unstake')
            return
        }
        const executableAt = new Date(Number(snap.unstakeExecutableAt) * 1000)
        if (Date.now() >= executableAt.getTime()) void runFlow([txExecuteUnstake()])
        else setNotice({ text: `Unstake of ${fmtUma(snap.pendingUnstake)} UMA is still cooling down — executable in ${fmtCountdown(executableAt)}.`, color: 'yellow' })
    }

    const claimKey = () => {
        if (!snap) return
        if (snap.rewards === 0n) { setNotice({ text: 'No unclaimed rewards.' }); return }
        setNotice(undefined)
        setView('claim')
    }

    // Deep-link from the votes screen: open the requested action as soon as
    // this overlay is active and the snapshot is available (the effect re-runs
    // when the snapshot lands, so a fresh session still deep-links)
    const consumed = useRef(false)
    useEffect(() => {
        if (!active) { consumed.current = false; return }
        if (consumed.current || !pendingAction || !snap || tx || busyRef.current) return
        consumed.current = true
        setNotice(undefined)
        if (pendingAction === 'stake') openAmount('stake')
        else if (pendingAction === 'unstake') unstakeKey()
        else claimKey()
    }, [active, pendingAction, snap, tx]) // tx: a deep-link parked behind an in-flight tx retries when it clears

    useInput((input, key) => {
        // Signer prompt (bridge ask) outranks everything — it only appears mid-send
        if (prompt) {
            if (key.return) {
                const p = prompt
                setPrompt(undefined)
                setPromptBuf('')
                p.resolve(promptBuf)
            }
            else if (key.backspace || key.delete) setPromptBuf(s => s.slice(0, -1))
            else if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab && !key.escape) setPromptBuf(s => s + input)
            return
        }
        // A tx in flight swallows every key (q included) except the y/n confirm
        if (tx) {
            if (tx.stage === 'confirm') {
                if (input === 'y') confirmRef.current?.(true)
                else if (input === 'n' || input === 'q' || key.escape) confirmRef.current?.(false)
            }
            return
        }
        if (view === 'stake' || view === 'unstake') {
            // digits go to the amount buffer, never to global keys
            if (key.return) submitAmount()
            else if (key.escape) { setView('dash'); onDone() }
            else if (key.backspace || key.delete) { setBuf(s => s.slice(0, -1)); setAmountError(undefined) }
            else if (/^[\d.]$/.test(input)) { setBuf(s => s + input); setAmountError(undefined) }
            return
        }
        if (view === 'claim') {
            if (input === 'w') { setView('dash'); void runFlow([txWithdrawRewards()]) }
            else if (input === 's') { setView('dash'); void runFlow([txWithdrawAndRestake()]) }
            else if (key.escape || input === 'c' || input === 'q') { setView('dash'); onDone() }
            return
        }
        // idle overlay: a result notice (or a snapshot wait) — any key returns
        onDone()
    }, { isActive: active })

    // ---------- render ----------

    // The compact staking line, shown above every screen (except wallet) and
    // above the action overlay's own boxes
    const executableAt = snap ? new Date(Number(snap.unstakeExecutableAt) * 1000) : undefined
    const headerLine = snap && (
        <Box flexDirection="column">
            <Text dimColor> <Text color="cyan" bold>{who}</Text> · staked <Text color="cyan">{fmtUma(snap.staked)}</Text>/{fmtUma(snap.staked + snap.walletBalance)} UMA · unclaimed <Text color="cyan">{fmtUma(snap.rewards, 2)}</Text> · <Text color="green">{snap.aprPercent}%</Text> APR{voteCount ? <> · {voteCount} votes</> : null}{snap.pendingUnstake > 0n ? <Text color="yellow"> · unstake pending{Date.now() >= (executableAt?.getTime() ?? 0) ? ' (u executes)' : ''}</Text> : null}{refreshing ? ' · refreshing…' : ''}</Text>
            <Text dimColor> {'─'.repeat(10)}</Text>
        </Box>
    )

    // Idle under another screen: just the header (all hooks keep running, the
    // input handler is isActive-gated off)
    if (!active) return header ? (headerLine || null) : null

    const spin = <Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text>
    const noteBlocks = notes.map((text, i) => <Text key={i} dimColor wrap="wrap">{text}</Text>)

    if (tx) {
        const plan = tx.plans[tx.index]
        const step = tx.plans.length > 1 ? ` (step ${tx.index + 1}/${tx.plans.length})` : ''
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{plan.label}{step}</Text>
                <Text> </Text>
                {tx.stage === 'prepare' && <Text>{spin} resolving fees · checking pending transactions · simulating…</Text>}
                {tx.stage === 'confirm' && tx.fees && <>
                    <Text color="green">✓ Simulation OK</Text>
                    <Text>{describeFees(tx.fees)}</Text>
                    {feeWarning(tx.fees) && <Text color="yellow">{feeWarning(tx.fees)}</Text>}
                    {(tx.stuck ?? 0) > 0 && <Text color="yellow">⚠ {voter} has {tx.stuck} pending transaction(s) — this one will be QUEUED BEHIND them (Speed Up the stuck one in your wallet instead if it's fee-starved).</Text>}
                    <Text> </Text>
                    <Text dimColor>y send (wallet confirmation follows) · n cancel</Text>
                </>}
                {tx.stage === 'sending' && <>
                    <Text>{spin} waiting for the wallet — confirm the {plan.label} on your signer…</Text>
                    {noteBlocks}
                    {prompt && <Text>{prompt.question}: <Text color="cyan">{maskBuf(prompt.question, promptBuf)}</Text><Text inverse> </Text></Text>}
                </>}
                {tx.stage === 'mining' && <>
                    <Text>Sent: <Text color="cyan">{linkifyUrls(`https://etherscan.io/tx/${tx.hash}`)}</Text></Text>
                    <Text>{spin} waiting for the receipt…</Text>
                </>}
            </Box>
        )
    }

    if (view === 'stake' || view === 'unstake') {
        const max = view === 'stake' ? snap!.walletBalance : snap!.staked
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold>{view === 'stake' ? 'Stake UMA' : 'Request unstake'}</Text>
                {view === 'unstake' && <Text dimColor wrap="wrap">Requested tokens stop earning and unlock after the {fmtCountdown(new Date(Date.now() + Number(snap!.unstakeCoolDown) * 1000))} cooldown; execute with u once elapsed.</Text>}
                <Text>Amount (UMA, max {formatUnits(max, 18)}): <Text color="cyan">{buf}</Text><Text inverse> </Text></Text>
                {amountError && <Text color="red">⚠ {amountError}</Text>}
                {view === 'stake' && snap!.allowance < (parseSafe(buf) ?? 0n) && <Text dimColor>allowance too low — an approve transaction will be chained first</Text>}
                <Text dimColor>enter confirm · esc cancel</Text>
            </Box>
        )
    }

    // idle overlay: snapshot wait, the claim submenu, or a result notice
    return (
        <Box flexDirection="column">
            {headerLine}
            {!snap && !snapError && <Text> {spin} fetching staking data…</Text>}
            {snapError && <Text color="red"> ⚠ {snapError}</Text>}
            {notice && <Text color={notice.color}> {notice.text}</Text>}
            {noteBlocks.length > 0 && <Box flexDirection="column" paddingLeft={1}>{noteBlocks}</Box>}
            {view === 'claim'
                ? <Text> claim {fmtUma(snap!.rewards, 4)} UMA: <Text bold>w</Text> to wallet · <Text bold>s</Text> claim & stake · <Text dimColor>esc cancel</Text></Text>
                : (snap || snapError) ? <Text dimColor> any key → back to votes</Text> : null}
        </Box>
    )
}

// Amount buffer → wei, or undefined while the input is incomplete/invalid
function parseSafe(buf: string): bigint | undefined {
    if (!/^\d+(\.\d+)?$/.test(buf)) return undefined
    try { return parseUnits(buf, 18) } catch { return undefined }
}

// Screen router. The votes screen IS the app root (phase-aware: commit review
// during commit phase, live/past results otherwise) — q/esc there quits the
// app. There is no separate dashboard screen: the StakingOverlay renders the
// compact staking header above every screen except wallet, and takes over
// transiently when the votes screen deep-links an action (s stake, u unstake,
// c claim); w/R route to the wallet/reveal screens and return to votes.
// ExplorerOpts (current round + phase) are fetched from the contract at
// startup, then rolled over locally at every phase boundary — round and phase
// are pure time functions, so a long-running app never goes stale.
export function UmaApp({ voter }: { voter: `0x${string}` }) {
    const { exit } = useApp()
    const [screen, setScreen] = useState<'votes' | 'action' | 'reveal' | 'wallet' | 'about'>('votes')
    const [opts, setOpts] = useState<ExplorerOpts | undefined>()
    const [optsError, setOptsError] = useState<string | undefined>()
    const [pendingAction, setPendingAction] = useState<'stake' | 'unstake' | 'claim' | undefined>()
    const [refreshTick, setRefreshTick] = useState(0)
    const optsLoading = useRef(false)

    const fetchOpts = () => {
        if (optsLoading.current) return
        optsLoading.current = true
        setOptsError(undefined)
        Promise.all([getCurrentRoundId(), getVotePhase()])
            .then(([currentRound, phase]) => setOpts({ startRound: currentRound, currentRound, phase }))
            .catch(e => setOptsError(sanitizeText(((e as Error).message ?? String(e)).split('\n')[0])))
            .finally(() => { optsLoading.current = false })
    }
    useEffect(() => { fetchOpts() }, [])

    // Phase-boundary rollover (00:00 UTC): recompute round/phase locally so
    // the app flips reveal→commit (and gains the new round) without a restart.
    // Each update re-arms the timer for the next boundary.
    useEffect(() => {
        if (!opts) return
        const t = setTimeout(
            () => setOpts(o => o && { ...o, currentRound: derivedRoundId(), phase: derivedPhase() }),
            phaseEndsAt().getTime() - Date.now() + 2000,
        )
        return () => clearTimeout(t)
    }, [opts])

    // Loader keys — only active on the votes screen before opts resolve,
    // when neither the overlay nor the votes screen is listening
    useInput((input, key) => {
        if (input === 'q' || key.escape) exit()
        else if (input === 'r' && optsError) fetchOpts()
    }, { isActive: screen === 'votes' && !opts })

    return (
        <>
            <StakingOverlay voter={voter} active={screen === 'action'} header={screen !== 'wallet'} pendingAction={pendingAction} refreshTick={refreshTick}
                onDone={() => { setPendingAction(undefined); setScreen('votes') }} />
            {screen === 'reveal' && <RevealScreen onExit={() => setScreen('votes')} />}
            {screen === 'wallet' && <WalletScreen onExit={() => setScreen('votes')} />}
            {screen === 'about' && <AboutScreen onExit={() => setScreen('votes')} />}
            {/* Mounted once opts exist and kept alive across screens — cursor,
                round data and the commit flow all survive a detour through an
                action/wallet/reveal screen and re-render instantly on return */}
            {opts && <VotesScreen active={screen === 'votes'} opts={opts} onExit={exit} onAction={a => {
                if (a === 'wallet') setScreen('wallet')
                else if (a === 'reveal') setScreen('reveal')
                else if (a === 'about') setScreen('about')
                else if (a === 'refresh') setRefreshTick(t => t + 1)   // no screen switch — header refetch only
                else { setPendingAction(a); setScreen('action') }
            }} />}
            {screen === 'votes' && !opts && (optsError
                ? <Text color="red"> ⚠ {optsError} — r retry · q/esc quit</Text>
                : <Text dimColor> fetching current round…</Text>)}
        </>
    )
}

// Full-screen dashboard; resolves when the user quits. The prompt bridge is
// always unregistered so later readline prompts in the process are unaffected.
export async function runUmaDashboard(voter: `0x${string}`): Promise<void> {
    const app = render(<UmaApp voter={voter} />, { exitOnCtrlC: true })
    try {
        await app.waitUntilExit()
    } finally {
        app.clear()   // Ink leaves the last frame (the staking header) in the terminal otherwise
        setPromptBridge(undefined)
    }
}
