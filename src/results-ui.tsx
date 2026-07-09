// Interactive round-results explorer (Ink). Shown by `nub run results` on a
// TTY: scroll the round's requests, open a per-request price-split detail
// view (d/enter), move between rounds ([ ]/ctrl+←→ in the list; the same keys
// move between requests inside the detail view) with an in-session per-round
// cache, refetch with r, and — when viewing the current round during its
// reveal phase — auto-refresh every 60s. Piped/non-TTY runs keep the static
// table in round-results.ts.
import React, { useState, useEffect, useRef } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { formatUnits } from 'viem'
import { getCurrentRoundId, getVotePhase, phaseEndsAt, fmtCountdown, P1_VALUE, P2_VALUE, P3_VALUE, P4_VALUE } from './common'
import { priceLabel } from './compare'
import { fetchRoundResults, fmtTokens, pct, pctOfThreshold, type RoundResults, type RequestResult } from './round-results'

const WINDOW = 12
const QUESTION_WIDTH = 48

// P1-P4 keep their short labels; anything else is a custom price shown in
// human units (the ×1e18 scheme custom votes use)
const KNOWN_PRICES = [P1_VALUE, P2_VALUE, P3_VALUE, P4_VALUE]
const fullPriceLabel = (p: bigint): string => KNOWN_PRICES.includes(p) ? priceLabel(p) : formatUnits(p, 18)
const priceColor = (p: bigint): string =>
    p === P1_VALUE ? 'red' : p === P2_VALUE ? 'green' : p === P3_VALUE ? 'yellow' : p === P4_VALUE ? 'magenta' : 'cyan'

// Same semantics as the static table's Mine column
const mineMarker = (t: RequestResult): { label: string; color?: string; dim?: boolean } => {
    if (t.myPrice !== undefined) {
        return t.myPrice === t.leadingPrice
            ? { label: `✓${priceLabel(t.myPrice)}`, color: 'green' }
            : { label: `✗${priceLabel(t.myPrice)}`, color: 'red' }
    }
    if (t.myCommitted) return { label: 'cmtd', color: 'gray' }
    return { label: '–', dim: true }
}

type ExplorerOpts = {
    startRound: number
    currentRound: number
    phase: number               // 0 = commit, 1 = reveal (at launch)
}

function App({ opts }: { opts: ExplorerOpts }) {
    const { exit } = useApp()
    const [round, setRound] = useState(opts.startRound)
    const [data, setData] = useState<RoundResults | undefined>()
    const [fetching, setFetching] = useState<number | undefined>()
    const [error, setError] = useState<string | undefined>()
    const [cursor, setCursor] = useState(0)
    const [top, setTop] = useState(0)
    const [view, setView] = useState<'list' | 'detail'>('list')
    const [, tick] = useState(0)
    const cache = useRef(new Map<number, RoundResults>())
    const roundRef = useRef(round)
    const seq = useRef(0)

    // Live only for the current round in its reveal phase — past rounds are final
    const live = round === opts.currentRound && opts.phase === 1

    const load = (r: number, bypassCache = false) => {
        if (!bypassCache && cache.current.has(r)) return
        const id = ++seq.current
        setFetching(r)
        setError(undefined)
        fetchRoundResults(r).then(d => {
            cache.current.set(r, d)
            if (seq.current !== id) return // superseded by a newer fetch
            setFetching(undefined)
            if (roundRef.current === r) setData(d)
        }).catch(e => {
            if (seq.current !== id) return
            setFetching(undefined)
            if (roundRef.current === r) setError((e as Error).message.split('\n')[0])
        })
    }

    useEffect(() => {
        roundRef.current = round
        setCursor(0)
        setTop(0)
        setData(cache.current.get(round))
        load(round)
    }, [round])

    useEffect(() => {
        if (!live) return
        const iv = setInterval(() => load(round, true), 60_000)
        return () => clearInterval(iv)
    }, [round, live])

    // 1s re-render so "refreshed Ns ago" ticks
    useEffect(() => {
        const iv = setInterval(() => tick(x => x + 1), 1000)
        return () => clearInterval(iv)
    }, [])

    const rows = data?.status === 'ok' ? data.requests : []
    // Clamped: a live refetch can shrink the list under the cursor
    const cur = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1)
    const topSafe = Math.min(top, Math.max(0, rows.length - WINDOW))
    const row = rows[cur]

    const cursorUp = () => setCursor(c => { const nc = Math.max(0, c - 1); if (nc < top) setTop(nc); return nc })
    const cursorDown = () => setCursor(c => { const nc = Math.min(Math.max(0, rows.length - 1), c + 1); if (nc >= top + WINDOW) setTop(nc - WINDOW + 1); return nc })
    const gotoRound = (r: number) => { if (r >= 1 && r <= opts.currentRound && r !== round) setRound(r) }

    useInput((input, key) => {
        const prevKey = (key.ctrl && key.leftArrow) || input === '['
        const nextKey = (key.ctrl && key.rightArrow) || input === ']'
        if (view === 'detail') {
            if (key.escape || input === 'd' || input === 'q') setView('list')
            else if (input === 'r') load(round, true)
            else if (prevKey) cursorUp()   // prev/next REQUEST, staying in detail
            else if (nextKey) cursorDown()
            return
        }
        // list view — [ ]/ctrl+←→ navigate ROUNDS here
        if (input === 'q' || key.escape) exit()
        else if (input === 'r') load(round, true)
        else if (prevKey) gotoRound(round - 1)
        else if (nextKey) gotoRound(round + 1)
        else if (key.upArrow) cursorUp()
        else if (key.downArrow) cursorDown()
        else if ((input === 'd' || key.return) && row) setView('detail')
    })

    const freshness = data ? `refreshed ${Math.max(0, Math.floor((Date.now() - data.fetchedAt) / 1000))}s ago` : ''
    const phaseCtx = round === opts.currentRound
        ? opts.phase === 1 ? `reveal phase, ${fmtCountdown(phaseEndsAt())} left` : 'commit phase'
        : 'past round (final)'
    const passing = rows.filter(t => t.quorumOk && t.consensusOk).length
    const header = (
        <Text bold> Round {round} — {phaseCtx} · {rows.length} request(s) · {passing} passing{live ? ' · live (60s)' : ''}{freshness ? <Text dimColor>  {freshness}{fetching === round && data ? ' · refreshing…' : ''}</Text> : null}</Text>
    )

    if (view === 'detail' && row && data) {
        const m = mineMarker(row)
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{row.question}</Text>
                <Text dimColor>round {round} · request {cur + 1}/{rows.length}{fetching === round ? ' · refreshing…' : ''}</Text>
                <Text> </Text>
                <Text>my vote:    {row.myPrice !== undefined
                    ? <Text color={m.color}>{fullPriceLabel(row.myPrice)} {row.myPrice === row.leadingPrice ? '✓ matches current majority' : '✗ differs from current majority'}</Text>
                    : row.myCommitted ? <Text color="gray">committed, not (yet) revealed</Text> : <Text dimColor>none</Text>}</Text>
                <Text>quorum:     {pctOfThreshold(row.total, data.minParticipation)} — {fmtTokens(row.total)}/{fmtTokens(data.minParticipation)} revealed/required {row.quorumOk ? <Text color="green">✓</Text> : <Text color="red">✗</Text>}</Text>
                <Text>consensus:  {pctOfThreshold(row.leadingTokens, data.minAgreement)} — {fmtTokens(row.leadingTokens)}/{fmtTokens(data.minAgreement)} leading/required {row.consensusOk ? <Text color="green">✓</Text> : <Text color="red">✗</Text>}</Text>
                <Text> </Text>
                <Text dimColor>price split — {fmtTokens(row.total)} revealed:</Text>
                {row.prices.map((s, i) => (
                    <Text key={s.price.toString()}>  <Text color={priceColor(s.price)} bold>{fullPriceLabel(s.price).slice(0, 20).padEnd(21)}</Text>{fmtTokens(s.tokens).padStart(8)}  {pct(s.tokens, row.total).padStart(6)}{i === 0 ? <Text dimColor>  ◀ leading</Text> : null}</Text>
                ))}
                <Text> </Text>
                <Text dimColor>ctrl+←→ / [ ] prev/next request · r refetch · esc/d/q back</Text>
            </Box>
        )
    }

    // list view
    const slice = rows.slice(topSafe, topSafe + WINDOW)
    return (
        <Box flexDirection="column">
            {header}
            {data && data.status !== 'no-votes' && (
                <Text dimColor> staked {fmtTokens(data.cumulativeStake)} · quorum needs {fmtTokens(data.minParticipation)} revealed · consensus needs {fmtTokens(data.minAgreement)} on one outcome</Text>
            )}
            {!data && fetching === round && <Box justifyContent="center" paddingY={1}><Text dimColor>fetching round {round}…</Text></Box>}
            {!data && fetching !== round && error && <Text color="red"> ⚠ {error} — r to retry</Text>}
            {data?.status === 'no-votes' && <Text dimColor> No reveals recorded — round {round} was never frozen (nothing was voted).</Text>}
            {data?.status === 'not-started' && <Text dimColor> Reveal phase hasn't started yet.</Text>}
            {data?.status === 'no-reveals' && <Text dimColor> No reveals yet in round {round}.</Text>}
            {rows.length > 0 && <>
                <Text dimColor>    Mine     {'Question'.padEnd(QUESTION_WIDTH + 1)} {'Quorum'.padEnd(8)}{'Consens'.padEnd(9)}Leading</Text>
                <Text dimColor> {topSafe > 0 ? `▲ ${topSafe} more` : '─'.repeat(10)}</Text>
                {slice.map((t, i) => {
                    const idx = topSafe + i
                    const isCur = idx === cur
                    const m = mineMarker(t)
                    return (
                        <Text key={idx} inverse={isCur} wrap="truncate-end">
                            {isCur ? ' › ' : '   '}
                            <Text color={m.color} dimColor={m.dim} bold={!m.dim}>{m.label.padEnd(8)}</Text>
                            <Text>{t.question.slice(0, QUESTION_WIDTH).padEnd(QUESTION_WIDTH + 1)}</Text>
                            <Text color={t.quorumOk ? 'green' : 'red'}> {(pctOfThreshold(t.total, data!.minParticipation) + (t.quorumOk ? '✓' : '✗')).padStart(7)}</Text>
                            <Text color={t.consensusOk ? 'green' : 'red'} > {(pctOfThreshold(t.leadingTokens, data!.minAgreement) + (t.consensusOk ? '✓' : '✗')).padStart(7)} </Text>
                            <Text color={priceColor(t.leadingPrice)} bold> {fullPriceLabel(t.leadingPrice).slice(0, 12)}</Text>
                        </Text>
                    )
                })}
                <Text dimColor> {topSafe + WINDOW < rows.length ? `▼ ${rows.length - topSafe - WINDOW} more` : '─'.repeat(10)}</Text>
            </>}
            <Text> </Text>
            <Text dimColor> Mine: <Text color="green">✓ matches majority</Text> · <Text color="red">✗ differs</Text> · <Text color="gray">cmtd committed, not revealed</Text> · – no vote</Text>
            <Text dimColor> ↑↓ move · d/enter details · ctrl+←→ / [ ] prev/next round · r refetch · q quit</Text>
        </Box>
    )
}

// Full-screen explorer; resolves when the user quits.
export async function runResultsExplorer(startRound: number): Promise<void> {
    const [currentRound, phase] = await Promise.all([getCurrentRoundId(), getVotePhase()])
    const app = render(
        <App opts={{ startRound: Math.min(startRound, currentRound), currentRound, phase }} />,
        { exitOnCtrlC: true },
    )
    await app.waitUntilExit()
}
