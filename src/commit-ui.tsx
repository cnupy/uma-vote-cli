// Interactive pre-commit review (Ink). Shown by `nub run commit` on a TTY unless
// --yes: scroll the round's requests, override answers (1-4 / custom), inspect
// each request's details, its decoded ancillary text and its Discord discussion,
// then confirm. The caller re-encodes prices from the returned answers and sends
// only what differs from the on-chain commitments.
import React, { useState } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { encodePrice, fmtCountdown } from './common'
import { priceLabel } from './compare'
import { fetchDiscordThread, flattenThread, type ThreadMessage } from './discord'

export type ReviewRow = {
    question: string
    identifier: `0x${string}`
    identifierDecoded: string
    time: bigint
    ancillaryData: `0x${string}`
    answer: string              // planned answer; '' = unanswered (skipped on commit)
    sourceAnswer?: string       // as delivered by the answers source, for reference
    onchainPrice?: bigint       // your current on-chain commitment, if any
}

type ReviewOpts = {
    roundId: number
    phaseEnd: Date
    rows: ReviewRow[]
    diffAvailable: boolean      // on-chain commitments were fetched (diff is trustworthy)
    force: boolean              // --force: every answered row is sent, diff or not
}

const WINDOW = 12
const QUESTION_WIDTH = 64

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

// Decoded ancillary text for the "docs" view; undefined when it's binary/hash-only
const ancillaryText = (ancillaryData: `0x${string}`): string | undefined => {
    const text = Buffer.from(ancillaryData.slice(2), 'hex').toString('utf8')
    const printable = text.replace(/[^\x20-\x7E\n]/g, '')
    return printable.length > text.length * 0.9 ? printable : undefined
}

function App({ opts, onDone }: { opts: ReviewOpts; onDone: (rows: ReviewRow[] | null) => void }) {
    const { exit } = useApp()
    const [rows] = useState(() => opts.rows.map(r => ({ ...r })))
    const [cursor, setCursor] = useState(0)
    const [top, setTop] = useState(0)
    const [view, setView] = useState<'list' | 'details' | 'docs' | 'comments' | 'custom' | 'confirm'>('list')
    const [commentIdx, setCommentIdx] = useState(0)
    const [customBuf, setCustomBuf] = useState('')
    // threads keyed by row index: undefined = not fetched, null = loading
    const [threads, setThreads] = useState<Record<number, ReturnType<typeof flattenThread> | null>>({})
    const [, force] = useState(0)

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

    const openComments = () => {
        setCommentIdx(0)
        setView('comments')
        const i = cursor
        if (threads[i] !== undefined) return
        setThreads(t => ({ ...t, [i]: null }))
        fetchDiscordThread(row.time.toString(), row.identifierDecoded, row.question)
            .then(th => setThreads(t => ({ ...t, [i]: flattenThread(th) })))
    }

    useInput((input, key) => {
        if (view === 'custom') {
            if (key.return) {
                if (customBuf === '' || /^-?\d+(\.\d+)?$/.test(customBuf)) {
                    row.answer = customBuf
                    setView('list'); force(x => x + 1)
                }
            }
            else if (key.escape) setView('list')
            else if (key.backspace || key.delete) setCustomBuf(s => s.slice(0, -1))
            else if (/^[\d.-]$/.test(input)) setCustomBuf(s => s + input)
            return
        }
        if (view === 'comments') {
            const n = threads[cursor]?.length ?? 0
            if (key.leftArrow && n > 0) setCommentIdx(i => (i - 1 + n) % n)
            else if (key.rightArrow && n > 0) setCommentIdx(i => (i + 1) % n)
            else if (key.escape || input === 'c' || input === 'q') setView('list')
            return
        }
        if (view === 'details' || view === 'docs') {
            if (key.escape || input === 'q' || input === 'd' || input === 's') setView('list')
            return
        }
        if (view === 'confirm') {
            if (input === 'y') { onDone(rows); exit() }
            else if (key.escape || input === 'n' || input === 'q') setView('list')
            return
        }
        // list view
        if (key.upArrow) setCursor(c => { const nc = Math.max(0, c - 1); if (nc < top) setTop(nc); return nc })
        else if (key.downArrow) setCursor(c => { const nc = Math.min(rows.length - 1, c + 1); if (nc >= top + WINDOW) setTop(nc - WINDOW + 1); return nc })
        else if (/^[1-4]$/.test(input)) {
            if (row.identifierDecoded === 'YES_OR_NO_QUERY') row.answer = `P${input}`
            else if (input === '1') row.answer = 'no'
            else if (input === '2') row.answer = 'yes'
            else return
            force(x => x + 1)
        }
        else if (input === 'v') { setCustomBuf(/^-?\d+(\.\d+)?$/.test(row.answer) ? row.answer : ''); setView('custom') }
        else if (input === 'd') setView('details')
        else if (input === 's') setView('docs')
        else if (input === 'c') openComments()
        else if (key.return) setView('confirm')
        else if (input === 'q' || key.escape) { onDone(null); exit() }
    })

    if (view === 'details') {
        const p = priceOf(row)
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{row.question}</Text>
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
                <Text dimColor>esc/d back</Text>
            </Box>
        )
    }
    if (view === 'docs') {
        const text = ancillaryText(row.ancillaryData)
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{row.question}</Text>
                <Text> </Text>
                {text
                    ? <Text wrap="wrap">{text.length > 1600 ? text.slice(0, 1600) + ' […]' : text}</Text>
                    : <Text dimColor wrap="wrap">Ancillary data carries no readable text (cross-chain request — only a hash is posted on mainnet). Full request docs live on the origin chain; see the dApp or the Discord thread (c).</Text>}
                <Text> </Text>
                <Text dimColor>esc/s back</Text>
            </Box>
        )
    }
    if (view === 'comments') {
        const thread = threads[cursor]
        const c = thread?.[commentIdx]
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{row.question}</Text>
                {thread === null && <Text dimColor>fetching Discord thread…</Text>}
                {thread && thread.length === 0 && <Text dimColor>No comments (or thread not cached — current round only).</Text>}
                {c && <>
                    <Text dimColor>comment {commentIdx + 1}/{thread!.length}  {commentIdx > 0 ? '◀ prev' : '      '}  {commentIdx < thread!.length - 1 ? 'next ▶' : ''}</Text>
                    <Text> </Text>
                    <Text>{'  '.repeat(c.depth)}<Text color="green" bold>{c.sender}</Text> <Text dimColor>{new Date(c.time * 1000).toISOString().slice(5, 16).replace('T', ' ')}{c.depth > 0 ? ' (reply)' : ''}</Text></Text>
                    <Text wrap="wrap">{'  '.repeat(c.depth)}{c.message}</Text>
                </>}
                <Text> </Text>
                <Text dimColor>←/→ navigate · esc/c back</Text>
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
            <Text dimColor> ↑↓ move · 1-4 answer{row?.identifierDecoded !== 'YES_OR_NO_QUERY' ? ' (1 no · 2 yes)' : ' P1-P4'} · v custom · d details · s docs · c comments · enter review+commit · q quit</Text>
        </Box>
    )
}

// Resolves to the reviewed rows (answers possibly edited), or null if the user quit.
export async function reviewVotes(opts: ReviewOpts): Promise<ReviewRow[] | null> {
    let result: ReviewRow[] | null = null
    const app = render(<App opts={opts} onDone={r => { result = r }} />, { exitOnCtrlC: true })
    await app.waitUntilExit()
    return result
}
