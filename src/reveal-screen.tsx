// In-app reveal flow (Ink). Mounted by the uma dashboard on R: immediately
// runs the extracted reveal pipeline, streaming its output into a scrolling
// log panel (last 16 lines, "▲ N more" above). While mounted it owns the
// prompt bridge — signer prompts and the pending-tx y/N confirm render as an
// inline input line — saving whatever bridge was registered before (the
// hidden dashboard's, whose prompts would render nowhere) and restoring it on
// unmount. Keys are ignored while the flow runs except input for an active
// bridge prompt; once done (or failed), any key returns home. The standalone
// `nub run reveal` path is untouched.
import path from 'node:path'
import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { logErrorToFile, sanitizeText } from './common'
import { setPromptBridge, getPromptBridge } from './signers/prompt'
import { runRevealFlow } from './flows/reveal-flow'
import { SPINNER, maskBuf, linkifyUrls, isQrBlock } from './tui'
import type { OutputSink } from './flows/sink'

const WINDOW = 16

// The flow's lines may carry ANSI colors (diff-table style escapes) — ink does
// its own styling, so drop them for a consistent panel. sanitizeText then
// strips any remaining control chars (crafted titles) — belt and braces.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

type Prompt = { question: string; resolve: (line: string) => void }
type Outcome =
    | { kind: 'done'; code: number }
    | { kind: 'error'; message: string; logFile?: string }

export function RevealScreen({ onExit }: { onExit: () => void }) {
    const [lines, setLines] = useState<string[]>([])
    const [outcome, setOutcome] = useState<Outcome | undefined>()
    const [prompt, setPrompt] = useState<Prompt | undefined>()
    const [promptBuf, setPromptBuf] = useState('')
    const [frame, setFrame] = useState(0)
    // A pairing QR renders full-height in its own slot — the tailed log
    // window would cut it in half. Flow progress (a sink line) clears it.
    const [qr, setQr] = useState<string[] | undefined>()

    const append = (line: string, fromSink = false) => {
        if (fromSink) setQr(undefined)
        else if (isQrBlock(line)) { setQr(sanitizeText(stripAnsi(line)).split('\n')); return }
        setLines(prev => [...prev, ...linkifyUrls(sanitizeText(stripAnsi(line))).split('\n')])
    }

    // Own the prompt bridge while mounted: the dashboard stays mounted (hidden)
    // underneath with its bridge registered, and its prompts would render on
    // the invisible screen — so save it and restore it on unmount.
    useEffect(() => {
        const previous = getPromptBridge()
        setPromptBridge({
            ask: question => new Promise(resolve => { setPromptBuf(''); setPrompt({ question, resolve }) }),
            note: text => append(text),
        })
        return () => setPromptBridge(previous)
    }, [])

    // Spinner while the flow runs
    const running = outcome === undefined
    useEffect(() => {
        if (!running) return
        const iv = setInterval(() => setFrame(f => f + 1), 120)
        return () => clearInterval(iv)
    }, [running])

    // Kick off the flow immediately; not dry-run, not forced — the in-app path
    // mirrors a plain `nub run reveal`. Signer/RPC errors propagate as throws:
    // first line rendered friendly, full details to the error log file.
    useEffect(() => {
        const sink: OutputSink = { log: l => append(l, true), warn: l => append(l, true), error: l => append(l, true) }
        runRevealFlow({ dryRun: false, force: false, out: sink })
            .then(code => setOutcome({ kind: 'done', code }))
            .catch(e => {
                setPrompt(undefined)
                const err = e as Error & { shortMessage?: string }
                const msg = sanitizeText(err?.shortMessage ?? (err?.message ?? String(e)).split('\n')[0])
                if (/reject|declin|denied/i.test(msg)) {
                    setOutcome({ kind: 'error', message: '🚫 Rejected on the wallet — nothing was sent.' })
                } else {
                    setOutcome({ kind: 'error', message: `❌ ${msg}`, logFile: path.relative(process.cwd(), logErrorToFile(e)) })
                }
            })
    }, [])

    useInput((input, key) => {
        // Bridge prompt (pending-tx confirm, pairing codes) outranks everything
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
        // Flow in flight: every other key is ignored (no way to abandon a
        // signer mid-request without leaving it confused)
        if (running) return
        // Done or failed: any key returns home
        onExit()
    })

    // While a pairing QR is up it owns the frame — shrink the log tail so the
    // whole code stays scannable on a normal-height terminal
    const shown = lines.slice(-(qr ? 3 : WINDOW))
    const hidden = lines.length - shown.length
    return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>
                {running
                    ? <><Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text> revealing…</>
                    : outcome.kind === 'done'
                        ? <Text color={outcome.code === 0 ? 'green' : 'yellow'}>{outcome.code === 0 ? 'reveal — done' : 'reveal — finished with problems (see above)'}</Text>
                        : <Text color="red">reveal — failed</Text>}
            </Text>
            {qr && qr.map((l, i) => <Text key={`q${i}`}>{l || ' '}</Text>)}
            <Text dimColor>{hidden > 0 ? `▲ ${hidden} more` : '─'.repeat(10)}</Text>
            {shown.map((l, i) => <Text key={hidden + i} wrap="truncate-end">{l || ' '}</Text>)}
            {prompt && <Text>{prompt.question}: <Text color="cyan">{maskBuf(prompt.question, promptBuf)}</Text><Text inverse> </Text></Text>}
            {outcome?.kind === 'error' && <>
                <Text> </Text>
                <Text color="red" wrap="wrap">{outcome.message}</Text>
                {outcome.logFile && <Text dimColor>Full details: {outcome.logFile}</Text>}
            </>}
            {!running && <>
                <Text> </Text>
                <Text dimColor>any key → back</Text>
            </>}
        </Box>
    )
}
