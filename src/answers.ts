// Answers for a round, merged per vote across every installed addon.
//
// Each source (an addon, the pulled answers/<round>.json without a pulling
// addon, or ANSWERS_FILE on its own) gives at most one answer per vote. Per
// vote the host keeps every non-empty answer with the addon that gave it and
// its confidence, and derives one planned answer:
//   - one or more sources, all the same answer      → that answer
//   - two sources with different non-empty answers  → '' and `disagree`, so the
//     review leaves the vote for the owner
//   - no non-empty answer at all                    → ''
// An empty answer is "no opinion": it never counts as a disagreement, and a
// dead or throwing addon costs one visible line (`failures`) and nothing else.
// An answer carrying `conflict` (the source itself found the vote contested)
// is treated like a disagreement whatever the other sources say: '' and
// `disagree`, with the reason kept for the screen.
//
// The owner's saved review (answers/<round>.local.json) is not a source. It is
// laid over the merge by `reconcile`. A row he decided (typed, or confirmed
// in the review) is his: a source that moves after that is flagged, never
// applied. A row that only ever held a suggestion stays a suggestion: the
// review prefills it, a batch run does not sign it. ANSWERS_FILE is the one
// exception: when set it is the only source and the saved review is not read.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './config'
import { loadAddons, type AnswerSourcePlugin } from './addons'
import { consoleSink, captureConsole, type OutputSink } from './flows/sink'
import { sanitizeText, short, titleFromAncillary, type Answer } from './common'

export const NOT_RATED = 'not rated'

// Vote identity across sources: ancillaryData plus timestamp. A source that
// omits the timestamp is keyed by ancillaryData alone; `lookupVote` joins it
// with the timestamped entry for the same request.
export const voteKey = (a: { ancillaryData: string; timestamp?: number | bigint }) => `${a.ancillaryData}-${a.timestamp ?? ''}`.toLowerCase()

// One source's non-empty answer for a vote. `confidence` is the addon's own
// measured statement, carried through untouched; NOT_RATED when it gave none.
export type Suggestion = { addon: string; answer: string; confidence: string }

// One source's report that it found the vote contested, with its reason
export type Conflict = { addon: string; reason: string }

export type VoteAnswers = {
    ancillaryData: `0x${string}`
    timestamp?: number
    question: string
    suggestions: Suggestion[]
    conflicts: Conflict[]   // sources that flagged the vote as contested; any one makes `disagree` true
    answer: string          // the agreed answer; '' when no source answered or when they disagree
    disagree: boolean       // two sources gave different non-empty answers, or a source reported a conflict
}

export type SourceSummary = { addon: string; label: string; answered: number; total: number }

export type AnswersResult = {
    source: string                      // one line for logs and the round file
    answers: Answer[]                   // compat shape: per vote, the owner's saved answer if any, else the agreed one
    votes: Map<string, VoteAnswers>     // keyed by voteKey
    sources: SourceSummary[]            // every source that supplied anything
    failures: string[]                  // one plain line per addon that gave nothing or threw
    byAddon: Map<string, Answer[]>      // what each addon supplied, as delivered, for its own gate
    overrideFile?: string               // ANSWERS_FILE: the single authoritative source
    saved?: Map<string, SavedRow>       // the owner's saved review; never read under ANSWERS_FILE
}

type Source = { addon: string; label: string; answers: Answer[] }

const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase()

const settle = (v: VoteAnswers) => {
    const first = v.suggestions[0]
    v.disagree = v.conflicts.length > 0 || (!!first && v.suggestions.some(s => !same(s.answer, first.answer)))
    v.answer = v.disagree || !first ? '' : first.answer
    return v
}

// The reason a conflict field that is not a string stands as a conflict
export const MALFORMED_CONFLICT = 'malformed conflict field (not a string)'

// An addon's answers as the host will use them. Anything that is not an
// object with a string ancillaryData is dropped; a non-string answer,
// question or confidence is dropped from its entry (the entry stays, so the
// vote keeps its other fields). A non-string conflict fails closed: the field
// exists to hold a vote back, so a present, non-empty value of the wrong type
// (`true`, a number, an object) becomes a conflict with MALFORMED_CONFLICT as
// its reason, where dropping it would let another source fill the vote. An
// empty one (null, false, 0) is dropped like the rest. The array comes back
// untouched when nothing was wrong, so a gate that hashes it sees what was
// delivered.
export function sanitizeAnswers(answers: unknown[]): { answers: Answer[]; problems: number } {
    let problems = 0
    const out: Answer[] = []
    for (const raw of answers) {
        const a = raw as Partial<Answer> | null | undefined
        if (!a || typeof a !== 'object' || typeof a.ancillaryData !== 'string') { problems++; continue }
        let fixed: Answer | undefined
        const drop = (field: 'answer' | 'question' | 'confidence' | 'conflict') => {
            problems++
            fixed ??= { ...a } as Answer
            if (field === 'answer' || field === 'question') fixed[field] = ''
            else if (field === 'conflict' && a.conflict) fixed.conflict = MALFORMED_CONFLICT
            else delete fixed[field]
        }
        if (a.answer !== undefined && typeof a.answer !== 'string') drop('answer')
        if (a.question !== undefined && typeof a.question !== 'string') drop('question')
        if (a.confidence !== undefined && typeof a.confidence !== 'string') drop('confidence')
        if (a.conflict !== undefined && typeof a.conflict !== 'string') drop('conflict')
        out.push(fixed ?? a as Answer)
    }
    return { answers: problems === 0 ? answers as Answer[] : out, problems }
}

// The per-vote merge over sources in the order they were asked.
export function mergeSources(sources: Source[]): Map<string, VoteAnswers> {
    const votes = new Map<string, VoteAnswers>()
    for (const s of sources) {
        for (const a of s.answers) {
            if (!a || typeof a.ancillaryData !== 'string') continue
            const key = voteKey(a)
            let v = votes.get(key)
            if (!v) {
                v = { ancillaryData: a.ancillaryData, timestamp: a.timestamp, question: '', suggestions: [], conflicts: [], answer: '', disagree: false }
                votes.set(key, v)
            }
            if (!v.question && typeof a.question === 'string') v.question = a.question
            if (typeof a.conflict === 'string' && a.conflict.trim() !== '') v.conflicts.push({ addon: s.addon, reason: a.conflict.trim() })
            const answer = typeof a.answer === 'string' ? a.answer : ''
            if (answer.trim() === '' || a.skip === true) continue
            v.suggestions.push({ addon: s.addon, answer, confidence: (typeof a.confidence === 'string' && a.confidence.trim()) || NOT_RATED })
        }
    }
    for (const v of votes.values()) settle(v)
    return votes
}

// The merged vote for one request. A source that omits timestamps is keyed by
// ancillaryData alone; when both a timestamped and a timestamp-less entry
// exist for the request their suggestions are joined into one vote, so the two
// agree or disagree in the open instead of one silently winning.
export function lookupVote(votes: Map<string, VoteAnswers>, request: { ancillaryData: string; timestamp: number | bigint }): VoteAnswers | undefined {
    const timed = votes.get(voteKey(request))
    const untimed = votes.get(voteKey({ ancillaryData: request.ancillaryData }))
    if (!timed || !untimed) return timed ?? untimed
    return settle({
        ancillaryData: timed.ancillaryData, timestamp: timed.timestamp, question: timed.question || untimed.question,
        suggestions: [...timed.suggestions, ...untimed.suggestions], conflicts: [...timed.conflicts, ...untimed.conflicts], answer: '', disagree: false,
    })
}

// What this round's requests look like across the sources, each request
// joined like lookupVote joins it: a timed and an untimed entry for one
// request are one vote here, so a P1 from one and a P2 from the other count
// as the disagreement the row shows. Counting the raw map instead missed
// exactly those. `anyAnswer` is whether anything is there to work with: a
// source answered some request (agreed or not), or the saved review holds an
// answer.
export function roundOverview(votes: Map<string, VoteAnswers>, requests: Array<{ ancillaryData: string; timestamp: number | bigint }>, saved: Map<string, SavedRow> | undefined): { disagreements: VoteAnswers[]; anyAnswer: boolean } {
    const joined = requests.map(r => lookupVote(votes, r)).filter((v): v is VoteAnswers => v !== undefined)
    return {
        disagreements: joined.filter(v => v.disagree),
        anyAnswer: joined.some(v => v.suggestions.length > 0) || [...(saved?.values() ?? [])].some(s => s.answer.trim() !== ''),
    }
}

// The title a planned row shows: the sources' question, else the one the
// request's own ancillary text carries, else the title the saved review kept
// from an earlier session (given by a source that is gone now, or resolved
// by that review). undefined leaves the caller its placeholder.
export function rowTitle(vote: { question: string } | undefined, saved: { question?: string } | undefined, ancillaryData: `0x${string}`): string | undefined {
    return (vote?.question ? sanitizeText(vote.question) : undefined) || titleFromAncillary(ancillaryData) || saved?.question || undefined
}

// One row of the saved review. `decided` is true for the owner's own answer:
// typed by him, or confirmed in the review. false is a suggestion the review
// prefilled that he never confirmed. Files from before the flag existed read
// as decided where the answer differs from its basis (the old "override").
// `question` is the title that review showed, so a later one with every
// source gone still shows it.
export type SavedRow = { answer: string; basis: string | undefined; decided?: boolean; question?: string }   // basis undefined: a file from before the basis was recorded

export type Reconciled = {
    answer: string                          // what the review opens with
    basis: string                           // the source value this answer was last judged against; persisted with the row
    decided: boolean                        // the answer is the owner's own; false = a suggestion he has not confirmed
    sourceChanged?: { from: string; to: string }       // decided row: the agreed source answer moved since he decided
    suggestionChanged?: { from: string; to: string }   // suggestion row: the suggestion is not the one he last saw
}

// Three-way merge of one vote: the sources' agreed answer, the owner's saved
// answer, and the basis that answer was saved against.
//   decided row:                his answer stays whatever the sources say now;
//                               a source that moved is flagged, and the basis
//                               stays so the flag persists until he re-enters
//                               the row. A source that comes round to his
//                               answer is re-based, and a later move away from
//                               it is flagged against that.
//   suggestion row:             follows the sources, flagged when the
//                               suggestion changed; still not his
//   sources give nothing:       keep what was saved (a dead source is not "")
//   sources disagree:           a suggestion row opens blank for him to
//                               decide, a decided row keeps his answer
export function reconcile(vote: VoteAnswers | undefined, saved: SavedRow | undefined): Reconciled {
    const current = vote?.answer ?? ''
    const present = (vote?.suggestions.length ?? 0) > 0
    const disagree = vote?.disagree ?? false
    if (!saved) return { answer: current, basis: current, decided: false }
    const basis = saved.basis === undefined ? saved.answer : saved.basis
    const decided = saved.decided ?? !same(saved.answer, basis)
    if (decided) {
        if (!present || disagree || same(current, basis)) return { answer: saved.answer, basis, decided }
        if (same(current, saved.answer)) return { answer: saved.answer, basis: current, decided }
        return { answer: saved.answer, basis, decided, sourceChanged: { from: basis, to: current } }
    }
    if (disagree) return { answer: '', basis, decided }
    if (!present || same(current, basis)) return { answer: present ? current : saved.answer, basis, decided }
    return basis === ''
        ? { answer: current, basis: current, decided }     // nothing was shown before: the source simply published
        : { answer: current, basis: current, decided, suggestionChanged: { from: basis, to: current } }
}

// The owner's saved review, keyed by vote. Text sanitized at ingestion like
// every other file read. Unreadable → undefined, as if nothing was saved.
export function loadSavedReview(roundId: number): Map<string, SavedRow> | undefined {
    const file = path.join(ROOT, 'answers', `${roundId}.local.json`)
    if (!existsSync(file)) return undefined
    try {
        const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<Answer & { source?: string; decided?: boolean }>
        return new Map(rows.map(a => [voteKey(a), {
            answer: sanitizeText(a.answer ?? ''),
            basis: a.source === undefined ? undefined : sanitizeText(a.source),
            decided: typeof a.decided === 'boolean' ? a.decided : undefined,
            question: typeof a.question === 'string' && a.question.trim() !== '' ? sanitizeText(a.question) : undefined,
        }]))
    } catch { return undefined }
}

export type CollectOpts = {
    pull?: boolean          // call pullAnswers for an addon whose getAnswers gave nothing (the commit flow)
    refetch?: boolean       // r / --refetch: pull first, so a cached copy is bypassed
    review?: boolean        // the interactive review will show the answers; passed to each addon (see AnswersContext)
    out?: OutputSink        // where addon console output lands (progress, provenance, trust warnings)
    addons?: AnswerSourcePlugin[]   // tests inject fakes; default: the installed addons
    timeoutMs?: number      // how long one addon call may take (tests shorten it); default ADDON_TIMEOUT_MS
}

// An addon that never settles would hold the review shut. After this long
// its call is given up and costs the one line a throw costs; the others
// carry on. Long enough for a slow upstream (the dApp resolver plus a chain
// read per vote on a 30-vote round is a few seconds; its fetches give up
// after 15 s each).
export const ADDON_TIMEOUT_MS = 60_000

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]
// The one line for an addon that returned nothing: no ⚠, it did not fail
export const passedLine = (addon: string, roundId: number) => `${addon}: nothing for round ${roundId} (passed, not a failure)`
const malformedLine = (source: string, problems: number) => `⚠ ${source}: ${problems} malformed answer field(s) (non-string values) dropped, a malformed conflict kept as a conflict; the rest is used`

// Ask every source and merge. Never throws for an addon's sake: a failure is a
// line in `failures` and the others carry on.
export async function collectAnswers(roundId: number, opts: CollectOpts = {}): Promise<AnswersResult> {
    const out = opts.out ?? consoleSink
    const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Answer[]

    // Read at call time (config.ts loads .env into the environment at import),
    // so a test can set it per case
    const ANSWERS_FILE = process.env.ANSWERS_FILE
    if (ANSWERS_FILE) {
        // An explicit instruction: the only source, merged with nothing, the
        // saved review included (no `saved` in the result).
        const { answers, problems } = sanitizeAnswers(readJson(ANSWERS_FILE))
        const votes = mergeSources([{ addon: 'ANSWERS_FILE', label: ANSWERS_FILE, answers }])
        return {
            source: ANSWERS_FILE, answers, votes,
            sources: [{ addon: 'ANSWERS_FILE', label: ANSWERS_FILE, answered: [...votes.values()].filter(v => v.answer).length, total: answers.length }],
            failures: problems > 0 ? [malformedLine('ANSWERS_FILE', problems)] : [], byAddon: new Map(), overrideFile: ANSWERS_FILE,
        }
    }

    const addons = opts.addons ?? await captureConsole(out, loadAddons)
    const sources: Source[] = []
    const failures: string[] = []
    const byAddon = new Map<string, Answer[]>()
    const pulledFile = path.join(ROOT, 'answers', `${roundId}.json`)

    for (const addon of addons) {
        let r: { source: string; answers: Answer[] } | undefined
        // An addon that explains itself (its own line saying it has nothing
        // for this round) gets no second line from the host; a silent pass does
        let spoke = false
        const heard: OutputSink = {
            log: l => { spoke = true; out.log(l) },
            warn: l => { spoke = true; out.warn(l) },
            error: l => { spoke = true; out.error(l) },
        }
        const ctx = { review: !!opts.review }
        const timeoutMs = opts.timeoutMs ?? ADDON_TIMEOUT_MS
        // A call that outlives the timeout is treated as a throw: one line,
        // nothing else. The abandoned promise keeps running; its late console
        // output still reaches `out` through the capture it is wrapped in.
        const call = async (what: 'getAnswers' | 'pullAnswers') => {
            const verb = what === 'pullAnswers' ? 'pull' : 'answers'
            let timer: NodeJS.Timeout | undefined
            const gaveUp = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
            try {
                const r = await Promise.race([captureConsole(heard, () => what === 'getAnswers' ? addon.getAnswers(roundId, ctx) : addon.pullAnswers!(roundId)), gaveUp])
                if (r === 'timeout') { failures.push(`⚠ ${addon.name}: ${verb} timed out after ${timeoutMs / 1000} s`); return undefined }
                return r
            } catch (e) {
                failures.push(`⚠ ${addon.name}: ${verb} failed (${firstLine(e)})`)
                return undefined
            } finally { clearTimeout(timer) }
        }
        const canPull = !!opts.pull && typeof addon.pullAnswers === 'function'
        if (canPull && opts.refetch) {
            out.log(`Re-fetching round ${roundId} answers via addon "${addon.name}"...`)
            r = await call('pullAnswers')
        }
        if (!r) r = await call('getAnswers')
        if (!r && canPull && !opts.refetch) {
            out.log(`${addon.name}: nothing cached for round ${roundId} — pulling from upstream...`)
            r = await call('pullAnswers')
        }
        if (!r) {
            // Returning nothing is the addon passing on the round, not a
            // failure (a throw is one, reported above with ⚠); still one line
            if (!spoke && !failures.some(f => f.startsWith(`⚠ ${addon.name}:`))) failures.push(passedLine(addon.name, roundId))
            continue
        }
        if (!Array.isArray(r.answers)) {
            failures.push(`⚠ ${addon.name}: returned no answers array — ignored`)
            continue
        }
        // Bad fields are dropped here, with one line, so a malformed entry
        // cannot abort the run further down
        const { answers, problems } = sanitizeAnswers(r.answers)
        if (problems > 0) failures.push(malformedLine(addon.name, problems))
        sources.push({ addon: addon.name, label: r.source, answers })
        byAddon.set(addon.name, answers)
    }

    // answers/<round>.json is a pulling addon's cache (it serves and gates it);
    // only without one is it a plain, unrated source the owner saved by hand.
    if (!addons.some(a => typeof a.pullAnswers === 'function') && existsSync(pulledFile)) {
        try {
            const { answers, problems } = sanitizeAnswers(readJson(pulledFile))
            if (problems > 0) failures.push(malformedLine(`answers/${roundId}.json`, problems))
            sources.push({ addon: `answers/${roundId}.json`, label: `answers/${roundId}.json (local file)`, answers })
        }
        catch (e) { failures.push(`⚠ answers/${roundId}.json: unreadable (${firstLine(e)})`) }
    }

    const votes = mergeSources(sources)
    const summaries: SourceSummary[] = sources.map(s => ({
        addon: s.addon, label: s.label,
        answered: s.answers.filter(a => typeof a?.answer === 'string' && a.answer.trim() !== '' && a.skip !== true).length,
        total: s.answers.length,
    }))

    // Compat array: each vote reconciled with the owner's saved review, the
    // same way the commit review opens it
    const saved = loadSavedReview(roundId)
    const answers: Answer[] = [...votes.values()].map(v => ({
        ancillaryData: v.ancillaryData, timestamp: v.timestamp, question: v.question,
        answer: reconcile(v, saved?.get(voteKey(v))).answer,
    }))
    if (saved) {
        // Votes only the saved review knows (every source dead) still carry titles and his answers
        const file = path.join(ROOT, 'answers', `${roundId}.local.json`)
        try {
            for (const a of readJson(file)) if (!votes.has(voteKey(a))) answers.push({ ancillaryData: a.ancillaryData, timestamp: a.timestamp, question: a.question, answer: a.answer })
        } catch { /* loadSavedReview already read it once; a race here is harmless */ }
    }

    const source = summaries.length > 0
        ? summaries.map(s => `${s.addon} (${s.answered} of ${s.total})`).join(', ') + (saved ? ' + your saved review' : '')
        : saved ? `answers/${roundId}.local.json (your saved review; no source answered)` : '(no source answered)'
    return { source, answers, votes, sources: summaries, failures, byAddon, saved }
}

// The basis to persist with a reviewed row. A row the owner changed in this
// review is judged against the sources' current agreed value; a row he left
// alone keeps the basis `reconcile` settled on, so a decided row stays judged
// against what it was decided against and a flagged move stays flagged until
// he re-enters it.
export function nextBasis(row: { answer: string; prefilled: string; sourceAnswer: string; basis: string }): string {
    return row.answer !== row.prefilled ? row.sourceAnswer : row.basis
}

// Whether a reviewed row is the owner's own after this review. Confirming
// (y on the commit modal) makes every answered row his; quitting makes only
// the rows he changed his. A row that was already his stays his, a blank
// included (a deliberate clear). An untouched suggestion stays a suggestion.
export function nextDecided(row: { answer: string; prefilled: string; decided: boolean }, confirmed: boolean): boolean {
    return row.decided || row.answer !== row.prefilled || (confirmed && row.answer !== '')
}

// What a batch run (--yes, piped, --dry-run) may sign for a row: the owner's
// decided answer, or what the sources agree on right now. A suggestion saved
// by a review nobody confirmed is not an answer; with the source gone it
// counts as unanswered.
export function batchAnswer(merged: Reconciled, vote: VoteAnswers | undefined): string {
    return merged.decided ? merged.answer : vote?.answer ?? ''
}

// A vote the sources disagree on (or one a source reported a conflict on)
// that the owner never decided. A row he decided to clear is decided: nothing
// is signed for it, nothing blocks.
type Contested = { disagree: boolean; answer: string; decided?: boolean; onchainPrice?: bigint }
const undecided = (r: Contested) => r.disagree && r.answer === '' && !r.decided

// Batch runs cannot pick a side: an undecided disagreement blocks the run,
// unless the vote is already committed on chain. Nothing would be sent for
// that vote either way (a batch run never replaces a commitment, see
// keepsCommitment), so it is left as committed (`committedContested`) rather
// than aborting the rest. With the on-chain diff unknown (the fetch failed)
// every onchainPrice is undefined and every such vote blocks: fail closed.
export function blockedInBatch<T extends Contested>(rows: T[]): T[] {
    return rows.filter(r => undecided(r) && r.onchainPrice === undefined)
}

// The undecided disagreements a batch run leaves as committed, for the list
// under "left as committed"
export function committedContested<T extends Contested>(rows: T[]): T[] {
    return rows.filter(r => undecided(r) && r.onchainPrice !== undefined)
}

// A batch run never replaces a commitment the owner already made on chain
// (through the dApp, an earlier build, or an earlier run): that commitment is
// his choice. So is a decided answer in his saved review, and when the two
// differ nobody in a batch run can tell which came later or which he meant
// (he confirmed P1 here, then recommitted P2 in the dApp). Any row whose
// planned price differs from the committed one is left as committed and the
// difference is reported; the interactive review is where he picks one.
export function keepsCommitment(row: { price?: bigint; onchainPrice?: bigint }): boolean {
    return row.price !== undefined && row.onchainPrice !== undefined && row.price !== row.onchainPrice
}

// Why a planned row has nothing a batch run can sign, in words that are true
// for the row: unmatched by every source, contested, cleared by the owner, a
// stale suggestion, or nothing from anyone. undefined when the row has an
// answer (the price check is the caller's).
export function rowProblem(row: {
    question: string; identifierDecoded: string; time: bigint; ancillaryData: string
    answer: string                  // what a batch run would sign ('' = nothing)
    mergedAnswer: string            // what the review would open with
    decided: boolean
    sourceAnswer: string
    suggestions: Suggestion[]
    conflicts: Conflict[]
    disagree: boolean
    known: boolean                  // some source or the saved review knows the vote
}): string | undefined {
    const q = `"${row.question}"`
    if (!row.known) return `UNMATCHED  ${row.identifierDecoded} @ ${row.time} — no source knows ancillaryData ${short(row.ancillaryData)}`
    if (row.answer !== '') return undefined
    const sides = [
        ...row.suggestions.map(x => `${x.addon} ${x.answer}`),
        ...row.conflicts.map(c => `${c.addon} sees a conflict (${c.reason})`),
    ].join(' vs ')
    if (row.decided) {
        if (row.disagree) return `CLEARED    ${q} — you cleared this one; ${sides}; nothing is signed for it`
        if (row.sourceAnswer !== '') return `CLEARED    ${q} — you cleared this one; the sources say ${row.sourceAnswer}; nothing is signed for it`
        return `CLEARED    ${q} — you cleared this one and no source answers it; nothing is signed for it`
    }
    if (row.disagree) return `DISAGREE   ${q} — ${sides}; decide it yourself`
    if (row.mergedAnswer !== '') return `UNCONFIRMED ${q} — the saved review holds the suggestion ${row.mergedAnswer} you never confirmed, and no source answers now`
    return `NO ANSWER  ${q} — no source answered this one`
}

// What the review shows for a row right now, as the owner edits it: the
// rules of nextDecided and nextBasis applied to the unsaved state. A row he
// typed over is his from that keystroke, and a move flagged against the
// prefilled value no longer applies (the save re-bases it); typing the
// prefilled value back restores the prefilled state.
export function reviewStatus<T extends { answer: string; decided?: boolean; sourceChanged?: { from: string; to: string }; suggestionChanged?: { from: string; to: string } }>(row: T, prefilled: string): { decided: boolean; sourceChanged?: T['sourceChanged']; suggestionChanged?: T['suggestionChanged'] } {
    const edited = row.answer !== prefilled
    return {
        decided: !!row.decided || edited,
        sourceChanged: edited ? undefined : row.sourceChanged,
        suggestionChanged: edited ? undefined : row.suggestionChanged,
    }
}

// The answers an addon's gate may check: what it supplied, or the override
// file, which is nobody's and goes through every gate.
export function answersForGate(result: AnswersResult, addon: string): Answer[] | undefined {
    if (result.overrideFile) return result.answers
    const own = result.byAddon.get(addon)
    return own && own.length > 0 ? own : undefined
}
