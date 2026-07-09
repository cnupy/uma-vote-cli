// Full-screen staking & rewards dashboard (Ink). Shown by `nub run uma` on a
// TTY: staking / votes / rewards blocks, then stake (s), unstake (u) and claim
// (c) as in-TUI transaction flows — fees, pending-tx warning, simulation, y/n
// confirm, wallet signature (signer prompts render inline via the prompt
// bridge), receipt spinner, refresh. Read-only until an action needs the
// signer; the wallet is only connected at the first send.
import path from 'node:path'
import React, { useEffect, useRef, useState } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { formatUnits, parseUnits, getAddress } from 'viem'
import { publicClient, getWallet, computeFees, describeFees, fmtCountdown, logErrorToFile, type FeeInfo } from './common'
import { setPromptBridge } from './signers/prompt'
import {
    fetchDashboard, fetchVoteCount, txApprove, txStake, txRequestUnstake,
    txExecuteUnstake, txWithdrawRewards, txWithdrawAndRestake,
    type StakingSnapshot, type TxPlan,
} from './staking'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

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

function App({ voter }: { voter: `0x${string}` }) {
    const { exit } = useApp()
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
            setSnapError(((e as Error).message ?? String(e)).split('\n')[0])
        }
        setRefreshing(false)
        setVoteCount(await fetchVoteCount(voter) ?? null)
    }
    useEffect(() => { void refresh() }, [])

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
                setTx({ plans, index: i, stage: 'mining', fees, hash })
                const receipt = await publicClient.waitForTransactionReceipt({ hash })
                if (receipt.status !== 'success') throw new Error(`Transaction ${hash} REVERTED — the ${plan.label} did not take effect.`)
            }
            setTx(undefined)
            setNotice({ text: `✅ ${plans.map(p => p.label).join(', then ')} — confirmed.`, color: 'green' })
        } catch (e) {
            setTx(undefined)
            const err = e as Error & { shortMessage?: string }
            const msg = err?.shortMessage ?? (err?.message ?? String(e)).split('\n')[0]
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

    useInput((input, key) => {
        // Signer prompt (bridge ask) outranks everything — it only appears mid-send
        if (prompt) {
            if (key.return) {
                const p = prompt
                setPrompt(undefined)
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
            else if (key.escape) setView('dash')
            else if (key.backspace || key.delete) { setBuf(s => s.slice(0, -1)); setAmountError(undefined) }
            else if (/^[\d.]$/.test(input)) { setBuf(s => s + input); setAmountError(undefined) }
            return
        }
        if (view === 'claim') {
            if (input === 'w') { setView('dash'); void runFlow([txWithdrawRewards()]) }
            else if (input === 's') { setView('dash'); void runFlow([txWithdrawAndRestake()]) }
            else if (key.escape || input === 'c' || input === 'q') setView('dash')
            return
        }
        // dash
        if (input === 'q' || key.escape) exit()
        else if (input === 'r') { setNotice(undefined); void refresh() }
        else if (input === 's' && snap) openAmount('stake')
        else if (input === 'u') unstakeKey()
        else if (input === 'c') claimKey()
    })

    // ---------- render ----------

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
                    {tx.fees.maxFeePerGas < tx.fees.baseFee && <Text color="yellow">⚠ max fee is below the current base fee — the tx will wait until base fee drops.</Text>}
                    {(tx.stuck ?? 0) > 0 && <Text color="yellow">⚠ {voter} has {tx.stuck} pending transaction(s) — this one will be QUEUED BEHIND them (Speed Up the stuck one in your wallet instead if it's fee-starved).</Text>}
                    <Text> </Text>
                    <Text dimColor>y send (wallet confirmation follows) · n cancel</Text>
                </>}
                {tx.stage === 'sending' && <>
                    <Text>{spin} waiting for the wallet — confirm the {plan.label} on your signer…</Text>
                    {noteBlocks}
                    {prompt && <Text>{prompt.question}: <Text color="cyan">{promptBuf}</Text><Text inverse> </Text></Text>}
                </>}
                {tx.stage === 'mining' && <>
                    <Text>Sent: <Text color="cyan">https://etherscan.io/tx/{tx.hash}</Text></Text>
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

    // dash (the claim submenu renders inline on it)
    const total = snap ? snap.staked + snap.walletBalance : 0n
    const executableAt = snap ? new Date(Number(snap.unstakeExecutableAt) * 1000) : undefined
    const freshness = snap ? `refreshed ${Math.max(0, Math.floor((Date.now() - snap.fetchedAt) / 1000))}s ago` : ''
    return (
        <Box flexDirection="column">
            <Text bold> UMA staking & rewards — {voter}{freshness ? <Text dimColor>  {freshness}{refreshing ? ' · refreshing…' : ''}</Text> : null}</Text>
            <Text dimColor> {'─'.repeat(10)}</Text>
            {!snap && !snapError && <Box paddingY={1}><Text> {spin} fetching staking data…</Text></Box>}
            {snapError && <Text color="red"> ⚠ {snapError} — r to retry</Text>}
            {snap && <>
                <Text> <Text bold>STAKING</Text>   You are staking <Text color="cyan" bold>{fmtUma(snap.staked)}</Text> of {fmtUma(total)} UMA</Text>
                {snap.pendingUnstake > 0n && (
                    <Text>           pending unstake: <Text color="yellow">{fmtUma(snap.pendingUnstake)} UMA</Text> — {Date.now() >= executableAt!.getTime()
                        ? <Text color="green">executable now (press u)</Text>
                        : <>executable in {fmtCountdown(executableAt!)}</>}</Text>
                )}
                <Text> <Text bold>VOTES</Text>     voted in <Text color="cyan" bold>{voteCount === undefined ? '…' : voteCount === null ? 'unavailable' : voteCount}</Text> votes · earning <Text color="green" bold>{snap.aprPercent}%</Text> APR</Text>
                <Text> <Text bold>REWARDS</Text>   unclaimed: <Text color="cyan" bold>{fmtUma(snap.rewards, 4)} UMA</Text></Text>
            </>}
            <Text> </Text>
            {notice && <Text color={notice.color}> {notice.text}</Text>}
            {noteBlocks.length > 0 && <Box flexDirection="column" paddingLeft={1}>{noteBlocks}</Box>}
            {view === 'claim'
                ? <Text> claim {fmtUma(snap!.rewards, 4)} UMA: <Text bold>w</Text> to wallet · <Text bold>s</Text> claim & stake · <Text dimColor>esc cancel</Text></Text>
                : <Text dimColor> s stake · u unstake · c claim · r refresh · q quit</Text>}
        </Box>
    )
}

// Amount buffer → wei, or undefined while the input is incomplete/invalid
function parseSafe(buf: string): bigint | undefined {
    if (!/^\d+(\.\d+)?$/.test(buf)) return undefined
    try { return parseUnits(buf, 18) } catch { return undefined }
}

// Full-screen dashboard; resolves when the user quits. The prompt bridge is
// always unregistered so later readline prompts in the process are unaffected.
export async function runUmaDashboard(voter: `0x${string}`): Promise<void> {
    const app = render(<App voter={voter} />, { exitOnCtrlC: true })
    try {
        await app.waitUntilExit()
    } finally {
        setPromptBridge(undefined)
    }
}
