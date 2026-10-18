// Interactive pre-commit review (Ink). Shown by `nub run commit` on a TTY unless
// --yes: scroll the round's requests, override answers (1-4 / custom), inspect
// each request's details, its decoded ancillary text and its Discord discussion,
// then confirm. The caller re-encodes prices from the returned answers and sends
// only what differs from the on-chain commitments.
import React, { useState, useEffect, useRef } from 'react'
import { render, Box, Text, useInput } from 'ink'
import { encodePrice, describePrice, priceProblem, typedPriceProblem, multipleValuesLabels, fmtCountdown, titleFromText, rollTag } from './common'
import { priceLabel } from './compare'
import { reviewStatus } from './answers'
import { fetchDiscussion, flattenThread, discussionNote, type Discussion } from './discord'
import { resolveAncillaryText, descriptionFromText, fetchAiSummary, mapLimit, type OutcomeSummary } from './resolve'
import { roundNavDelta, hyperlink, linkifyUrls, pinnedWarnings, URL_RE, urlLabel } from './tui'

export type ReviewRow = {
    question: string
    needsTitle?: boolean        // placeholder question — real title resolved lazily via the dApp
    identifier: `0x${string}`
    identifierDecoded: string
    time: bigint
    ancillaryData: `0x${string}`
    answer: string              // planned answer; '' = unanswered (skipped on commit)
    decided?: boolean           // the answer is yours (typed, or confirmed earlier); false/absent = a suggestion you have not confirmed
    sourceAnswer?: string       // the sources' agreed answer, for reference (undefined: none, or they disagree)
    sources?: Array<{ addon: string; answer: string; confidence: string }>   // every source's non-empty answer with its measured confidence ("not rated" when none)
    conflicts?: Array<{ addon: string; reason: string }>   // sources that found the vote contested, with their reasons; the vote opens blank like a disagreement
    disagree?: boolean          // sources gave different answers, or one reported a conflict; opens blank unless you decided earlier
    sourceChanged?: { from: string; to: string }       // decided row: the agreed source answer moved since you decided; your answer stays
    suggestionChanged?: { from: string; to: string }   // suggestion row: the suggestion is not the one you last saw; nothing is yours until you confirm
    onchainPrice?: bigint       // your current on-chain commitment, if any
    labels?: string[]           // MULTIPLE_VALUES: the request's labels, one value each; undefined = count unknown, custom values refused
    rollCount?: number          // rounds this request rolled through before this one; shown as [roll] before the title
    lastRound?: string          // rolled: how the last round voted on it, one line
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
export function CommitReview({ opts, onDone, onRoundNav, onAbout, onReload, onWallet, active = true }: { opts: ReviewOpts; onDone: (outcome: ReviewOutcome) => void; onRoundNav?: (delta: 1 | -1) => void; onAbout?: () => void; onReload?: (rows: ReviewRow[]) => void; onWallet?: () => void; active?: boolean }) {
    const [rows] = useState(() => opts.rows.map(r => ({ ...r })))
    // What each row opened with: the status shown for a row ("yours" or a
    // suggestion, a flagged move) follows the owner's edits against this,
    // by the same rules the save applies (reviewStatus)
    const prefilled = useRef(opts.rows.map(r => r.answer))
    const statusOf = (r: ReviewRow) => reviewStatus(r, prefilled.current[rows.indexOf(r)] ?? r.answer)
    const [cursor, setCursor] = useState(0)
    const [top, setTop] = useState(0)
    const [view, setView] = useState<'list' | 'details' | 'summary' | 'ai' | 'comments' | 'custom' | 'confirm' | 'exit' | 'provenance'>('list')
    const [commentIdx, setCommentIdx] = useState(0)
    const [customBuf, setCustomBuf] = useState('')
    // where the custom-price input was opened from, so enter/esc return there
    const [customFrom, setCustomFrom] = useState<'list' | 'details' | 'summary' | 'ai' | 'comments'>('list')
    // discussions keyed by row index: undefined = not fetched, null = loading;
    // `flat` is the thread one comment at a time, `info` says where it lives
    // on Discord and whether its text came back (see discussionNote)
    const [threads, setThreads] = useState<Record<number, { flat: ReturnType<typeof flattenThread>; info: Discussion } | null>>({})
    // summary view data per row: question text + AI summary (null = summary loading)
    const [docs, setDocs] = useState<Record<number, { text?: string; textDone?: boolean; summary?: OutcomeSummary[] | null }>>({})
    const [docScroll, setDocScroll] = useState(0)   // text scroll offset (lines)
    const maxScrollRef = useRef(0)                  // published by scrollText each render
    const [, force] = useState(0)

    // The answer keys depend on the identifier: P1-P4 for YES_OR_NO_QUERY,
    // no/yes for the binary identifiers, and for MULTIPLE_VALUES only 4 (too
    // early) with the values typed under v.
    const isMultiple = (r: ReviewRow) => r.identifierDecoded === 'MULTIPLE_VALUES'

    // Placeholder questions (hash-only cross-chain requests with no answers file)
    // resolve to real titles in the background via the dApp; cached on disk
    useEffect(() => {
        let alive = true
        // MULTIPLE_VALUES rows without their labels (the flow could not
        // resolve the text) get another go here, so custom values become
        // available once the count is known
        mapLimit(rows.filter(r => r.needsTitle || (isMultiple(r) && r.labels === undefined)), 5, async r => {
            const text = await resolveAncillaryText(r.identifier, r.time, r.ancillaryData)
            if (!text || !alive) return
            const title = r.needsTitle ? titleFromText(text) : undefined
            if (title) { r.question = title; r.needsTitle = false }
            if (isMultiple(r) && r.labels === undefined) r.labels = multipleValuesLabels(text)
            if (title || r.labels) force(x => x + 1)
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
    const priceOf = (r: ReviewRow) => r.answer ? encodePrice(r.answer, r.identifierDecoded, r.labels?.length) : undefined
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
    // Rows the sources disagree on (left blank unless you decided earlier),
    // rows where the agreed source answer moved since you decided (your answer
    // stays; the new value is shown), and rows whose suggestion changed since
    // you last saw it (the new suggestion is shown; it is not yours)
    const disagreeRows = rows.filter(r => r.disagree)
    const changedRows = rows.filter(r => statusOf(r).sourceChanged !== undefined)
    const resuggestedRows = rows.filter(r => statusOf(r).suggestionChanged !== undefined)
    // one line per source that found the vote contested (row suffix, details)
    const conflictLine = (r: ReviewRow) => (r.conflicts ?? []).map(c => `${c.addon}: ${c.reason}`).join(' · ')
    // Why the custom input cannot be applied as typed; undefined when it can.
    // MULTIPLE_VALUES takes the list form only (one value per label): a bare
    // integer is read as a packed price elsewhere, which a typist never means.
    const customProblem = (r: ReviewRow, text: string): string | undefined => typedPriceProblem(text, r.identifierDecoded, r.labels)
    // one source per line, with its confidence (details view and the row suffix)
    const sourceLine = (s: { addon: string; answer: string; confidence: string }) =>
        <Text><Text dimColor>{s.addon.padEnd(14)}</Text><Text color={answerColor(s.answer)} bold>{s.answer.padEnd(6)}</Text> <Text dimColor>{s.confidence}</Text></Text>
    // Trust warnings from the answers source stay visible in the list and the
    // confirm modal — the log panel they originally printed to is covered by
    // this review. `p` shows the full source report.
    const notices = opts.notices ?? []
    // Case-sensitive: the trust vocabulary is uppercase in the sources —
    // /i would promote innocuous "differs from"-style info lines too
    const warnings = notices.filter(l => /⚠|❌|NOT verified|UNVERIFIED|NEW CONTRIBUTOR|DIFFER/.test(l))
    // Only the first few are pinned (list and confirm modal); the rest are
    // behind p, where the whole report scrolls with the terminal
    const pinned = pinnedWarnings(warnings)
    const morePinned = pinned.more > 0 ? <Text color="yellow" dimColor> and {pinned.more} more, press p</Text> : null

    const fetchThread = (i: number) => {
        if (threads[i] !== undefined) return
        setThreads(t => ({ ...t, [i]: null }))
        const r = rows[i]
        fetchDiscussion(r.time.toString(), r.identifierDecoded, r.question)
            .then(info => setThreads(t => ({ ...t, [i]: { flat: flattenThread(info.thread), info } })))
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
            else if (isMultiple(row)) { if (input !== '4') return false; row.answer = 'P4' }
            else if (input === '1') row.answer = 'no'
            else if (input === '2') row.answer = 'yes'
            else return false
            force(x => x + 1)
            return true
        }
        if (input === 'v') {
            setCustomBuf(/^-?\d+(\.\d+)?$/.test(row.answer) || (isMultiple(row) && /^[\d,\s[\]]+$/.test(row.answer)) ? row.answer : '')
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
        // w = wallet/signer setup (embedded app only) — free key here; the
        // review owns s/c (summary/comments), so wallet can't reuse those
        if (input === 'w' && onWallet) { onWallet(); return true }
        return false
    }

    useInput((input, key) => {
        if (view === 'custom') {
            // typing owns ALL keys — '[' and ctrl+arrows are inert here, no round nav.
            // MULTIPLE_VALUES takes a value list ("73, 75", label order) or the
            // packed integer; the encoder rejects anything else, so the row
            // shows "needs answer" rather than committing a wrong price.
            // Enter applies only what encodes: a value list with exactly one
            // value per label (refused while the label count is unknown), or
            // a custom price within the identifier's decimals. Anything else
            // stays in the input with the reason shown under it.
            if (key.return) {
                if (customBuf === '' || customProblem(row, customBuf) === undefined) {
                    row.answer = customBuf
                    setView(customFrom); force(x => x + 1)
                }
            }
            else if (key.escape) setView(customFrom)
            else if (key.backspace || key.delete) setCustomBuf(s => s.slice(0, -1))
            else if (/^[\d.-]$/.test(input) || (isMultiple(row) && /^[, ]$/.test(input))) setCustomBuf(s => s + input)
            return
        }
        // [ ]/ctrl+←→ = prev/next ROUND everywhere except custom (above) and the
        // confirm modal (below) — only when the votes screen wires onRoundNav;
        // standalone these keys do nothing (bindings mean the same everywhere)
        const roundDelta = roundNavDelta(input, key)
        if (roundDelta !== 0 && view !== 'confirm' && view !== 'exit') { onRoundNav?.(roundDelta); return }
        // r = reload: ask every addon again (embedded app only). A source often
        // publishes mid-commit-phase; hand the current rows up so the restart
        // persists them and the refreshed answers merge under these edits. Not
        // from the confirm/exit modals (those own y/n).
        if (onReload && input === 'r' && view !== 'confirm' && view !== 'exit') { onReload(rows); return }
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
                const n = threads[cursor]?.flat.length ?? 0
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
    // "yours" once you typed it or confirmed it; until then a prefilled
    // answer is a suggestion, which a batch run will not sign
    const whose = (r: ReviewRow) => r.answer === '' ? '' : statusOf(r).decided ? 'yours' : 'suggested, not yet yours'
    // the encoded price beside answers whose text does not say it (MULTIPLE_VALUES)
    const priceNote = (r: ReviewRow) => {
        const p = priceOf(r)
        if (p === undefined) return undefined
        const meaning = describePrice(p, r.identifierDecoded, r.labels?.length)
        return meaning ? `price ${p.toString()} = ${meaning}` : `price ${p.toString()}`
    }
    // the committed price in words for this request's identifier
    const onchainLabel = (r: ReviewRow) => priceLabel(r.onchainPrice!, r.identifierDecoded, r.labels?.length)
    const statusLine = (
        <Text><Text dimColor>question {cursor + 1}/{rows.length} · </Text>planned: <Text color={answerColor(row.answer)}>{row.answer || 'UNANSWERED'}</Text>{whose(row) ? <Text dimColor> ({whose(row)})</Text> : null} · on-chain: {row.onchainPrice !== undefined
            ? <Text color={answerColor(onchainLabel(row))}>{onchainLabel(row)}</Text>
            : <Text dimColor>not committed</Text>}</Text>
    )

    if (view === 'details') {
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap"><Text color="magenta">{rollTag(row.rollCount)}</Text>{row.question}</Text>
                <Text dimColor>question {cursor + 1}/{rows.length}</Text>
                <Text> </Text>
                <Text>identifier:  <Text color="cyan">{row.identifierDecoded}</Text></Text>
                <Text>timestamp:   {fmtUnix(row.time)}</Text>
                <Text>ancillary:   {shortHex(row.ancillaryData, 24)} ({(row.ancillaryData.length - 2) / 2} bytes)</Text>
                {row.lastRound && <Text>last round:  {row.lastRound}</Text>}
                <Text>discord:     {threads[cursor]
                    ? <Text dimColor>{hyperlink(threads[cursor]!.info.link, threads[cursor]!.info.threadId ? "this vote's thread" : 'the discussion channel (no thread known)')}{threads[cursor]!.info.ok && threads[cursor]!.info.threadId && threads[cursor]!.flat.length === 0 ? ' — no message text came back; read it there' : ''}</Text>
                    : <Text dimColor>c to look the thread up</Text>}</Text>
                {(row.sources ?? []).length === 0
                    ? <Text>sources:     <Text dimColor>(no answer from any source)</Text></Text>
                    : (row.sources ?? []).map((s, i) => <Text key={`s${i}`}>{i === 0 ? 'sources:     ' : '             '}{sourceLine(s)}</Text>)}
                {(row.conflicts ?? []).map((c, i) => <Text key={`c${i}`} color="yellow">⚠ {c.addon} sees a conflict: {c.reason}</Text>)}
                {row.disagree && <Text color="yellow">⚠ {(row.conflicts ?? []).length > 0 ? 'a source found this vote contested' : 'sources disagree'} — this vote is yours to decide{row.answer && statusOf(row).decided ? ` (your ${row.answer} stands)` : ''}</Text>}
                {isMultiple(row) && <Text>labels:      {row.labels ? <Text color="cyan">{row.labels.join(', ')}</Text> : <Text color="red">unknown (text did not resolve) — custom values refused, 4 for too early</Text>}</Text>}
                <Text>on-chain:    {row.onchainPrice !== undefined
                    ? <Text color={answerColor(onchainLabel(row))}>{onchainLabel(row)}</Text>
                    : <Text dimColor>{opts.diffAvailable ? 'not committed' : 'unknown (diff unavailable)'}</Text>}</Text>
                <Text>planned:     <Text color={answerColor(row.answer)}>{row.answer || 'UNANSWERED — will be skipped'}</Text>{whose(row) ? <Text dimColor>  ({whose(row)})</Text> : null}{priceNote(row) ? <Text dimColor>  ({priceNote(row)})</Text> : null}</Text>
                {statusOf(row).sourceChanged !== undefined && <Text color="magenta">⟳ source moved since you decided: was {statusOf(row).sourceChanged!.from || '(blank)'}, now {statusOf(row).sourceChanged!.to} — your {row.answer || '(blank)'} stays unless you change it</Text>}
                {statusOf(row).suggestionChanged !== undefined && <Text color="magenta">⟳ the suggestion changed since you last saw it: was {statusOf(row).suggestionChanged!.from}, now {statusOf(row).suggestionChanged!.to} — not yours until you confirm or set it</Text>}
                <Text> </Text>
                <Text dimColor>←→ prev/next question{roundHint} · {isMultiple(row) ? '4 too early · v values' : '1-4 v answer'} · s summary · a AI · c comments · esc/d back</Text>
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
                <Text bold wrap="wrap"><Text color="magenta">{rollTag(row.rollCount)}</Text>{row.question}</Text>
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
                <Text bold wrap="wrap"><Text color="magenta">{rollTag(row.rollCount)}</Text>{row.question}</Text>
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
        const c = thread?.flat[commentIdx]
        // The vote's place on Discord, as the dApp links it: its thread when
        // one is known, else the discussion channel. Shown even with the
        // messages here, so the live thread is one ctrl+click away.
        const note = thread ? discussionNote(thread.info) : undefined
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap"><Text color="magenta">{rollTag(row.rollCount)}</Text>{row.question}</Text>
                {statusLine}
                {thread === null && <Text dimColor>fetching Discord thread…</Text>}
                {thread && <Text dimColor>Discord: {hyperlink(thread.info.link, thread.info.threadId ? "this vote's thread" : 'the discussion channel (no thread known for this vote)')}</Text>}
                {note && <Text color={thread!.info.ok ? 'yellow' : 'red'} wrap="wrap">{linkifyUrls(note)}</Text>}
                {c && <>
                    <Text dimColor>comment {commentIdx + 1}/{thread!.flat.length}  {commentIdx > 0 ? '▲ pgup' : '      '}  {commentIdx < thread!.flat.length - 1 ? 'pgdn ▼' : ''}</Text>
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
            <Text bold wrap="wrap"><Text color="magenta">{rollTag(row.rollCount)}</Text>{row.question}</Text>
            {isMultiple(row)
                ? row.labels
                    ? <Text>One value per label, in this order: <Text color="cyan">{row.labels.join(', ')}</Text> ({row.labels.length} value(s), e.g. {row.labels.map((_, i) => 70 + i).join(', ')}; packed into one int256 as the dApp does; empty = unanswered): <Text color="cyan">{customBuf}</Text><Text inverse> </Text></Text>
                    : <Text color="red">Label count unknown for this request (its text did not resolve), so custom values are refused rather than packed on a guess. Press 4 for too early, or esc.</Text>
                : <Text>Custom price (human units, scaled on-chain by the identifier's precision; empty = unanswered): <Text color="cyan">{customBuf}</Text><Text inverse> </Text></Text>}
            {customBuf !== '' && (() => {
                const problem = customProblem(row, customBuf)
                if (problem !== undefined) return <Text color="red">{problem}</Text>
                const p = encodePrice(customBuf, row.identifierDecoded, row.labels?.length)!
                return <Text dimColor>price {p.toString()}{isMultiple(row) ? ` = ${describePrice(p, row.identifierDecoded, row.labels?.length)}` : ''}</Text>
            })()}
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
                    <Text key={i} color="yellow" wrap="truncate-end">  {x.question.slice(0, 60).padEnd(61)} {x.onchainPrice !== undefined ? onchainLabel(x) : '—'} → <Text color={answerColor(x.answer)}>{x.answer}</Text>{isMultiple(x) ? <Text dimColor> = {describePrice(priceOf(x)!, x.identifierDecoded, x.labels?.length)}</Text> : null}</Text>
                ))}
                {unansweredRows.length > 0 && <Text> </Text>}
                {unansweredRows.length > 0 && <Text color="red" bold>⚠ {unansweredRows.length} request(s) UNANSWERED — SKIPPED, no commit (risk of no-vote slashing if they resolve):</Text>}
                {unansweredRows.map((x, i) => <Text key={`u${i}`} color="red" wrap="truncate-end">  {x.question.slice(0, 70)}</Text>)}
                {warnings.length > 0 && <Text> </Text>}
                {pinned.shown.map((l, i) => <Text key={`w${i}`} color="yellow" wrap="wrap">{linkifyUrls(l)}</Text>)}
                {morePinned}
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
            {pinned.shown.map((l, i) => <Text key={`w${i}`} color="yellow" wrap="wrap"> {linkifyUrls(l)}</Text>)}
            {morePinned}
            {/* Rollover before the source published: no answer landed for any
                request — point the user at r to re-pull instead of answering 17 by hand */}
            {onReload && rows.every(r => !(r.sources?.length)) && <Text color="yellow" wrap="wrap"> No answers from any source yet — press <Text bold>r</Text> to ask the addons again.</Text>}
            {disagreeRows.length > 0 && <Text color="yellow" wrap="wrap"> ⚠ {disagreeRows.length} vote(s) where the sources disagree or a source found the vote contested — each is yours to decide; the answers and reasons are shown per row and in details (d).</Text>}
            {changedRows.length > 0 && <Text color="magenta" wrap="wrap"> ⟳ {changedRows.length} source answer(s) moved since you decided — your answers stay; the new value is shown per row and in details (d).</Text>}
            {resuggestedRows.length > 0 && <Text color="magenta" wrap="wrap"> ⟳ {resuggestedRows.length} suggestion(s) changed since you last looked — the new suggestion is prefilled; nothing is yours until you confirm (C, y) or set it.</Text>}
            {/* the highlighted row's suggestions with their confidence, so every
                suggestion's basis is readable from the list without opening d */}
            {row && <Text wrap="truncate-end"> <Text dimColor>sources for #{cursor + 1}:</Text> {(row.sources ?? []).length === 0
                ? <Text dimColor>none</Text>
                : (row.sources ?? []).map((s, i) => <Text key={i}>{i > 0 ? ' · ' : ''}{s.addon} <Text color={answerColor(s.answer)} bold>{s.answer}</Text> <Text dimColor>({s.confidence})</Text></Text>)}</Text>}
            {/* kept (blank) on rows that never rolled, so the list does not
                jump when the cursor moves onto a rolled one */}
            {rows.some(r => r.lastRound) && <Text wrap="truncate-end" dimColor> {row?.lastRound ?? ' '}</Text>}
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
                        <Text color="magenta">{rollTag(x.rollCount)}</Text>
                        <Text color={sends ? 'yellow' : undefined} dimColor={needsAnswer}>{x.question.slice(0, QUESTION_WIDTH - rollTag(x.rollCount).length).padEnd(QUESTION_WIDTH + 1 - rollTag(x.rollCount).length)}</Text>
                        {needsAnswer
                            ? <Text color="red"> ⚠ needs answer{x.answer ? ` (${priceProblem(x.answer, x.identifierDecoded, x.labels?.length)})` : ''}</Text>
                            : sends
                                ? <Text dimColor> was {x.onchainPrice !== undefined ? onchainLabel(x) : '—'}</Text>
                                : <Text dimColor> ✓</Text>}
                        {isMultiple(x) && !needsAnswer && <Text dimColor> = {describePrice(priceOf(x)!, x.identifierDecoded, x.labels?.length)}</Text>}
                        {x.disagree && <Text color="yellow"> ⚠ {[...(x.sources ?? []).map(s => `${s.addon} ${s.answer}`), conflictLine(x)].filter(Boolean).join(' · ')}</Text>}
                        {statusOf(x).sourceChanged !== undefined && <Text color="magenta"> ⟳ source now {statusOf(x).sourceChanged!.to}, was {statusOf(x).sourceChanged!.from || '(blank)'}; yours stays</Text>}
                        {statusOf(x).suggestionChanged !== undefined && <Text color="magenta"> ⟳ suggestion now {statusOf(x).suggestionChanged!.to}, was {statusOf(x).suggestionChanged!.from}; not yours yet</Text>}
                    </Text>
                )
            })}
            <Text dimColor> {top + WINDOW < rows.length ? `▼ ${rows.length - top - WINDOW} more` : '─'.repeat(10)}</Text>
            <Text> </Text>
            <Legend />
            <Text dimColor> ↑↓/←→/pg move{roundHint} · {row && isMultiple(row) ? '4 too early · v values' : `1-4 answer${row?.identifierDecoded !== 'YES_OR_NO_QUERY' ? ' (1 no · 2 yes)' : ' P1-P4'} · v custom`} · d/enter details · s summary · a AI · c comments{notices.length > 0 ? ' · p source' : ''}{onReload ? ' · r reload' : ''}{onWallet ? ' · w wallet' : ''}{onAbout ? ' · i about' : ''} · C commit · q quit</Text>
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
