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
import { EXPECTED_VOTER } from './config'
import { priceLabel } from './compare'
import { fetchRoundResults, fmtTokens, pct, pctOfThreshold, type RoundResults, type RequestResult } from './round-results'
import { fetchVoteSlashes, slashFor, roundSlashStats, fmtSlash, type VoteSlashes } from './slashes'
import { resolveAncillaryText, titleFromText, mapLimit } from './resolve'

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
    const [paused, setPaused] = useState(false)
    const [, tick] = useState(0)
    const cache = useRef(new Map<number, RoundResults>())
    const roundRef = useRef(round)
    const seq = useRef(0)
    const slashes = useRef<VoteSlashes | undefined>()
    const slashesTried = useRef(false)

    // Live only for the current round in its reveal phase — past rounds are final
    const live = round === opts.currentRound && opts.phase === 1

    const load = (r: number, bypassCache = false) => {
        if (!bypassCache && cache.current.has(r)) return
        const id = ++seq.current
        setFetching(r)
        setError(undefined)
        fetchRoundResults(r, bypassCache).then(d => {
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
        if (!live || paused) return
        const iv = setInterval(() => load(round, true), 60_000)
        return () => clearInterval(iv)
    }, [round, live, paused])

    // 1s re-render so "refreshed Ns ago" ticks
    useEffect(() => {
        const iv = setInterval(() => tick(x => x + 1), 1000)
        return () => clearInterval(iv)
    }, [])

    // Per-vote slash amounts (final rounds only) — one subgraph fetch per
    // explorer session; every round then matches against the map as it renders.
    // Needs a voter address: EXPECTED_VOTER, else the cached signing key.
    useEffect(() => {
        if (slashesTried.current || !data) return
        const voter = EXPECTED_VOTER?.toLowerCase() ?? data.myAddress
        if (!voter) return
        slashesTried.current = true
        fetchVoteSlashes(voter).then(m => {
            if (m) { slashes.current = m; tick(x => x + 1) }
        })
    }, [data])

    // Placeholder questions (hash-only cross-chain requests with no answers
    // file) resolve to real titles in the background; disk-cached, so revisits
    // and cached rounds fill in instantly
    useEffect(() => {
        if (!data || data.status !== 'ok') return
        let alive = true
        mapLimit(data.requests.filter(r => r.needsTitle), 5, async r => {
            const text = await resolveAncillaryText(r.identifier, r.time, r.ancillaryData)
            const title = text && titleFromText(text)
            if (title && alive) { r.question = title; r.needsTitle = false; tick(x => x + 1) }
        })
        return () => { alive = false }
    }, [data])

    const rows = data?.status === 'ok' ? data.requests : []
    // Clamped: a live refetch can shrink the list under the cursor
    const cur = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1)
    const topSafe = Math.min(top, Math.max(0, rows.length - WINDOW))
    const row = rows[cur]

    // Slash amounts only make sense once a round is over (nothing settles live)
    const showSlash = round < opts.currentRound && slashes.current !== undefined
    const slashStats = showSlash ? roundSlashStats(slashes.current!, rows) : undefined

    const cursorUp = () => setCursor(c => { const nc = Math.max(0, c - 1); if (nc < top) setTop(nc); return nc })
    const cursorDown = () => setCursor(c => { const nc = Math.min(Math.max(0, rows.length - 1), c + 1); if (nc >= top + WINDOW) setTop(nc - WINDOW + 1); return nc })
    const gotoRound = (r: number) => { if (r >= 1 && r <= opts.currentRound && r !== round) setRound(r) }

    useInput((input, key) => {
        const prevKey = (key.ctrl && key.leftArrow) || input === '['
        const nextKey = (key.ctrl && key.rightArrow) || input === ']'
        if (view === 'detail') {
            if (key.escape || input === 'd' || input === 'q') setView('list')
            else if (input === 'r') load(round, true)
            else if (input === 'p' && live) setPaused(p => !p)
            else if (prevKey) gotoRound(round - 1)          // rounds: same keys as the list
            else if (nextKey) gotoRound(round + 1)
            else if (key.leftArrow) cursorUp()              // plain ←/→: prev/next request
            else if (key.rightArrow) cursorDown()
            return
        }
        // list view — [ ]/ctrl+←→ navigate ROUNDS here
        if (input === 'q' || key.escape) exit()
        else if (input === 'r') load(round, true)
        else if (input === 'p' && live) setPaused(p => !p)
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
        <Box flexDirection="column">
            <Text bold> Round {round} — {phaseCtx} · {rows.length} request(s) · {passing} passing{slashStats && slashStats.matched > 0 ? <> · your net: <Text color={slashStats.net < 0 ? 'red' : 'green'}>{(slashStats.net > 0 ? '+' : '') + slashStats.net.toFixed(3)} UMA</Text>{slashStats.pending > 0 ? <Text dimColor> · {slashStats.pending} pending</Text> : null}</> : null}{live ? (paused ? <Text color="yellow"> · paused</Text> : ' · live (60s)') : ''}{freshness ? <Text dimColor>  {freshness}{fetching === round && data ? ' · refreshing…' : ''}</Text> : null}</Text>
            {data && !data.myAddress && <Text color="yellow"> ⚠ your votes can't be marked — no .signing-key.json (run `nub run verify-key` once)</Text>}
        </Box>
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
                    : row.myCommitted ? <Text color="gray">committed, not (yet) revealed</Text>
                    : data.myAddress ? <Text dimColor>none</Text>
                    : <Text color="yellow">unknown — no .signing-key.json (run `nub run verify-key` once)</Text>}</Text>
                {showSlash && (() => {
                    const s = slashFor(slashes.current!, row.identifier, row.time, row.ancillaryData)
                    return <Text>slash:      {!s
                        ? <Text dimColor>none — you had nothing at stake for this request</Text>
                        : s.pending ? <Text color="gray">pending — your slashing trackers haven't settled this request yet</Text>
                        : <Text color={Number(s.slashAmount) < 0 ? 'red' : 'green'}>{fmtSlash(s.slashAmount)} UMA {Number(s.slashAmount) < 0 ? 'lost' : 'earned'} through slashing</Text>}</Text>
                })()}
                <Text>quorum:     {pctOfThreshold(row.total, data.minParticipation)} — {fmtTokens(row.total)}/{fmtTokens(data.minParticipation)} revealed/required {row.quorumOk ? <Text color="green">✓</Text> : <Text color="red">✗</Text>}</Text>
                <Text>consensus:  {pctOfThreshold(row.leadingTokens, data.minAgreement)} — {fmtTokens(row.leadingTokens)}/{fmtTokens(data.minAgreement)} leading/required {row.consensusOk ? <Text color="green">✓</Text> : <Text color="red">✗</Text>}</Text>
                <Text> </Text>
                <Text dimColor>price split — {fmtTokens(row.total)} revealed:</Text>
                {row.prices.map((s, i) => (
                    <Text key={s.price.toString()}>  <Text color={priceColor(s.price)} bold>{fullPriceLabel(s.price).slice(0, 20).padEnd(21)}</Text>{fmtTokens(s.tokens).padStart(8)}  {pct(s.tokens, row.total).padStart(6)}{i === 0 ? <Text dimColor>  ◀ leading</Text> : null}</Text>
                ))}
                <Text> </Text>
                <Text dimColor>←→ prev/next request · ctrl+←→ / [ ] prev/next round · r refetch{live ? ` · p ${paused ? 'resume' : 'pause'}` : ''} · esc/d/q back</Text>
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
                <Text dimColor>    Mine     {'Question'.padEnd(QUESTION_WIDTH + 1)} {'Quorum'.padEnd(8)}{'Consens'.padEnd(9)}{showSlash ? 'Leading'.padEnd(13) + 'Slash'.padStart(10) : 'Leading'}</Text>
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
                            <Text color={priceColor(t.leadingPrice)} bold> {showSlash ? fullPriceLabel(t.leadingPrice).slice(0, 12).padEnd(12) : fullPriceLabel(t.leadingPrice).slice(0, 12)}</Text>
                            {showSlash && (() => {
                                const s = slashFor(slashes.current!, t.identifier, t.time, t.ancillaryData)
                                return !s ? <Text>{' '.repeat(10)}</Text>
                                    : s.pending ? <Text color="gray">{'pending'.padStart(10)}</Text>
                                    : <Text color={Number(s.slashAmount) < 0 ? 'red' : 'green'}>{fmtSlash(s.slashAmount).padStart(10)}</Text>
                            })()}
                        </Text>
                    )
                })}
                <Text dimColor> {topSafe + WINDOW < rows.length ? `▼ ${rows.length - topSafe - WINDOW} more` : '─'.repeat(10)}</Text>
            </>}
            <Text> </Text>
            <Text dimColor> Mine: <Text color="green">✓ matches majority</Text> · <Text color="red">✗ differs</Text> · <Text color="gray">cmtd committed, not revealed</Text> · – no vote</Text>
            <Text dimColor> ↑↓ move · d/enter details · ctrl+←→ / [ ] prev/next round · r refetch{live ? ` · p ${paused ? 'resume' : 'pause'}` : ''} · q quit</Text>
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
