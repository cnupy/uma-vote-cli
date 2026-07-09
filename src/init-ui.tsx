// Full-screen init wizard (Ink). Shown by `nub run init` on a TTY: arrow-key
// signer picker, connector questions, live connection test with a spinner,
// then a .env summary + confirm. While mounted it registers itself as the
// prompt bridge, so every ask()/note() from init code or the signer backends
// (pairing codes, device-retry loops, the WalletConnect QR) renders inline
// instead of tearing frames with raw stdout writes.
import React, { useEffect, useRef, useState } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { setPromptBridge } from './signers/prompt'
import type { SignerKind } from './signers'

export type WizardDeps = {
    current: string
    kinds: readonly SignerKind[]
    descriptions: Record<SignerKind, string>
    nextSteps: string
    askSettings: (kind: SignerKind) => Promise<Record<string, string>>
    connect: (kind: SignerKind, updates: Record<string, string>) => Promise<`0x${string}`>
    askPin: (updates: Record<string, string>, address: `0x${string}`) => Promise<void>
    writeEnv: (updates: Record<string, string>) => void
}

// saved = .env written · aborted = user quit, nothing saved · failed = connection error, nothing saved
export type WizardOutcome = 'saved' | 'aborted' | 'failed'

type Step = 'pick' | 'config' | 'test' | 'confirm' | 'done' | 'error'
type Prompt = { question: string; resolve: (line: string) => void }

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function App({ deps, onDone }: { deps: WizardDeps; onDone: (outcome: WizardOutcome) => void }) {
    const { exit } = useApp()
    const [step, setStep] = useState<Step>('pick')
    const [cursor, setCursor] = useState(() => Math.max(0, deps.kinds.indexOf(deps.current as SignerKind)))
    const [kind, setKind] = useState<SignerKind>(deps.kinds[0])
    const [notes, setNotes] = useState<string[]>([])
    const [prompt, setPrompt] = useState<Prompt | undefined>()
    const [buf, setBuf] = useState('')
    const [error, setError] = useState('')
    const [address, setAddress] = useState<`0x${string}`>()
    const [elapsed, setElapsed] = useState(0)
    const [frame, setFrame] = useState(0)
    const updatesRef = useRef<Record<string, string>>({})

    // The bridge: ask() renders as the inline input below, note() as a Text block
    useEffect(() => {
        setPromptBridge({
            ask: question => new Promise(resolve => { setBuf(''); setPrompt({ question, resolve }) }),
            note: text => setNotes(n => [...n, text]),
        })
        return () => setPromptBridge(undefined)
    }, [])

    // Spinner + elapsed counter while the connection test runs
    useEffect(() => {
        if (step !== 'test') return
        setElapsed(0)
        const startedAt = Date.now()
        const timer = setInterval(() => {
            setElapsed(Math.floor((Date.now() - startedAt) / 1000))
            setFrame(f => f + 1)
        }, 120)
        return () => clearInterval(timer)
    }, [step])

    const fail = (e: unknown) => {
        setPrompt(undefined)
        setError((e as Error).message)
        setStep('error')
    }

    // Test uses the settings already collected, so error-screen retry re-tests
    // without re-asking the questions
    const test = async (k: SignerKind) => {
        setNotes([])
        setAddress(undefined)
        setStep('test')
        try {
            const addr = await deps.connect(k, updatesRef.current)
            setAddress(addr)
            setNotes([])    // drop pairing/QR chatter; keep post-connect notes for the confirm screen
            await deps.askPin(updatesRef.current, addr)
            setStep('confirm')
        } catch (e) { fail(e) }
    }

    const start = (k: SignerKind) => {
        setKind(k)
        setNotes([])
        setError('')
        setStep('config')
        void (async () => {
            try {
                updatesRef.current = await deps.askSettings(k)
                await test(k)
            } catch (e) { fail(e) }
        })()
    }

    useInput((input, key) => {
        if (prompt) {
            if (key.return) {
                const p = prompt
                setPrompt(undefined)
                p.resolve(buf)
            }
            else if (key.backspace || key.delete) setBuf(s => s.slice(0, -1))
            else if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab && !key.escape) setBuf(s => s + input)
            return
        }
        if (step === 'pick') {
            if (key.upArrow) setCursor(c => Math.max(0, c - 1))
            else if (key.downArrow) setCursor(c => Math.min(deps.kinds.length - 1, c + 1))
            else if (key.return) start(deps.kinds[cursor])
            else if (input === 'q' || key.escape) { onDone('aborted'); exit() }
            return
        }
        if (step === 'error') {
            if (input === 'r') void test(kind)
            else if (input === 'p') { setNotes([]); setStep('pick') }
            else if (input === 'q' || key.escape) { onDone('failed'); exit() }
            return
        }
        if (step === 'confirm') {
            if (key.return || input === 'y') {
                try { deps.writeEnv(updatesRef.current); setStep('done') } catch (e) { fail(e) }
            }
            else if (input === 'q' || input === 'n' || key.escape) { onDone('aborted'); exit() }
            return
        }
        if (step === 'done') { onDone('saved'); exit() }
    })

    const promptLine = prompt && (
        <Text>{prompt.question}: <Text color="cyan">{buf}</Text><Text inverse> </Text></Text>
    )
    const noteBlocks = notes.map((text, i) => <Text key={i}>{text}</Text>)

    if (step === 'pick') return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>uma-vote-cli signer setup — current signer: {deps.current}</Text>
            <Text> </Text>
            {deps.kinds.map((k, i) => (
                <Text key={k} inverse={i === cursor} wrap="truncate-end">
                    {i === cursor ? ' › ' : '   '}<Text bold color={k === deps.current ? 'cyan' : undefined}>{k.padEnd(14)}</Text>{deps.descriptions[k]}
                </Text>
            ))}
            <Text> </Text>
            <Text dimColor> ↑↓ move · enter select · q quit</Text>
        </Box>
    )
    if (step === 'config') return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>Configure {kind}</Text>
            <Text dimColor>{deps.descriptions[kind]}</Text>
            <Text> </Text>
            {noteBlocks}
            {promptLine}
            {prompt && <Text dimColor>enter accept (empty = keep the [default])</Text>}
        </Box>
    )
    if (step === 'test') return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>Connecting via {kind}...</Text>
            {address && <Text color="green">✓ Connected. Account: {address}</Text>}
            <Text> </Text>
            {noteBlocks}
            {prompt
                ? promptLine
                : <Text><Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text> waiting for the device / wallet… <Text dimColor>{elapsed}s</Text></Text>}
        </Box>
    )
    if (step === 'error') return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold color="red">❌ {kind} connection failed</Text>
            <Text> </Text>
            <Text wrap="wrap">{error}</Text>
            <Text> </Text>
            <Text dimColor>Nothing was saved.</Text>
            <Text dimColor> r retry · p pick another signer · q quit</Text>
        </Box>
    )
    if (step === 'confirm') return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text color="green">✓ Connected. Account: {address}</Text>
            {noteBlocks}
            <Text> </Text>
            <Text bold>Will write to .env:</Text>
            {Object.entries(updatesRef.current).map(([key, value]) => <Text key={key}>   {key}=<Text color="cyan">{value}</Text></Text>)}
            <Text> </Text>
            <Text dimColor> enter/y save · q quit without saving</Text>
        </Box>
    )
    // done
    return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold color="green">✅ Saved to .env:</Text>
            {Object.entries(updatesRef.current).map(([key, value]) => <Text key={key}>   {key}={value}</Text>)}
            <Text> </Text>
            <Text wrap="wrap">{deps.nextSteps}</Text>
            <Text> </Text>
            <Text dimColor> press any key to exit</Text>
        </Box>
    )
}

// Resolves once the wizard exits; the bridge is always unregistered so later
// readline prompts in the same process are unaffected.
export async function runInitWizard(deps: WizardDeps): Promise<WizardOutcome> {
    let outcome: WizardOutcome = 'aborted'
    const app = render(<App deps={deps} onDone={o => { outcome = o }} />, { exitOnCtrlC: true })
    try {
        await app.waitUntilExit()
    } finally {
        setPromptBridge(undefined)
    }
    return outcome
}
