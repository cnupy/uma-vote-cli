// Interactive round-results explorer (Ink), embedded in the `nub run uma`
// votes screen: scroll the round's requests, open a per-request price-split
// detail view (d/enter), move between rounds ([ ]/ctrl+←→ in the list; the
// same keys move between requests inside the detail view) with an in-session
// per-round cache, refetch with r, and — when viewing the current round
// during its reveal phase — refresh when new VoteRevealed events land (light
// log watcher instead of blind polling). `nub run results` prints the static
// table in round-results.ts instead.
import React, { useState, useEffect, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { formatUnits } from 'viem'
import { publicClient, votingContract, phaseEndsAt, fmtCountdown, fmtAgo, titleFromText, P1_VALUE, P2_VALUE, P3_VALUE, P4_VALUE } from './common'
import { priceLabel } from './compare'
import { fetchRoundResults, voteRevealedEvent, fmtTokens, pct, pctOfThreshold, isFinal, type RoundResults, type RequestResult } from './round-results'
import { fetchVoteSlashes, slashFor, roundSlashStats, fmtSlash, type VoteSlashes } from './slashes'
import { resolveAncillaryText, mapLimit } from './resolve'
import { SPINNER, roundNavDelta } from './tui'

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

export type ExplorerOpts = {
    startRound: number
    currentRound: number
    phase: number               // 0 = commit, 1 = reveal (at launch)
}

// Round data seen this process — module-level so a remounted explorer (or a
// second one) renders the last-known state instantly ("stale while
// revalidate") instead of an empty screen while the live round refetches
const sessionResults = new Map<number, RoundResults>()

// Embeddable explorer: calls onExit() when the user quits (q/esc) instead of
// tearing down the Ink root, so a shell app can mount it inside its own render.
// Round state is local by default; a wrapper (the votes screen) may pass
// `round` + `onRoundChange` to CONTROL the round instead — every
// round-navigation intent is then reported via onRoundChange and the wrapper
// decides the upper bound (the explorer still refuses to go below round 1).
// `active={false}` hides it (render null, inputs off, watcher off) while
// keeping cursor/scroll/state alive for an instant return.
export function ResultsExplorer({ opts, onExit, round: roundProp, onRoundChange, extraHint, active = true }: { opts: ExplorerOpts; onExit: () => void; round?: number; onRoundChange?: (r: number) => void; extraHint?: string; active?: boolean }) {
    const [localRound, setLocalRound] = useState(opts.startRound)
    const round = roundProp ?? localRound
    const [data, setData] = useState<RoundResults | undefined>(() => sessionResults.get(round))
    const [fetching, setFetching] = useState<number | undefined>()
    const [progress, setProgress] = useState<string | undefined>()
    const [frame, setFrame] = useState(0)
    const [error, setError] = useState<string | undefined>()
    const [cursor, setCursor] = useState(0)
    const [top, setTop] = useState(0)
    const [view, setView] = useState<'list' | 'detail'>('list')
    const [paused, setPaused] = useState(false)
    const [, tick] = useState(0)
    const roundRef = useRef(round)
    const seq = useRef(0)
    const slashes = useRef<VoteSlashes | undefined>()
    const slashesTried = useRef(false)

    // Live only for the current round in its reveal phase — past rounds are final
    const live = round === opts.currentRound && opts.phase === 1

    const inFlight = useRef(false)
    const load = (r: number, bypassCache = false) => {
        if (!bypassCache && sessionResults.has(r)) return
        const id = ++seq.current
        inFlight.current = true
        setFetching(r)
        setProgress(undefined)
        setError(undefined)
        fetchRoundResults(r, bypassCache, stage => {
            if (seq.current === id) setProgress(stage)
        }).then(d => {
            sessionResults.set(r, d)
            if (seq.current !== id) return // superseded by a newer fetch
            inFlight.current = false
            setFetching(undefined)
            setProgress(undefined)
            if (roundRef.current === r) setData(d)
        }).catch(e => {
            if (seq.current !== id) return
            inFlight.current = false
            setFetching(undefined)
            setProgress(undefined)
            if (roundRef.current === r) setError((e as Error).message.split('\n')[0])
        })
    }

    useEffect(() => {
        roundRef.current = round
        setCursor(0)
        setTop(0)
        // Stale-while-revalidate: keep showing the last-known data (live round
        // included) with the "refreshing…" tag while the fetch runs
        setData(sessionResults.get(round))
        load(round, live && sessionResults.has(round))
    }, [round])

    // Live refresh is event-driven, not timed: a light log watcher polls only
    // the newest blocks and a full refetch runs when a VoteRevealed for the
    // viewed round actually lands (skipped while one is already running)
    useEffect(() => {
        if (!live || paused || !active) return
        const unwatch = publicClient.watchEvent({
            address: votingContract.address,
            event: voteRevealedEvent,
            pollingInterval: 12_000,
            onLogs: logs => {
                if (roundRef.current !== round || inFlight.current) return
                if (logs.some(l => Number((l.args as { roundId?: number }).roundId) === round)) load(round, true)
            },
            onError: () => { /* transient RPC hiccup — next poll retries */ },
        })
        return unwatch
    }, [round, live, paused, active])

    // 1s re-render so "refreshed Ns ago" ticks
    useEffect(() => {
        const iv = setInterval(() => tick(x => x + 1), 1000)
        return () => clearInterval(iv)
    }, [])

    // Spinner while a fetch runs — the animation doubles as a liveness signal
    const spinning = fetching !== undefined && active
    useEffect(() => {
        if (!spinning) return
        const iv = setInterval(() => setFrame(f => f + 1), 120)
        return () => clearInterval(iv)
    }, [spinning])

    // Per-vote slash amounts (final rounds only) — one subgraph fetch per
    // explorer session; every round then matches against the map as it renders.
    // data.myAddress already resolves EXPECTED_VOTER, else the cached signing key.
    useEffect(() => {
        if (slashesTried.current || !data) return
        const voter = data.myAddress
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

    // Earnings only make sense once a round is over (nothing settles live).
    // The column shows on every final round — isFinal() so a round finalizing
    // mid-session gains it without a restart; without a signing key (or before
    // the subgraph answers) its cells are a dim "-".
    const isPast = isFinal(round)
    const showSlash = isPast && slashes.current !== undefined
    const slashStats = showSlash ? roundSlashStats(slashes.current!, rows) : undefined

    // clamped cursor move that keeps the scroll window showing it; ±1 for
    // arrows, ±WINDOW for pgup/pgdn
    const moveCursor = (delta: number) => setCursor(c => {
        const nc = Math.max(0, Math.min(Math.max(0, rows.length - 1), c + delta))
        if (nc < top) setTop(nc)
        else if (nc >= top + WINDOW) setTop(nc - WINDOW + 1)
        return nc
    })
    const cursorUp = () => moveCursor(-1)
    const cursorDown = () => moveCursor(1)
    const gotoRound = (r: number) => {
        if (r < 1 || r === round) return              // never below round 1, in either mode
        if (onRoundChange) onRoundChange(r)           // controlled: the wrapper owns the upper bound
        else if (r <= opts.currentRound) setLocalRound(r)
    }

    useInput((input, key) => {
        const roundDelta = roundNavDelta(input, key)
        if (view === 'detail') {
            if (key.escape || input === 'd' || input === 'q') setView('list')
            else if (input === 'r') load(round, true)
            else if (input === 'p' && live) setPaused(p => !p)
            else if (roundDelta) gotoRound(round + roundDelta)  // rounds: same keys as the list
            else if (key.leftArrow) cursorUp()                  // plain ←/→: prev/next request
            else if (key.rightArrow) cursorDown()
            return
        }
        // list view — [ ]/ctrl+←→ navigate ROUNDS here
        if (input === 'q' || key.escape) onExit()
        else if (input === 'r') load(round, true)
        else if (input === 'p' && live) setPaused(p => !p)
        else if (roundDelta) gotoRound(round + roundDelta)
        else if (key.upArrow || key.leftArrow) cursorUp()       // plain ←/→ alias ↑/↓ (arrows = questions everywhere)
        else if (key.downArrow || key.rightArrow) cursorDown()
        else if (key.pageUp) moveCursor(-WINDOW)
        else if (key.pageDown) moveCursor(WINDOW)
        else if ((input === 'd' || key.return) && row) setView('detail')
    }, { isActive: active })

    if (!active) return null

    const freshness = data ? `last fetched ${fmtAgo(data.fetchedAt)} ago` : ''
    const spin = <Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text>
    // "refreshing… scanning reveal logs — chunk 3/8" while a background
    // refetch runs (progress lines from fetchRoundResults)
    const refreshTag = fetching === round ? ` · refreshing…${progress ? ` ${progress}` : ''}` : ''
    // Participation so far: reveals land in per-voter batches, so the most-
    // revealed request tracks how much of the total stake has voted
    const maxRevealed = rows.reduce((m, t) => t.total > m ? t.total : m, 0n)
    const revealedPct = data && data.cumulativeStake > 0n && rows.length > 0
        ? pct(maxRevealed, data.cumulativeStake) : undefined
    const phaseCtx = round === opts.currentRound
        ? opts.phase === 1 ? `reveal phase, ${fmtCountdown(phaseEndsAt())} left` : 'commit phase'
        : 'past round (final)'
    const passing = rows.filter(t => t.quorumOk && t.consensusOk).length
    const header = (
        <Box flexDirection="column">
            <Text bold> Round {round} — {phaseCtx} · {rows.length} request(s) · {passing} passing{slashStats && slashStats.matched > 0 ? <> · your net: <Text color={slashStats.net < 0 ? 'red' : 'green'}>{(slashStats.net > 0 ? '+' : '') + slashStats.net.toFixed(3)} UMA</Text>{slashStats.pending > 0 ? <Text dimColor> · {slashStats.pending} pending</Text> : null}</> : null}{live && revealedPct ? <> · <Text color="cyan">{revealedPct}</Text> of stake revealed</> : null}{live ? (paused ? <Text color="yellow"> · paused</Text> : ' · live') : ''}{freshness ? <Text dimColor>  {freshness}{refreshTag}</Text> : null}</Text>
            {data && !data.myAddress && <Text color="yellow"> ⚠ your votes can't be marked — no EXPECTED_VOTER and no .signing-key.json (run `nub run init` or `nub run verify-key`)</Text>}
        </Box>
    )

    if (view === 'detail' && row && data) {
        const m = mineMarker(row)
        return (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
                <Text bold wrap="wrap">{row.question}</Text>
                <Text dimColor>round {round} · request {cur + 1}/{rows.length}{refreshTag}</Text>
                <Text> </Text>
                <Text>my vote:    {row.myPrice !== undefined
                    ? <Text color={m.color}>{fullPriceLabel(row.myPrice)} {row.myPrice === row.leadingPrice ? '✓ matches current majority' : '✗ differs from current majority'}</Text>
                    : row.myCommitted ? <Text color="gray">committed, not (yet) revealed</Text>
                    : data.myAddress ? <Text dimColor>none</Text>
                    : <Text color="yellow">unknown — no EXPECTED_VOTER and no .signing-key.json (run `nub run init` or `nub run verify-key`)</Text>}</Text>
                {isPast && (!row.quorumOk || !row.consensusOk)
                    ? <Text>earnings:   <Text dimColor>rolled — this round's votes were discarded; the request settles in the round where it resolves</Text></Text>
                    : <>
                        {isPast && !slashes.current && <Text>earnings:   <Text dimColor>- (unknown — no signing key or subgraph unavailable)</Text></Text>}
                        {showSlash && (() => {
                            const s = slashFor(slashes.current!, row.identifier, row.time, row.ancillaryData)
                            return <Text>earnings:   {!s
                                ? <Text dimColor>none — you had nothing at stake for this request</Text>
                                : s.pending ? <Text color="gray">pending — your slashing trackers haven't settled this request yet</Text>
                                : <Text color={Number(s.slashAmount) < 0 ? 'red' : 'green'}>{fmtSlash(s.slashAmount)} UMA {Number(s.slashAmount) < 0 ? 'lost' : 'earned'} through slashing</Text>}</Text>
                        })()}
                    </>}
                <Text>quorum:     {pctOfThreshold(row.total, data.minParticipation)} — {fmtTokens(row.total)}/{fmtTokens(data.minParticipation)} revealed/required {row.quorumOk ? <Text color="green">✓</Text> : <Text color="red">✗</Text>}</Text>
                <Text>consensus:  {pctOfThreshold(row.leadingTokens, data.minAgreement)} — {fmtTokens(row.leadingTokens)}/{fmtTokens(data.minAgreement)} leading/required {row.consensusOk ? <Text color="green">✓</Text> : <Text color="red">✗</Text>}</Text>
                <Text> </Text>
                <Text dimColor>price split — {fmtTokens(row.total)} revealed:</Text>
                {row.prices.map((s, i) => (
                    <Text key={s.price.toString()}>  <Text color={priceColor(s.price)} bold>{fullPriceLabel(s.price).slice(0, 20).padEnd(21)}</Text>{fmtTokens(s.tokens).padStart(8)}  {pct(s.tokens, row.total).padStart(6)}{i === 0 ? <Text dimColor>  ◀ leading</Text> : null}</Text>
                ))}
                <Text> </Text>
                <Text dimColor>←→ prev/next request · [ ]/ctrl+←→ round · r refetch{live ? ` · p ${paused ? 'resume' : 'pause'}` : ''} · esc/d/q back</Text>
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
            {!data && fetching === round && <Box justifyContent="center" paddingY={1}><Text dimColor>{spin} fetching round {round}…{progress ? ` ${progress}` : ''}</Text></Box>}
            {!data && fetching !== round && error && <Text color="red"> ⚠ {error} — r to retry</Text>}
            {data?.status === 'no-votes' && <Text dimColor> No reveals recorded — round {round} was never frozen (nothing was voted).</Text>}
            {data?.status === 'not-started' && <Text dimColor> Reveal phase hasn't started yet.</Text>}
            {data?.status === 'no-reveals' && <Text dimColor> No reveals yet in round {round}.</Text>}
            {rows.length > 0 && <>
                <Text dimColor>{'   '}{' #'} {'Mine'.padEnd(8)}{isPast ? 'Earnings'.padStart(10) + ' ' : ''}{'Question'.padEnd(QUESTION_WIDTH + 1)} {'Quorum'.padStart(7)} {'Consens'.padStart(7)}  Leading</Text>
                <Text dimColor> {topSafe > 0 ? `▲ ${topSafe} more` : '─'.repeat(10)}</Text>
                {slice.map((t, i) => {
                    const idx = topSafe + i
                    const isCur = idx === cur
                    const m = mineMarker(t)
                    return (
                        <Text key={idx} inverse={isCur} wrap="truncate-end">
                            {isCur ? ' › ' : '   '}
                            <Text dimColor>{String(idx + 1).padStart(2)} </Text>
                            <Text color={m.color} dimColor={m.dim} bold={!m.dim}>{m.label.padEnd(8)}</Text>
                            {isPast && (() => {
                                // Rolled requests settle in a later round — their slash entry
                                // (keyed per request, not per round) must not show here
                                if (!t.quorumOk || !t.consensusOk) return <Text dimColor>{'rolled'.padStart(10)} </Text>
                                if (!slashes.current) return <Text dimColor>{'-'.padStart(10)} </Text>
                                const s = slashFor(slashes.current, t.identifier, t.time, t.ancillaryData)
                                return !s ? <Text>{' '.repeat(11)}</Text>
                                    : s.pending ? <Text color="gray">{'pending'.padStart(10)} </Text>
                                    : <Text color={Number(s.slashAmount) < 0 ? 'red' : 'green'}>{fmtSlash(s.slashAmount).padStart(10)} </Text>
                            })()}
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
            <Text dimColor> ↑↓/pg move · d/enter details · [ ]/ctrl+←→ round · r refetch{live ? ` · p ${paused ? 'resume' : 'pause'}` : ''} · q quit</Text>
            {extraHint && <Text dimColor> {extraHint}</Text>}
        </Box>
    )
}
