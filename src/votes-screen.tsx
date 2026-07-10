// Unified "Votes" screen (Ink). The uma dashboard's landing page, phase-aware
// like vote.uma.xyz: one screen joins the commit review and the results
// explorer. Owns the round the user is looking at (starting at the current
// round); the MODE derives from it — the current round during its commit
// phase shows the embedded commit flow, everything else (past rounds, or the
// current round in reveal) shows the results explorer in controlled-round
// mode. App-wide key convention: plain ←/→ = prev/next QUESTION, [ ]/ctrl+←→
// = prev/next ROUND — everywhere in both modes, including inside the commit
// review (except its custom-price input and confirm modal) — so stepping back
// to the current round during commit phase flips straight into the commit
// flow. CommitScreen mounts lazily on first entry into commit mode and then
// stays mounted (hidden via `active`) while the user browses past rounds —
// its flow parks on a promise and must not restart, and the review's edits
// survive — until a phase-boundary rollover retires it (keyed by round).
// In results mode s/u/c/w/R/r fire onAction (stake/unstake/claim
// overlay, wallet screen, embedded reveal flow, refresh) — the app returns
// here afterwards. This screen is the app root: q/esc in either mode calls
// onExit(), which QUITS the app.
import React, { useEffect, useRef, useState } from 'react'
import { useInput } from 'ink'
import { ResultsExplorer, type ExplorerOpts } from './results-ui'
import { CommitScreen } from './commit-screen'

export type VotesAction = 'stake' | 'unstake' | 'claim' | 'wallet' | 'reveal' | 'refresh' | 'about'

export function VotesScreen({ opts, onExit, onAction, active = true }: { opts: ExplorerOpts; onExit: () => void; onAction: (a: VotesAction) => void; active?: boolean }) {
    const [round, setRound] = useState(opts.currentRound)
    const mode: 'commit' | 'results' = round === opts.currentRound && opts.phase === 0 ? 'commit' : 'results'

    // Phase-boundary rollover while the app is open: if the user is sitting on
    // the round that just closed, follow into the new current round — the same
    // phase-aware default as at launch. A past round being browsed stays put.
    const prevCurrent = useRef(opts.currentRound)
    useEffect(() => {
        if (opts.currentRound === prevCurrent.current) return
        if (round === prevCurrent.current) setRound(opts.currentRound)
        prevCurrent.current = opts.currentRound
    }, [opts.currentRound])

    // Global action shortcuts, results mode only (the commit review owns s/c/v
    // etc. for docs/comments/answers). Keys are disjoint from the explorer's,
    // so both handlers can be active at once — except r, which the explorer
    // also handles (round refetch); both firing is intended (r = refresh everything).
    useInput(input => {
        if (input === 's') onAction('stake')
        else if (input === 'u') onAction('unstake')
        else if (input === 'c') onAction('claim')
        else if (input === 'w') onAction('wallet')
        else if (input === 'R') onAction('reveal')
        else if (input === 'r') onAction('refresh')
        else if (input === 'i') onAction('about')
    }, { isActive: active && mode === 'results' })

    // Lazy mount, then keep-alive: once commit mode has been entered the
    // CommitScreen never unmounts (its running flow would be lost) — it just
    // goes inactive while a past round is on screen
    const [commitMounted, setCommitMounted] = useState(mode === 'commit')
    if (mode === 'commit' && !commitMounted) setCommitMounted(true)

    // Single clamp for every round-navigation intent, both modes: 1..currentRound
    const gotoRound = (r: number) => setRound(Math.min(opts.currentRound, Math.max(1, r)))

    return (
        <>
            {/* keyed by round: a rollover retires the old round's parked flow
                and a fresh commit flow starts for the new round */}
            {commitMounted && <CommitScreen key={opts.currentRound} active={active && mode === 'commit'} onExit={onExit} onRoundNav={delta => gotoRound(round + delta)} onAbout={() => onAction('about')} />}
            {mode === 'results' && <ResultsExplorer active={active} opts={opts} round={round} onRoundChange={gotoRound} onExit={onExit} extraHint="s stake · u unstake · c claim · w wallet · R reveal · i about · q quit" />}
        </>
    )
}
