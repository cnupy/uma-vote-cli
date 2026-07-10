// Interactive pre-commit review (Ink). Shown by `nub run commit` on a TTY unless
// --yes: scroll the round's requests, override answers (1-4 / custom), inspect
// each request's details, its decoded ancillary text and its Discord discussion,
// then confirm. The caller re-encodes prices from the returned answers and sends
// only what differs from the on-chain commitments.
import React, { useState, useEffect, useRef } from 'react'
import { render, Box, Text, useInput } from 'ink'
import { encodePrice, fmtCountdown, titleFromText } from './common'
import { priceLabel } from './compare'
import { fetchDiscordThread, flattenThread, type ThreadMessage } from './discord'
import { resolveAncillaryText, descriptionFromText, fetchAiSummary, mapLimit, type OutcomeSummary } from './resolve'
import { roundNavDelta, hyperlink, linkifyUrls, URL_RE, urlLabel } from './tui'

export type ReviewRow = {
    question: string
    needsTitle?: boolean        // placeholder question — real title resolved lazily via the dApp
    identifier: `0x${string}`
    identifierDecoded: string
    time: bigint
    ancillaryData: `0x${string}`
    answer: string              // planned answer; '' = unanswered (skipped on commit)
    sourceAnswer?: string       // as delivered by the answers source, for reference
    onchainPrice?: bigint       // your current on-chain commitment, if any
}

export type ReviewOpts = {
    roundId: number
    phaseEnd: Date
    rows: ReviewRow[]
    diffAvailable: boolean      // on-chain commitments were fetched (diff is trustworthy)
    force: boolean              // --force: every answered row is sent, diff or not
    // Answers-source output (pull progress, provenance, trust warnings) — the
    // review keeps the warning lines on screen and shows the rest behind `p`
    notices?: string[]
}

// The rows come back on abort too, so the flow can persist edited answers
// either way — quitting the review must not lose the selections
export type ReviewOutcome = { rows: ReviewRow[]; confirmed: boolean }

const WINDOW = 12
const QUESTION_WIDTH = 64
// Long text (description, AI summary, comment bodies) renders pre-wrapped in
// a TEXT_LINES-tall window scrolled line-by-line with ↑↓ — the whole text is
// reachable, while the Ink frame stays shorter than the terminal (a taller
// frame tears on redraw).
const TEXT_LINES = 14

// Word-wrap to a fixed width, preserving paragraph breaks; words longer than
// the width are hard-broken. Pre-wrapping (instead of Ink's wrap) is what
// makes line-exact windows possible.
const wrapLines = (text: string, width: number): string[] => {
    const lines: string[] = []
    for (const para of text.split('\n')) {
        let line = ''
        for (const word of para.split(/\s+/)) {
            if (!word) continue
            if (word.length > width) {
                if (line) lines.push(line)
                let i = 0
                for (; i + width < word.length; i += width) lines.push(word.slice(i, i + width))
                line = word.slice(i)
            }
            else if (!line) line = word
            else if (line.length + 1 + word.length <= width) line += ' ' + word
            else { lines.push(line); line = word }
        }
        lines.push(line)
    }
    // drop trailing blanks (trailing newlines would render as empty rows)
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
}

const answerColor = (a: string): string => {
    const n = a.trim().toLowerCase()
    if (n === '') return 'gray'
    if (['p1', 'no', 'false', 'invalid'].includes(n)) return 'red'
    if (['p2', 'yes', 'true', 'valid'].includes(n)) return 'green'
    if (n === 'p3') return 'yellow'
    if (n === 'p4') return 'magenta'
    return 'cyan'
}

const Legend = () => (
    <Text dimColor>
        {' '}<Text color="red">P1/no</Text> · <Text color="green">P2/yes</Text> · <Text color="yellow">P3 unknown/50-50</Text> · <Text color="magenta">P4 too early</Text> · <Text color="cyan">custom price</Text> · <Text color="gray">unanswered</Text>
    </Text>
)

const fmtUnix = (t: bigint) => `${t} (${new Date(Number(t) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC)`
const shortHex = (hex: string, n = 12) => hex.length > 2 * n ? `${hex.slice(0, n)}…${hex.slice(-6)}` : hex

// Decoded ancillary text for the "summary" view; undefined when it's binary/hash-only
const ancillaryText = (ancillaryData: `0x${string}`): string | undefined => {
    const text = Buffer.from(ancillaryData.slice(2), 'hex').toString('utf8')
    const printable = text.replace(/[^\x20-\x7E\n]/g, '')
    return printable.length > text.length * 0.9 ? printable : undefined
}

// Embeddable review: calls onDone({rows, confirmed}) — confirmed=false on quit
// instead of tearing down the Ink root, so a shell app can mount it inside its
// own render. Embedded in the votes screen it gets two extra props:
// `onRoundNav` claims [ ]/ctrl+←→ for round navigation in every view except
// the custom-price input (typing owns all keys) and the confirm modal (y/n/esc
// only) — standalone, without it, those keys do nothing, so bindings mean the
// same thing everywhere (plain ←/→ is always prev/next question). `active`
// (default true) hides the review without unmounting it — render null, input
// isActive-gated off — so edited answers survive a round trip to a past round.
export function CommitReview({ opts, onDone, onRoundNav, onAbout, active = true }: { opts: ReviewOpts; onDone: (outcome: ReviewOutcome) => void; onRoundNav?: (delta: 1 | -1) => void; onAbout?: () => void; active?: boolean }) {
    const [rows] = useState(() => opts.rows.map(r => ({ ...r })))
    const [cursor, setCursor] = useState(0)
    const [top, setTop] = useState(0)
    const [view, setView] = useState<'list' | 'details' | 'summary' | 'ai' | 'comments' | 'custom' | 'confirm' | 'exit' | 'provenance'>('list')
    const [commentIdx, setCommentIdx] = useState(0)
    const [customBuf, setCustomBuf] = useState('')
    // where the custom-price input was opened from, so enter/esc return there
    const [customFrom, setCustomFrom] = useState<'list' | 'details' | 'summary' | 'ai' | 'comments'>('list')
    // threads keyed by row index: undefined = not fetched, null = loading
    const [threads, setThreads] = useState<Record<number, ReturnType<typeof flattenThread> | null>>({})
    // summary view data per row: question text + AI summary (null = summary loading)
    const [docs, setDocs] = useState<Record<number, { text?: string; textDone?: boolean; summary?: OutcomeSummary[] | null }>>({})
    const [docScroll, setDocScroll] = useState(0)   // text scroll offset (lines)
    const maxScrollRef = useRef(0)                  // published by scrollText each render
    const [, force] = useState(0)

    // Placeholder questions (hash-only cross-chain requests with no answers file)
    // resolve to real titles in the background via the dApp; cached on disk
    useEffect(() => {
        let alive = true
        mapLimit(rows.filter(r => r.needsTitle), 5, async r => {
            const text = await resolveAncillaryText(r.identifier, r.time, r.ancillaryData)
            const title = text && titleFromText(text)
            if (title && alive) { r.question = title; r.needsTitle = false; force(x => x + 1) }
        })
        return () => { alive = false }
    }, [])

    // A different question, view or comment starts at the top of its text
    useEffect(() => { setDocScroll(0); maxScrollRef.current = 0 }, [cursor, view, commentIdx])

    // Lazy-load the summary view's description and the ai view's AI summary
    useEffect(() => {
        const i = cursor, r = rows[i]
        if (view === 'summary' && !docs[i]?.textDone) {
            resolveAncillaryText(r.identifier, r.time, r.ancillaryData)
                .then(t => setDocs(d => ({ ...d, [i]: { ...d[i], text: t, textDone: true } })))
        }
        if (view === 'ai' && docs[i]?.summary === undefined) {
            setDocs(d => ({ ...d, [i]: { ...d[i], summary: null } }))
            fetchAiSummary(r.time, r.identifierDecoded, r.question)
                .then(s => setDocs(d => ({ ...d, [i]: { ...d[i], summary: s ?? [] } })))
        }
    }, [view, cursor])

    const row = rows[cursor]
    const priceOf = (r: ReviewRow) => r.answer ? encodePrice(r.answer, r.identifierDecoded) : undefined
    const unanswered = (r: ReviewRow) => priceOf(r) === undefined
    // "will this send a tx": answered, and (no diff data | --force | differs from chain)
    const willSend = (r: ReviewRow) => {
        const p = priceOf(r)
        if (p === undefined) return false
        if (!opts.diffAvailable || opts.force) return true
        return r.onchainPrice === undefined || r.onchainPrice !== p
    }
    const sendCount = rows.filter(willSend).length
    const unansweredRows = rows.filter(unanswered)
    // Trust warnings from the answers source stay visible in the list and the
    // confirm modal — the log panel they originally printed to is covered by
    // this review. `p` shows the full source report.
    const notices = opts.notices ?? []
    // Case-sensitive: the trust vocabulary is uppercase in the sources —
    // /i would promote innocuous "differs from"-style info lines too
    const warnings = notices.filter(l => /⚠|❌|NOT verified|UNVERIFIED|NEW CONTRIBUTOR|DIFFER/.test(l))

    const fetchThread = (i: number) => {
        if (threads[i] !== undefined) return
        setThreads(t => ({ ...t, [i]: null }))
        const r = rows[i]
        fetchDiscordThread(r.time.toString(), r.identifierDecoded, r.question)
            .then(th => setThreads(t => ({ ...t, [i]: flattenThread(th) })))
    }
    const openComments = () => {
        setCommentIdx(0)
        setView('comments')
        fetchThread(cursor)
    }
    // clamped cursor move that keeps the list's scroll window showing it
    const moveCursor = (delta: number) => {
        const nc = Math.max(0, Math.min(rows.length - 1, cursor + delta))
        setCursor(nc)
        if (nc < top) setTop(nc)
        else if (nc >= top + WINDOW) setTop(nc - WINDOW + 1)
        return nc
    }
    // plain ←/→: prev/next question, staying in the current view
    const navQuestion = (delta: number) => {
        const nc = moveCursor(delta)
        if (view === 'comments') { setCommentIdx(0); fetchThread(nc) }
    }
    // 1-4 / v answer keys, identical in the list and every subview
    const answerKey = (input: string) => {
        if (/^[1-4]$/.test(input)) {
            if (row.identifierDecoded === 'YES_OR_NO_QUERY') row.answer = `P${input}`
            else if (input === '1') row.answer = 'no'
            else if (input === '2') row.answer = 'yes'
            else return false
            force(x => x + 1)
            return true
        }
        if (input === 'v') {
            setCustomBuf(/^-?\d+(\.\d+)?$/.test(row.answer) ? row.answer : '')
            setCustomFrom(view === 'details' || view === 'summary' || view === 'ai' || view === 'comments' ? view : 'list')
            setView('custom')
            return true
        }
        return false
    }
    // d/s/a/c open that subview for the same question; the current subview's
    // key toggles back. p (with notices) shows the answers-source report.
    const switchView = (input: string) => {
        if (input === 'd') { setView(view === 'details' ? 'list' : 'details'); return true }
        if (input === 's') { setView(view === 'summary' ? 'list' : 'summary'); return true }
        if (input === 'a') { setView(view === 'ai' ? 'list' : 'ai'); return true }
        if (input === 'c') { if (view === 'comments') setView('list'); else openComments(); return true }
        if (input === 'p' && notices.length > 0) { setView(view === 'provenance' ? 'list' : 'provenance'); return true }
        // i = about (embedded app only) — reachable from the list and the
        // subviews; the custom input and the modals never call switchView
        if (input === 'i' && onAbout) { onAbout(); return true }
        return false
    }

    useInput((input, key) => {
        if (view === 'custom') {
            // typing owns ALL keys — '[' and ctrl+arrows are inert here, no round nav
            if (key.return) {
                if (customBuf === '' || /^-?\d+(\.\d+)?$/.test(customBuf)) {
                    row.answer = customBuf
                    setView(customFrom); force(x => x + 1)
                }
            }
            else if (key.escape) setView(customFrom)
            else if (key.backspace || key.delete) setCustomBuf(s => s.slice(0, -1))
            else if (/^[\d.-]$/.test(input)) setCustomBuf(s => s + input)
            return
        }
        // [ ]/ctrl+←→ = prev/next ROUND everywhere except custom (above) and the
        // confirm modal (below) — only when the votes screen wires onRoundNav;
        // standalone these keys do nothing (bindings mean the same everywhere)
        const roundDelta = roundNavDelta(input, key)
        if (roundDelta !== 0 && view !== 'confirm' && view !== 'exit') { onRoundNav?.(roundDelta); return }
        if (view === 'provenance') {
            if (key.escape || input === 'p' || input === 'q') setView('list')
            return
        }
        if (view === 'details' || view === 'summary' || view === 'ai' || view === 'comments') {
            if (key.leftArrow || key.rightArrow) { navQuestion(key.leftArrow ? -1 : 1); return }
            if (answerKey(input)) return
            if (switchView(input)) return
            if (view === 'comments') {
                // pgup/pgdn step between comments; ↑↓ scroll inside the body
                const n = threads[cursor]?.length ?? 0
                if (key.pageUp && n > 0) { setCommentIdx(i => (i - 1 + n) % n); return }
                if (key.pageDown && n > 0) { setCommentIdx(i => (i + 1) % n); return }
            }
            if (view !== 'details') {
                // ↑↓ scroll long text one line at a time, clamped to the max
                // the render published — state must not count past the end
                if (key.upArrow) { setDocScroll(s => Math.max(0, s - 1)); return }
                if (key.downArrow) { setDocScroll(s => Math.min(maxScrollRef.current, s + 1)); return }
            }
            if (key.escape || input === 'q') setView('list')
            return
        }
        if (view === 'confirm') {
            if (input === 'y') onDone({ rows, confirmed: true })
            else if (key.escape || input === 'n' || input === 'q') setView('list')
            return
        }
        // quitting with votes that would send: commit first, leave anyway, or stay
        if (view === 'exit') {
            if (input === 'y' || key.return) setView('confirm')
            else if (input === 'q') onDone({ rows, confirmed: false })
            else if (key.escape || input === 'n') setView('list')
            return
        }
        // list view — plain ←/→ alias ↑/↓; pgup/pgdn page by a window
        if (key.upArrow || key.leftArrow) moveCursor(-1)
        else if (key.downArrow || key.rightArrow) moveCursor(1)
        else if (key.pageUp) moveCursor(-WINDOW)
        else if (key.pageDown) moveCursor(WINDOW)
        else if (answerKey(input)) { /* answered in place */ }
        else if (switchView(input)) { /* subview opened */ }
        else if (key.return) setView('details')            // enter = open details, like the results explorer
        else if (input === 'C') setView('confirm')         // dedicated commit shortcut
        else if (input === 'q' || key.escape) {
            // Leaving with uncommitted answers deserves a nudge — quitting is
            // one keypress away from the app root's quit
            if (sendCount > 0) setView('exit')
            else onDone({ rows, confirmed: false })
        }
    }, { isActive: active })

    // Hidden (votes screen showing a past round): state — cursor, edited
    // answers, the works — lives on, nothing renders and no keys are consumed
    if (!active) return null

    const roundHint = onRoundNav ? ' · [ ]/ctrl+←→ round' : ''

    // one-line question position + planned/on-chain status, shared by the
    // subviews so answering from summary/comments is visibly confirmed
    const statusLine = (
        <Text><Text dimColor>question {cursor + 1}/{rows.length} · </Text>planned: <Text color={answerColor(row.answer)}>{row.answer || 'UNANSWERED'}</Text> · on-chain: {row.onchainPrice !== undefined
            ? <Text color={answerColor(priceLabel(row.onchainPrice))}>{priceLabel(row.onchainPrice)}</Text>
            : <Text dimColor>not committed</Text>}</Text>
    )

    if (view === 'details') {
        const p = priceOf(row)
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{row.question}</Text>
                <Text dimColor>question {cursor + 1}/{rows.length}</Text>
                <Text> </Text>
                <Text>identifier:  <Text color="cyan">{row.identifierDecoded}</Text></Text>
                <Text>timestamp:   {fmtUnix(row.time)}</Text>
                <Text>ancillary:   {shortHex(row.ancillaryData, 24)} ({(row.ancillaryData.length - 2) / 2} bytes)</Text>
                <Text>source:      <Text color={answerColor(row.sourceAnswer ?? '')}>{row.sourceAnswer ?? '(no answer from source)'}</Text></Text>
                <Text>on-chain:    {row.onchainPrice !== undefined
                    ? <Text color={answerColor(priceLabel(row.onchainPrice))}>{priceLabel(row.onchainPrice)}</Text>
                    : <Text dimColor>{opts.diffAvailable ? 'not committed' : 'unknown (diff unavailable)'}</Text>}</Text>
                <Text>planned:     <Text color={answerColor(row.answer)}>{row.answer || 'UNANSWERED — will be skipped'}</Text>{p !== undefined ? <Text dimColor>  (price {p.toString()})</Text> : null}</Text>
                <Text> </Text>
                <Text dimColor>←→ prev/next question{roundHint} · 1-4 v answer · s summary · a AI · c comments · esc/d back</Text>
            </Box>
        )
    }
    // Shared line-scrolled text window (summary description, AI summary,
    // comment bodies): the WHOLE text is reachable one line at a time. The
    // render publishes the max offset so the ↓ handler clamps state instead
    // of counting past the end (which would need as many ↑ to come back).
    // Markers always render — appearing/disappearing lines resize the box.
    const textWidth = Math.max(40, (process.stdout.columns ?? 100) - 6)
    const scrollText = (text: string) => {
        // URLs become OSC 8 hyperlinks with a short single-line label: a raw
        // URL hard-wrapped across lines stops being ctrl+clickable in the
        // terminal. Tokenized BEFORE wrapping (a token is one unbreakable
        // ≤36-char word), converted to the escape per line AFTER windowing so
        // the wrapper never counts or splits the invisible escape bytes.
        const urls: string[] = []
        const tokenized = text.replace(/[\uE000\uE001]/g, '')   // markers can't be spoofed by the text itself
            .replace(URL_RE, u => `\uE000${urls.push(u) - 1};${urlLabel(u, 30)}\uE001`)
        const detokenize = (l: string) => l.replace(/\uE000(\d+);([^\uE001]*)\uE001/g, (_, i, label) => hyperlink(urls[+i], label))
        const lines = wrapLines(tokenized, textWidth)
        const maxOff = Math.max(0, lines.length - TEXT_LINES)
        maxScrollRef.current = maxOff
        const off = Math.min(docScroll, maxOff)
        return (
            <>
                <Text dimColor>▲ {off} more line(s) — ↑</Text>
                {lines.slice(off, off + TEXT_LINES).map((l, i) => <Text key={off + i}>{detokenize(l) || ' '}</Text>)}
                <Text dimColor>▼ {maxOff - off} more line(s) — ↓</Text>
            </>
        )
    }
    if (view === 'summary') {
        const doc = docs[cursor]
        const text = doc?.text ?? ancillaryText(row.ancillaryData)
        const description = text && (descriptionFromText(text) ?? text)
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{row.question}</Text>
                {statusLine}
                <Text> </Text>
                {description
                    ? scrollText(description)
                    : doc?.textDone
                        ? <Text dimColor wrap="wrap">Question text can't be resolved (old bridge format) — see the dApp or the Discord thread (c).</Text>
                        : <Text dimColor>resolving question text…</Text>}
                <Text> </Text>
                <Text dimColor>↑↓ scroll · ←→ prev/next question{roundHint} · 1-4 v answer · d details · a AI · c comments · esc/s back</Text>
            </Box>
        )
    }
    if (view === 'ai') {
        const s = docs[cursor]?.summary
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{row.question}</Text>
                {statusLine}
                <Text bold>AI discussion summary <Text dimColor>(the dApp's, grouped by outcome — not advice)</Text></Text>
                <Text> </Text>
                {s === undefined || s === null
                    ? <Text dimColor>fetching AI discussion summary…</Text>
                    : s.length === 0
                        ? <Text dimColor>No AI discussion summary (yet).</Text>
                        : scrollText(s.map(o => `${o.outcome}: ${o.summary}`).join('\n\n'))}
                <Text> </Text>
                <Text dimColor>↑↓ scroll · ←→ prev/next question{roundHint} · 1-4 v answer · d details · s summary · c comments · esc/a back</Text>
            </Box>
        )
    }
    if (view === 'comments') {
        const thread = threads[cursor]
        const c = thread?.[commentIdx]
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{row.question}</Text>
                {statusLine}
                {thread === null && <Text dimColor>fetching Discord thread…</Text>}
                {thread && thread.length === 0 && <Text dimColor>No comments (or thread not cached — current round only).</Text>}
                {c && <>
                    <Text dimColor>comment {commentIdx + 1}/{thread!.length}  {commentIdx > 0 ? '▲ pgup' : '      '}  {commentIdx < thread!.length - 1 ? 'pgdn ▼' : ''}</Text>
                    <Text> </Text>
                    <Text>{'  '.repeat(c.depth)}<Text color="green" bold>{c.sender}</Text> <Text dimColor>{new Date(c.time * 1000).toISOString().slice(5, 16).replace('T', ' ')}{c.depth > 0 ? ' (reply)' : ''}</Text></Text>
                    {scrollText(c.message)}
                </>}
                <Text> </Text>
                <Text dimColor>↑↓ scroll · pgup/pgdn comments · ←→ question{roundHint} · 1-4 v answer · d details · s summary · esc/c back</Text>
            </Box>
        )
    }
    if (view === 'custom') return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold wrap="wrap">{row.question}</Text>
            <Text>Custom price (human units, scaled ×1e18 on-chain; empty = unanswered): <Text color="cyan">{customBuf}</Text><Text inverse> </Text></Text>
            <Text dimColor>enter apply · esc cancel</Text>
        </Box>
    )
    if (view === 'provenance') {
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold>Answers source report</Text>
                <Text> </Text>
                {notices.map((l, i) => <Text key={i} color={warnings.includes(l) ? 'yellow' : undefined} wrap="wrap">{linkifyUrls(l)}</Text>)}
                <Text> </Text>
                <Text dimColor>esc/p back</Text>
            </Box>
        )
    }
    if (view === 'exit') {
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold color="yellow">⚠ {sendCount} answered vote(s) not committed on-chain</Text>
                <Text dimColor wrap="wrap">Leaving now sends nothing. Your answers are saved and will prefill the next review.</Text>
                <Text> </Text>
                <Text dimColor>y/enter review & commit now · q leave without committing · esc stay</Text>
            </Box>
        )
    }
    if (view === 'confirm') {
        const sending = rows.filter(willSend)
        const unchanged = rows.length - sending.length - unansweredRows.length
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold>Commit {sending.length} vote(s) for round {opts.roundId}? ({rows.length} request(s) total{unchanged > 0 ? `, ${unchanged} already match on-chain` : ''})</Text>
                {sending.map((x, i) => (
                    <Text key={i} color="yellow" wrap="truncate-end">  {x.question.slice(0, 60).padEnd(61)} {x.onchainPrice !== undefined ? priceLabel(x.onchainPrice) : '—'} → <Text color={answerColor(x.answer)}>{x.answer}</Text></Text>
                ))}
                {unansweredRows.length > 0 && <Text> </Text>}
                {unansweredRows.length > 0 && <Text color="red" bold>⚠ {unansweredRows.length} request(s) UNANSWERED — SKIPPED, no commit (risk of no-vote slashing if they resolve):</Text>}
                {unansweredRows.map((x, i) => <Text key={`u${i}`} color="red" wrap="truncate-end">  {x.question.slice(0, 70)}</Text>)}
                {warnings.length > 0 && <Text> </Text>}
                {warnings.map((l, i) => <Text key={`w${i}`} color="yellow" wrap="wrap">{l}</Text>)}
                <Text> </Text>
                {sending.length > 0
                    ? <Text dimColor>y commit (wallet confirmation follows) · n back{unansweredRows.length > 0 ? ' and answer the red ones' : ''}</Text>
                    : <Text dimColor>nothing to send — n back, or q from the list to quit</Text>}
            </Box>
        )
    }

    // list view
    const slice = rows.slice(top, top + WINDOW)
    return (
        <Box flexDirection="column">
            <Text bold> Round {opts.roundId} — commit phase, {fmtCountdown(opts.phaseEnd)} left · {rows.length} request(s) · <Text color="yellow">{sendCount} to send</Text>{unansweredRows.length > 0 ? <Text color="red"> · {unansweredRows.length} unanswered</Text> : null}{!opts.diffAvailable ? <Text color="red"> · NO DIFF{opts.force ? ' (--force)' : ''}</Text> : null}</Text>
            {warnings.map((l, i) => <Text key={`w${i}`} color="yellow" wrap="wrap"> {l}</Text>)}
            <Text dimColor> {top > 0 ? `▲ ${top} more` : '─'.repeat(10)}</Text>
            {slice.map((x, i) => {
                const idx = top + i
                const isCur = idx === cursor
                const needsAnswer = unanswered(x)
                const sends = willSend(x)
                const label = (x.answer || '—').slice(0, 6)
                return (
                    <Text key={idx} inverse={isCur} wrap="truncate-end">
                        {isCur ? ' › ' : '   '}
                        <Text dimColor>{String(idx + 1).padStart(2)} </Text>
                        <Text color={answerColor(x.answer)} bold>{label.padEnd(7)}</Text>
                        <Text color={sends ? 'yellow' : undefined} dimColor={needsAnswer}>{x.question.slice(0, QUESTION_WIDTH).padEnd(QUESTION_WIDTH + 1)}</Text>
                        {needsAnswer
                            ? <Text color="red"> ⚠ needs answer{x.answer ? ` (can't encode "${x.answer.slice(0, 12)}")` : ''}</Text>
                            : sends
                                ? <Text dimColor> was {x.onchainPrice !== undefined ? priceLabel(x.onchainPrice) : '—'}</Text>
                                : <Text dimColor> ✓</Text>}
                    </Text>
                )
            })}
            <Text dimColor> {top + WINDOW < rows.length ? `▼ ${rows.length - top - WINDOW} more` : '─'.repeat(10)}</Text>
            <Text> </Text>
            <Legend />
            <Text dimColor> ↑↓/←→/pg move{roundHint} · 1-4 answer{row?.identifierDecoded !== 'YES_OR_NO_QUERY' ? ' (1 no · 2 yes)' : ' P1-P4'} · v custom · d/enter details · s summary · a AI · c comments{notices.length > 0 ? ' · p source' : ''}{onAbout ? ' · i about' : ''} · C commit · q quit</Text>
        </Box>
    )
}

// Resolves to the reviewed rows (answers possibly edited) plus whether the
// user confirmed the send; rows survive a quit so the caller can persist them.
export async function reviewVotes(opts: ReviewOpts): Promise<ReviewOutcome> {
    let result: ReviewOutcome = { rows: opts.rows, confirmed: false }
    const app = render(<CommitReview opts={opts} onDone={r => { result = r; app.unmount() }} />, { exitOnCtrlC: true })
    await app.waitUntilExit()
    return result
}
