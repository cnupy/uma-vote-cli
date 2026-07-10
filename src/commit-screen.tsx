// Embedded commit pipeline (Ink). Opened from the uma dashboard with C: the
// full commit flow (addon verification gates → answers pull → interactive
// review → salts → sign → send) runs inside the dashboard's Ink root instead
// of the standalone `nub run commit` process. Pipeline output collects in a
// log panel; when the flow requests the review this screen hands the frame to
// CommitReview (which owns ALL input while mounted) and returns to the log
// panel once it resolves. Signer prompts render inline via this screen's own
// prompt bridge — the dashboard's is saved and restored on exit. Outside the
// commit phase the flow returns early with its message in the log, the
// expected state most of the day. Any key returns home once the flow ends.
//
// Embedded in the votes screen it gets two extra props: `active` (default
// true) hides the screen without unmounting it — the parked flow keeps
// running, the input handlers are isActive-gated off and the render is null
// (the review too stays mounted-hidden, so its edited answers survive) — so
// browsing past rounds and coming back doesn't restart the flow. The prompt
// bridge stays registered while mounted even when hidden: the only sibling
// shown instead (the results explorer) never asks for prompts, so nothing can
// be swallowed; a prompt raised while hidden renders as soon as the user
// returns. `onRoundNav`, when wired, claims [ ]/ctrl+←→ for round navigation
// in the log/done panel (instead of the any-key exit) and is forwarded to
// CommitReview, which honors it in every view except the custom-price input
// and the confirm modal (plain ←/→ is question navigation there).
import path from 'node:path'
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { logErrorToFile, sanitizeText } from './common'
import { setPromptBridge, getPromptBridge } from './signers/prompt'
import { runCommitFlow } from './flows/commit-flow'
import { CommitReview, type ReviewOpts, type ReviewOutcome } from './commit-ui'
import { SPINNER, roundNavDelta, maskBuf, linkifyUrls } from './tui'
import type { OutputSink } from './flows/sink'

const TAIL = 16   // log panel shows only the last lines, keeping the frame short

type Line = { text: string; color?: string }
type Prompt = { question: string; resolve: (line: string) => void }
type Review = { opts: ReviewOpts; resolve: (outcome: ReviewOutcome) => void }

// Sink output may span multiple physical lines; empty ones become spacers.
// sanitizeText: flow lines can quote attacker-controlled question titles.
// linkifyUrls (after sanitize): tx/PR links render ctrl+clickable.
const toLines = (text: string, color?: string): Line[] =>
    linkifyUrls(sanitizeText(text)).split('\n').map(t => ({ text: t, color }))

export function CommitScreen({ onExit, active = true, onRoundNav, onAbout }: { onExit: () => void; active?: boolean; onRoundNav?: (delta: -1 | 1) => void; onAbout?: () => void }) {
    const [lines, setLines] = useState<Line[]>([])
    const [review, setReview] = useState<Review | undefined>()
    const reviewRef = useRef<Review | undefined>(undefined)
    reviewRef.current = review
    const [prompt, setPrompt] = useState<Prompt | undefined>()
    const [promptBuf, setPromptBuf] = useState('')
    const [exitCode, setExitCode] = useState<number | undefined>()
    const [error, setError] = useState<string | undefined>()
    const [frame, setFrame] = useState(0)
    const [runId, setRunId] = useState(0)   // bumped by the done-panel restart key
    // Review quit via its exit guard: leave immediately when the flow winds
    // down — the guard was the confirmation, a second "aborted" stop is noise
    const abortedRef = useRef(false)

    const running = exitCode === undefined && error === undefined

    // Own prompt bridge: the dashboard's renders into a component that's hidden
    // while this screen is up. The previous bridge is restored on unmount so
    // signer prompts keep working back home.
    useEffect(() => {
        const prev = getPromptBridge()
        setPromptBridge({
            ask: question => new Promise(resolve => { setPromptBuf(''); setPrompt({ question, resolve }) }),
            note: text => setLines(l => [...l, ...toLines(text)]),
        })
        return () => {
            setPromptBridge(prev)
            // A rollover retires this screen (keyed by round) — unpark a
            // pending review so the orphaned flow winds down (persisting its
            // prefill) instead of waiting forever on the promise
            reviewRef.current?.resolve({ rows: reviewRef.current.opts.rows, confirmed: false })
        }
    }, [])

    // The flow, kicked off on mount and again on each restart (runId). The
    // review callback parks the flow on a promise and mounts CommitReview;
    // onDone resolves it and the flow continues (salts/sign/send) with its
    // output back in the log panel. A restarted flow prefills from the
    // answers the previous review saved (confirmed or aborted).
    useEffect(() => {
        const push = (color?: string) => (text: string) => setLines(l => [...l, ...toLines(text, color)])
        const out: OutputSink = { log: push(), warn: push('yellow'), error: push('red') }
        runCommitFlow({
            dryRun: false, force: false, yes: false, interactive: true, out,
            review: opts => new Promise(resolve => setReview({ opts, resolve })),
        }).then(code => {
            if (abortedRef.current) { onExit(); return }
            setExitCode(code)
        }).catch(e => {
            const err = e as Error & { shortMessage?: string }
            const msg = sanitizeText(err?.shortMessage ?? (err?.message ?? String(e)).split('\n')[0])
            if (/reject|declin|denied/i.test(msg)) {
                setError('🚫 Rejected on the wallet — nothing was sent.')
            } else {
                const file = logErrorToFile(e)
                setError(`❌ ${msg}`)
                setLines(l => [...l, { text: `Full details: ${path.relative(process.cwd(), file)}`, color: 'gray' }])
            }
        })
    }, [runId])

    const spinning = running && !review && !prompt
    useEffect(() => {
        if (!spinning) return
        const iv = setInterval(() => setFrame(f => f + 1), 120)
        return () => clearInterval(iv)
    }, [spinning])

    // While the review is mounted its own (unconditional) useInput is the only
    // consumer — this handler goes inactive so keys aren't double-handled.
    useInput((input, key) => {
        // A pending bridge prompt (signer pairing codes, retries) owns the keys
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
        // Votes-screen round navigation: from the log/done panel [ ]/ctrl+←→
        // switch rounds instead of exiting (during the review the review's own
        // handler maps the same keys to the same onRoundNav)
        const delta = roundNavDelta(input, key)
        if (onRoundNav && delta) { onRoundNav(delta); return }
        // i = about, from the log/done panel only — never while a prompt is
        // typing (handled above) or the review owns the keys
        if (input === 'i' && onAbout) { onAbout(); return }
        if (running) return   // the flow is busy — swallow everything else
        // done or error: enter restarts the flow (an aborted review reopens
        // with its saved answers); q/esc leaves (with votes as the app root
        // that quits the app, so an accidental keypress must not)
        if (key.return) {
            abortedRef.current = false
            setLines([])
            setExitCode(undefined)
            setError(undefined)
            setRunId(id => id + 1)
        }
        else if (input === 'q' || key.escape) onExit()
    }, { isActive: active && !review })

    // The review stays mounted while hidden (active=false renders null inside)
    // so its edited answers survive a round trip to a past round and back
    if (review) return (
        <CommitReview opts={review.opts} active={active} onRoundNav={onRoundNav} onAbout={onAbout} onDone={outcome => {
            abortedRef.current = !outcome.confirmed
            const r = review
            setReview(undefined)
            r.resolve(outcome)
        }} />
    )

    // Hidden (votes screen showing a past round): the flow and bridge live on,
    // nothing renders
    if (!active) return null

    // Abort wind-down: the flow is saving the reviewed answers before onExit
    // fires (<100ms) — rendering the log panel here would flash and stick as
    // the terminal's final frame
    if (abortedRef.current) return null

    const tail = lines.slice(-TAIL)
    return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>Commit votes</Text>
            {lines.length > TAIL && <Text dimColor>▲ {lines.length - TAIL} earlier line(s)</Text>}
            {tail.map((l, i) => <Text key={i} color={l.color} wrap="wrap">{l.text || ' '}</Text>)}
            {running && !prompt && <Text><Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text> working…</Text>}
            {prompt && <Text>{prompt.question}: <Text color="cyan">{maskBuf(prompt.question, promptBuf)}</Text><Text inverse> </Text></Text>}
            {error && <Text color="red" wrap="wrap">{error}</Text>}
            {!running && <>
                <Text> </Text>
                <Text dimColor>{exitCode !== undefined && exitCode !== 0 ? '⚠ finished with problems (see above) · ' : ''}enter restart · {onRoundNav ? '[ ]/ctrl+←→ round · ' : ''}q/esc back</Text>
            </>}
        </Box>
    )
}
