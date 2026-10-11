// Tests for the per-vote merge of answer sources and the owner-wins
// reconciliation, run offline with fake addons:
//
//   nub run test        (= nub src/answers.test.ts)
//
// What they pin down: an addon that returns nothing, throws, hangs or returns
// no array costs one line and nothing else; agreement merges to one answer; two different answers are
// a disagreement left blank; an empty answer is never a disagreement; the
// owner's decided answer survives a moved source across sessions and is
// flagged, not replaced, even when the source first agreed with him; a
// suggestion he never confirmed stays a suggestion and is not signed in batch;
// confirming is what makes a suggestion his; ANSWERS_FILE is read alone; a
// timestamp-less source merges with a timestamped one; a refresh with every
// source dead keeps the saved review; each gate sees only its own addon's
// answers; an addon on the original interface still works; a batch run with
// an undecided disagreement is blocked unless that vote is already committed
// on chain; and MULTIPLE_VALUES encodes as the dApp does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './config'
import { encodePrice, decodeMultipleValues, describePrice, multipleValuesLabels, priceProblem, typedPriceProblem, P1_VALUE, P2_VALUE, P4_VALUE, UNRESOLVABLE_VALUE, type Answer } from './common'
import { priceLabel } from './compare'
import type { AnswerSourcePlugin } from './addons'
import { collectAnswers, mergeSources, lookupVote, roundOverview, rowTitle, reconcile, nextBasis, nextDecided, batchAnswer, blockedInBatch, committedContested, keepsCommitment, rowProblem, reviewStatus, sanitizeAnswers, answersForGate, loadSavedReview, voteKey, NOT_RATED, MALFORMED_CONFLICT } from './answers'
import { pinnedWarnings } from './tui'

const quiet = { log() {}, warn() {}, error() {} }
const AD = '0xaa' as const, AD2 = '0xbb' as const
const a = (answer: string, over: Partial<Answer> = {}): Answer => ({ ancillaryData: AD, timestamp: 1, question: 'q', answer, ...over })
const addon = (name: string, answers: Answer[] | undefined, extra: Partial<AnswerSourcePlugin> = {}): AnswerSourcePlugin =>
    ({ name, async getAnswers() { return answers && { source: `${name} src`, answers } }, ...extra })
// A round id no real round reaches for centuries, so a saved review written by
// a test cannot collide with the owner's files
const ROUND = 900_000_000
const savedFile = path.join(ROOT, 'answers', `${ROUND}.local.json`)
const writeSaved = (rows: Array<Answer & { source?: string }>) => { mkdirSync(path.dirname(savedFile), { recursive: true }); writeFileSync(savedFile, JSON.stringify(rows)) }
const dropSaved = () => { if (existsSync(savedFile)) rmSync(savedFile) }

test('a dead addon (undefined) leaves the others working and costs one line', async () => {
    const r = await collectAnswers(ROUND, { out: quiet, addons: [addon('dead', undefined), addon('live', [a('P1')])] })
    // no ⚠: returning nothing is the addon passing, not failing
    assert.deepEqual(r.failures, [`dead: nothing for round ${ROUND} (passed, not a failure)`])
    assert.equal(r.votes.get(voteKey(a('')))!.answer, 'P1')
    assert.deepEqual([...r.byAddon.keys()], ['live'])
})

test('a throwing addon is reported and does not block the others', async () => {
    const boom: AnswerSourcePlugin = { name: 'boom', async getAnswers() { throw new Error('upstream 500\nstack') } }
    const r = await collectAnswers(ROUND, { out: quiet, addons: [boom, addon('live', [a('P2')])] })
    assert.deepEqual(r.failures, ['⚠ boom: answers failed (upstream 500)'])
    assert.equal(r.answers.length, 1)
    assert.equal(r.answers[0].answer, 'P2')
})

test('an addon that never settles is given up after the timeout, one line, the others unaffected', async () => {
    const hung: AnswerSourcePlugin = { name: 'hung', getAnswers: () => new Promise(() => {}) }
    const r = await collectAnswers(ROUND, { out: quiet, timeoutMs: 50, addons: [hung, addon('live', [a('P2')])] })
    assert.deepEqual(r.failures, ['⚠ hung: answers timed out after 0.05 s'])
    assert.equal(r.answers.length, 1)
    assert.equal(r.answers[0].answer, 'P2')
    assert.deepEqual([...r.byAddon.keys()], ['live'])
    // the pull path is covered by the same race
    const hungPull: AnswerSourcePlugin = { name: 'hung', async getAnswers() { return undefined }, pullAnswers: () => new Promise(() => {}) }
    const p = await collectAnswers(ROUND, { out: quiet, pull: true, timeoutMs: 50, addons: [hungPull] })
    assert.deepEqual(p.failures, ['⚠ hung: pull timed out after 0.05 s'])
})

test('an addon that returns no answers array is ignored with one line, the others unaffected', async () => {
    const bad = { name: 'bad', async getAnswers() { return { source: 'bad src', answers: 'P1' as unknown as Answer[] } } }
    const r = await collectAnswers(ROUND, { out: quiet, addons: [bad, addon('live', [a('P1')])] })
    assert.deepEqual(r.failures, ['⚠ bad: returned no answers array — ignored'])
    assert.deepEqual(r.sources.map(s => s.addon), ['live'])
    assert.deepEqual([...r.byAddon.keys()], ['live'])
    assert.equal(r.votes.get(voteKey(a('')))!.answer, 'P1')
})

test('two addons that agree merge to one answer with both suggestions', () => {
    const v = mergeSources([{ addon: 'x', label: '', answers: [a('P1', { confidence: '100%, 9 of 9' })] }, { addon: 'y', label: '', answers: [a('p1')] }]).get(voteKey(a('')))!
    assert.equal(v.answer, 'P1')
    assert.equal(v.disagree, false)
    assert.deepEqual(v.suggestions, [{ addon: 'x', answer: 'P1', confidence: '100%, 9 of 9' }, { addon: 'y', answer: 'p1', confidence: NOT_RATED }])
})

test('two addons that disagree are flagged and the vote opens blank', () => {
    const v = mergeSources([{ addon: 'x', label: '', answers: [a('P1')] }, { addon: 'y', label: '', answers: [a('P2')] }]).get(voteKey(a('')))!
    assert.equal(v.disagree, true)
    assert.equal(v.answer, '')
    assert.deepEqual(reconcile(v, undefined), { answer: '', basis: '', decided: false })
    assert.deepEqual(blockedInBatch([{ disagree: v.disagree, answer: reconcile(v, undefined).answer }]).length, 1)
})

test('an empty answer next to a real one is not a disagreement', () => {
    const votes = mergeSources([
        { addon: 'x', label: '', answers: [a(''), a('P4', { ancillaryData: AD2 })] },
        { addon: 'y', label: '', answers: [a('P1'), a('', { ancillaryData: AD2 }), a('P3', { ancillaryData: AD2, skip: true })] },
    ])
    const v1 = votes.get(voteKey(a('')))!, v2 = votes.get(voteKey(a('', { ancillaryData: AD2 })))!
    assert.equal(v1.disagree, false); assert.equal(v1.answer, 'P1'); assert.equal(v1.suggestions.length, 1)
    assert.equal(v2.disagree, false); assert.equal(v2.answer, 'P4'); assert.equal(v2.suggestions.length, 1)
})

const vote = (answer: string) => mergeSources([{ addon: 'x', label: '', answers: [a(answer)] }]).get(voteKey(a('')))
// What the review saves for one row after a session: the basis and whether
// the row is the owner's, exactly as commit-flow computes them
const save = (answer: string, prefilled: { answer: string; basis: string; decided: boolean }, sourceAnswer: string, confirmed = false) => ({
    answer,
    basis: nextBasis({ answer, prefilled: prefilled.answer, sourceAnswer, basis: prefilled.basis }),
    decided: nextDecided({ answer, prefilled: prefilled.answer, decided: prefilled.decided }, confirmed),
})

test("the owner's decided answer survives a moved source over two sessions, flagged, never replaced", () => {
    // session 1: source P1, he enters P2 and quits; the review saves basis = P1, his
    const s1 = reconcile(vote('P1'), undefined)
    assert.deepEqual(s1, { answer: 'P1', basis: 'P1', decided: false })
    const saved1 = save('P2', s1, 'P1')
    assert.deepEqual(saved1, { answer: 'P2', basis: 'P1', decided: true })
    // session 2: the source moved to P3 — his P2 stays and the move is flagged
    const s2 = reconcile(vote('P3'), saved1)
    assert.deepEqual(s2, { answer: 'P2', basis: 'P1', decided: true, sourceChanged: { from: 'P1', to: 'P3' } })
    // he leaves the row alone: the basis persists, so session 3 still shows the flag
    const s3 = reconcile(vote('P3'), save('P2', s2, 'P3'))
    assert.deepEqual(s3, { answer: 'P2', basis: 'P1', decided: true, sourceChanged: { from: 'P1', to: 'P3' } })
    // in session 3 he picks P4: re-based on the current source, flag gone
    assert.deepEqual(reconcile(vote('P3'), save('P4', s3, 'P3')), { answer: 'P4', basis: 'P3', decided: true })
    // the source returning nothing keeps his answer and his basis
    assert.deepEqual(reconcile(vote(''), saved1), { answer: 'P2', basis: 'P1', decided: true })
    assert.deepEqual(reconcile(undefined, saved1), { answer: 'P2', basis: 'P1', decided: true })
    // a disagreement keeps his answer
    const d = mergeSources([{ addon: 'x', label: '', answers: [a('P1')] }, { addon: 'y', label: '', answers: [a('P2')] }]).get(voteKey(a('')))
    assert.deepEqual(reconcile(d, saved1), { answer: 'P2', basis: 'P1', decided: true })
    // a file from before the flag existed: an answer that differs from its basis is his
    assert.deepEqual(reconcile(vote('P3'), { answer: 'P2', basis: 'P1' }), { answer: 'P2', basis: 'P1', decided: true, sourceChanged: { from: 'P1', to: 'P3' } })
})

test('a source that comes round to his answer and then moves again is flagged, not applied (two-step move)', () => {
    // he entered P2 against a source saying P1
    const saved1 = { answer: 'P2', basis: 'P1', decided: true }
    // the source now says P2: no flag, re-based on P2, still his
    const s2 = reconcile(vote('P2'), saved1)
    assert.deepEqual(s2, { answer: 'P2', basis: 'P2', decided: true })
    const saved2 = save('P2', s2, 'P2')
    assert.deepEqual(saved2, { answer: 'P2', basis: 'P2', decided: true })
    // the source amends to P1: his P2 stands and the move is flagged. The old
    // code re-read this row as untouched and planned P1 while saying his P2 stood.
    const s3 = reconcile(vote('P1'), saved2)
    assert.deepEqual(s3, { answer: 'P2', basis: 'P2', decided: true, sourceChanged: { from: 'P2', to: 'P1' } })
    assert.equal(batchAnswer(s3, vote('P1')), 'P2')
})

test('a prefilled suggestion he never confirmed stays a suggestion: prefilled again, never signed in batch', () => {
    // session 1: source P4 prefills the row, he quits without touching it
    const s1 = reconcile(vote('P4'), undefined)
    const saved1 = save('P4', s1, 'P4')
    assert.deepEqual(saved1, { answer: 'P4', basis: 'P4', decided: false })
    // the source is gone (a suggestion source answers only in a review): the
    // review prefills the saved suggestion, a batch run has no answer for the row
    const s2 = reconcile(undefined, saved1)
    assert.deepEqual(s2, { answer: 'P4', basis: 'P4', decided: false })
    assert.equal(batchAnswer(s2, undefined), '')
    // the source is back and moved: the new suggestion is prefilled and flagged as changed, still not his
    const s3 = reconcile(vote('P1'), saved1)
    assert.deepEqual(s3, { answer: 'P1', basis: 'P1', decided: false, suggestionChanged: { from: 'P4', to: 'P1' } })
    // a batch run signs what the sources say now for such a row, never the stale suggestion
    assert.equal(batchAnswer(s3, vote('P1')), 'P1')
    // sources disagreeing blank a suggestion row
    const d = mergeSources([{ addon: 'x', label: '', answers: [a('P1')] }, { addon: 'y', label: '', answers: [a('P2')] }]).get(voteKey(a('')))
    assert.deepEqual(reconcile(d, saved1), { answer: '', basis: 'P4', decided: false })
    // a file from before the flag existed: an answer equal to its basis was a followed suggestion
    assert.deepEqual(reconcile(undefined, { answer: 'P4', basis: 'P4' }), { answer: 'P4', basis: 'P4', decided: false })
    assert.deepEqual(reconcile(undefined, { answer: 'P4', basis: undefined }), { answer: 'P4', basis: 'P4', decided: false })
})

test('confirming makes every answered row his; quitting makes only his edits his', () => {
    const s = reconcile(vote('P4'), undefined)
    // quit: untouched stays a suggestion, an edit is his, a cleared row is his (blank)
    assert.equal(nextDecided({ answer: 'P4', prefilled: s.answer, decided: s.decided }, false), false)
    assert.equal(nextDecided({ answer: 'P1', prefilled: s.answer, decided: s.decided }, false), true)
    assert.equal(nextDecided({ answer: '', prefilled: s.answer, decided: s.decided }, false), true)
    // confirm (y on the commit modal): the untouched suggestion becomes his; a blank row is not an answer
    assert.deepEqual(save('P4', s, 'P4', true), { answer: 'P4', basis: 'P4', decided: true })
    assert.equal(nextDecided({ answer: '', prefilled: '', decided: false }, true), false)
    // once his, always his, even left untouched in a later session
    assert.equal(nextDecided({ answer: 'P4', prefilled: 'P4', decided: true }, false), true)
    // after confirming, the source moving is flagged and his answer stays
    assert.deepEqual(reconcile(vote('P1'), save('P4', s, 'P4', true)), { answer: 'P4', basis: 'P4', decided: true, sourceChanged: { from: 'P4', to: 'P1' } })
})

test('the saved review file carries the decided flag and legacy files still read', () => {
    writeSaved([
        { ancillaryData: AD, timestamp: 1, question: 'yours', answer: 'P2', source: 'P1', decided: true },
        { ancillaryData: AD2, timestamp: 2, question: 'suggested', answer: 'P4', source: 'P4', decided: false },
        { ancillaryData: '0xcc', timestamp: 3, question: 'legacy', answer: 'P3', source: 'P3' },
    ] as Array<Answer & { source?: string; decided?: boolean }>)
    try {
        const saved = loadSavedReview(ROUND)!
        assert.deepEqual(saved.get(voteKey({ ancillaryData: AD, timestamp: 1 })), { answer: 'P2', basis: 'P1', decided: true, question: 'yours' })
        assert.deepEqual(saved.get(voteKey({ ancillaryData: AD2, timestamp: 2 })), { answer: 'P4', basis: 'P4', decided: false, question: 'suggested' })
        assert.deepEqual(saved.get(voteKey({ ancillaryData: '0xcc', timestamp: 3 })), { answer: 'P3', basis: 'P3', decided: undefined, question: 'legacy' })
        // a suggestion row whose source now says the same, confirmed earlier under the old format, is his
        assert.equal(reconcile(vote('P2'), saved.get(voteKey({ ancillaryData: AD, timestamp: 1 }))).decided, true)
    } finally { dropSaved() }
})

test('ANSWERS_FILE is the only source: the saved review is not read and no addon is asked', async () => {
    const override = path.join(ROOT, 'answers', `${ROUND}.override.json`)
    writeSaved([{ ancillaryData: AD, timestamp: 1, question: 'q', answer: 'P2', source: 'P1', decided: true }] as Array<Answer & { source?: string; decided?: boolean }>)
    writeFileSync(override, JSON.stringify([a('P1')]))
    process.env.ANSWERS_FILE = override
    try {
        let asked = false
        const spy: AnswerSourcePlugin = { name: 'spy', async getAnswers() { asked = true; return { source: 's', answers: [a('P3')] } } }
        const r = await collectAnswers(ROUND, { out: quiet, addons: [spy] })
        assert.equal(asked, false)
        assert.equal(r.overrideFile, override)
        assert.equal(r.saved, undefined, 'the saved review is not laid over the file')
        assert.deepEqual(r.answers.map(x => x.answer), ['P1'])
        assert.deepEqual(reconcile(r.votes.get(voteKey(a(''))), undefined), { answer: 'P1', basis: 'P1', decided: false })
    } finally {
        delete process.env.ANSWERS_FILE
        rmSync(override)
        dropSaved()
    }
})

test('a timestamp-less source merges with a timestamped one for the same request', () => {
    const agree = mergeSources([
        { addon: 'timed', label: '', answers: [a('P1')] },
        { addon: 'untimed', label: '', answers: [a('p1', { timestamp: undefined })] },
    ])
    assert.equal(agree.size, 2, 'keyed apart until looked up per request')
    const joined = lookupVote(agree, { ancillaryData: AD, timestamp: 1n })!
    assert.equal(joined.answer, 'P1')
    assert.deepEqual(joined.suggestions.map(s => s.addon), ['timed', 'untimed'])
    const differ = mergeSources([
        { addon: 'timed', label: '', answers: [a('P1')] },
        { addon: 'untimed', label: '', answers: [a('P2', { timestamp: undefined })] },
    ])
    const v = lookupVote(differ, { ancillaryData: AD, timestamp: 1n })!
    assert.equal(v.disagree, true, 'the old lookup took the timestamped answer and dropped the other')
    assert.equal(v.answer, '')
    // only one of the two present: that one
    assert.equal(lookupVote(mergeSources([{ addon: 'untimed', label: '', answers: [a('P2', { timestamp: undefined })] }]), { ancillaryData: AD, timestamp: 1n })!.answer, 'P2')
    assert.equal(lookupVote(agree, { ancillaryData: AD2, timestamp: 1n }), undefined)
})

test('the review context reaches each addon: true only when a human will see the answers', async () => {
    const seen: Array<{ review: boolean } | undefined> = []
    const spy: AnswerSourcePlugin = { name: 'spy', async getAnswers(_round, ctx) { seen.push(ctx); return { source: 's', answers: [a('P1')] } } }
    await collectAnswers(ROUND, { out: quiet, addons: [spy] })
    await collectAnswers(ROUND, { out: quiet, addons: [spy], review: false })
    await collectAnswers(ROUND, { out: quiet, addons: [spy], review: true })
    assert.deepEqual(seen, [{ review: false }, { review: false }, { review: true }])
})

test('MULTIPLE_VALUES encodes the packed integer the dApp commits, never a 1e18-scaled number', () => {
    // round 10162, "Minnesota Lynx vs Atlanta Dream": resolved 322122547273 = [73, 75]
    assert.equal(encodePrice('322122547273', 'MULTIPLE_VALUES'), 322122547273n)
    assert.equal(encodePrice('73, 75', 'MULTIPLE_VALUES'), 322122547273n)
    assert.equal(encodePrice('[73,75]', 'MULTIPLE_VALUES'), 322122547273n)
    // without the label count every slot is shown, so a trailing zero is never hidden
    assert.deepEqual(decodeMultipleValues(322122547273n), [73, 75, 0, 0, 0, 0, 0])
    assert.equal(describePrice(322122547273n, 'MULTIPLE_VALUES'), 'slots [73, 75, 0, 0, 0, 0, 0] (label count unknown)')
    assert.deepEqual(decodeMultipleValues(322122547273n, 2), [73, 75])
    assert.equal(describePrice(322122547273n, 'MULTIPLE_VALUES', 2), 'values [73, 75]')
    // UMIP-183's own example
    assert.equal(encodePrice('0,1,2,3,4,5,6', 'MULTIPLE_VALUES'), 37662610419627592771030380598185861001628732695723288559616n)
    // the two magic prices: P4 / too early is min int256 (the dApp's "Early Request"), unresolvable is max int256
    assert.equal(encodePrice('P4', 'MULTIPLE_VALUES'), P4_VALUE)
    assert.equal(encodePrice('unresolvable', 'MULTIPLE_VALUES'), UNRESOLVABLE_VALUE)
    assert.equal(describePrice(P4_VALUE, 'MULTIPLE_VALUES'), 'too early (min int256)')
    // a raw integer is read as the packing it is: 2^32 = [0, 1]
    assert.deepEqual(decodeMultipleValues(encodePrice('4294967296', 'MULTIPLE_VALUES')!, 2), [0, 1])
    // not encodable: P1/P2, decimals, more than 7 values, a value over uint32, bits above the 7 slots
    for (const bad of ['P1', 'P2', '1.5', '0,1,2,3,4,5,6,7', '0, 4294967296', (1n << 224n).toString()]) {
        assert.equal(encodePrice(bad, 'MULTIPLE_VALUES'), undefined, bad)
    }
    // the other identifiers are unchanged: P1-P4, yes/no, and custom prices scaled by the dApp's precision
    assert.equal(encodePrice('P4', 'YES_OR_NO_QUERY'), P4_VALUE)
    assert.equal(encodePrice('P3', 'YES_OR_NO_QUERY'), 500000000000000000n)
    assert.equal(encodePrice('yes', 'ACROSS-V2'), 1_000000000000000000n)
    assert.equal(encodePrice('no', 'ASSERT_TRUTH2'), 0n)
    assert.equal(encodePrice('1.5', 'YES_OR_NO_QUERY'), 1_500000000000000000n)
    assert.equal(encodePrice('1.5', 'USDBTC'), 150000000n)
    assert.equal(describePrice(P4_VALUE, 'YES_OR_NO_QUERY'), undefined)
})

test('a refresh with every source dead keeps the saved review intact', async () => {
    writeSaved([
        { ancillaryData: AD, timestamp: 1, question: 'first', answer: 'P2', source: 'P1' },
        { ancillaryData: AD2, timestamp: 2, question: 'second', answer: 'P4', source: 'P4' },
    ])
    try {
        const dead: AnswerSourcePlugin = { name: 'dead', async getAnswers() { return undefined }, async pullAnswers() { return undefined } }
        const r = await collectAnswers(ROUND, { out: quiet, pull: true, refetch: true, addons: [dead, addon('gone', undefined)] })
        assert.equal(r.sources.length, 0)
        assert.equal(r.failures.length, 2)
        const by = Object.fromEntries(r.answers.map(x => [x.ancillaryData, x.answer]))
        assert.deepEqual(by, { [AD]: 'P2', [AD2]: 'P4' })
        assert.equal(r.answers.find(x => x.ancillaryData === AD)!.question, 'first')
        // the basis each row is judged against is untouched too
        assert.deepEqual(reconcile(r.votes.get(voteKey({ ancillaryData: AD, timestamp: 1 })), { answer: 'P2', basis: 'P1' }), { answer: 'P2', basis: 'P1', decided: true })
    } finally { dropSaved() }
})

test('a refresh asks pulling addons to pull first and falls back to their cache', async () => {
    const calls: string[] = []
    const puller: AnswerSourcePlugin = {
        name: 'puller',
        async getAnswers() { calls.push('get'); return { source: 'cache', answers: [a('P1')] } },
        async pullAnswers() { calls.push('pull'); return undefined },
    }
    const r = await collectAnswers(ROUND, { out: quiet, pull: true, refetch: true, addons: [puller] })
    assert.deepEqual(calls, ['pull', 'get'])
    assert.equal(r.answers[0].answer, 'P1')
    assert.deepEqual(r.failures, [])
    // without refetch the cache is served and nothing is pulled
    calls.length = 0
    await collectAnswers(ROUND, { out: quiet, pull: true, addons: [puller] })
    assert.deepEqual(calls, ['get'])
})

test('each verify gate sees only the answers its own addon supplied', async () => {
    const mine = [a('P1', { confidence: 'c' })], theirs = [a('P2')]
    const r = await collectAnswers(ROUND, { out: quiet, addons: [addon('x', mine), addon('y', theirs), addon('z', undefined)] })
    assert.equal(answersForGate(r, 'x'), mine)      // the very array it delivered, so its hash check holds
    assert.equal(answersForGate(r, 'y'), theirs)
    assert.equal(answersForGate(r, 'z'), undefined)  // supplied nothing: no gate, no report
    assert.equal(answersForGate(r, 'ANSWERS_FILE'), undefined)
})

test('an addon written against the original interface still works', async () => {
    const old = { name: 'old', async getAnswers(roundId: number) { return { source: `old ${roundId}`, answers: [{ ancillaryData: AD, timestamp: 1, question: 'q', answer: 'P3' }] } } }
    const r = await collectAnswers(ROUND, { out: quiet, pull: true, addons: [old as AnswerSourcePlugin] })
    assert.deepEqual(r.failures, [])
    assert.deepEqual(r.answers, [{ ancillaryData: AD, timestamp: 1, question: 'q', answer: 'P3' }])
    assert.deepEqual(r.votes.get(voteKey(a('')))!.suggestions, [{ addon: 'old', answer: 'P3', confidence: NOT_RATED }])
    assert.equal(r.source, 'old (1 of 1)')
})

test('a batch run is blocked by an undecided disagreement and not by a decided one', () => {
    const rows = [
        { question: 'undecided', disagree: true, answer: '' },
        { question: 'decided', disagree: true, answer: 'P2' },
        { question: 'agreed', disagree: false, answer: 'P1' },
        { question: 'nothing', disagree: false, answer: '' },
    ]
    assert.deepEqual(blockedInBatch(rows).map(r => r.question), ['undecided'])
    assert.deepEqual(committedContested(rows), [])
})

test('an undecided disagreement on a vote already committed on chain is left as committed, not a block; unknown diff still blocks', () => {
    const rows = [
        { question: 'committed', disagree: true, answer: '', onchainPrice: P2_VALUE },
        { question: 'uncommitted', disagree: true, answer: '', onchainPrice: undefined },
        { question: 'cleared', disagree: true, answer: '', decided: true, onchainPrice: P2_VALUE },
        { question: 'agreed', disagree: false, answer: 'P1', onchainPrice: P1_VALUE },
    ]
    // nothing would be sent for the committed one anyway (keepsCommitment), so
    // it does not abort the run; the uncommitted one still does
    assert.deepEqual(blockedInBatch(rows).map(r => r.question), ['uncommitted'])
    assert.deepEqual(committedContested(rows).map(r => r.question), ['committed'])
    // the on-chain fetch failed: no row has onchainPrice, every undecided disagreement blocks
    const noDiff = rows.map(({ onchainPrice, ...r }) => r)
    assert.deepEqual(blockedInBatch(noDiff).map(r => r.question), ['committed', 'uncommitted'])
    assert.deepEqual(committedContested(noDiff), [])
})

test('an on-chain price is labelled by its identifier: a MULTIPLE_VALUES packing is not "P4" and its zero is not "P1"', () => {
    // the old label called every price that was not P1/P2/P3 "P4"
    assert.equal(priceLabel(322122547273n, 'MULTIPLE_VALUES', 2), 'values [73, 75]')
    assert.equal(priceLabel(322122547273n, 'MULTIPLE_VALUES'), 'slots [73, 75, 0, 0, 0, 0, 0] (label count unknown)')
    assert.equal(priceLabel(0n, 'MULTIPLE_VALUES', 2), 'values [0, 0]')
    assert.equal(priceLabel(P4_VALUE, 'MULTIPLE_VALUES'), 'P4')
    assert.equal(priceLabel(UNRESOLVABLE_VALUE, 'MULTIPLE_VALUES'), 'unresolvable')
    // a custom price shows its value in the identifier's units
    assert.equal(priceLabel(1_500000000000000000n, 'YES_OR_NO_QUERY'), '1.5')
    assert.equal(priceLabel(150000000n, 'USDBTC'), '1.5')
    // without an identifier the raw integer, never a guessed P4
    assert.equal(priceLabel(322122547273n), '322122547273')
    assert.equal(priceLabel(P1_VALUE), 'P1/no'); assert.equal(priceLabel(P2_VALUE, 'YES_OR_NO_QUERY'), 'P2/yes'); assert.equal(priceLabel(P4_VALUE), 'P4')
})

test('the shown status follows an edit at once: typed over, a suggestion is yours and a flagged move is gone', () => {
    const suggested = { answer: 'P1', decided: false, suggestionChanged: { from: 'P4', to: 'P1' } }
    assert.deepEqual(reviewStatus(suggested, 'P1'), { decided: false, suggestionChanged: { from: 'P4', to: 'P1' }, sourceChanged: undefined })
    assert.deepEqual(reviewStatus({ ...suggested, answer: 'P2' }, 'P1'), { decided: true, suggestionChanged: undefined, sourceChanged: undefined })
    // typing the prefilled value back restores the prefilled state
    assert.equal(reviewStatus({ ...suggested, answer: 'P1' }, 'P1').decided, false)
    const his = { answer: 'P2', decided: true, sourceChanged: { from: 'P1', to: 'P3' } }
    assert.deepEqual(reviewStatus(his, 'P2'), { decided: true, sourceChanged: { from: 'P1', to: 'P3' }, suggestionChanged: undefined })
    assert.deepEqual(reviewStatus({ ...his, answer: 'P4' }, 'P2'), { decided: true, sourceChanged: undefined, suggestionChanged: undefined })
    // these are the save's own rules
    assert.equal(reviewStatus({ ...suggested, answer: 'P2' }, 'P1').decided, nextDecided({ answer: 'P2', prefilled: 'P1', decided: false }, false))
})

test('a source that reports a conflict leaves the vote for the owner, whatever another source says', () => {
    const v = mergeSources([
        { addon: 'x', label: '', answers: [a('P2')] },
        { addon: 'y', label: '', answers: [a('', { conflict: 'clarification says P1, trusted account says P2' })] },
    ]).get(voteKey(a('')))!
    assert.equal(v.answer, '', 'not filled from x alone')
    assert.equal(v.disagree, true)
    assert.deepEqual(v.conflicts, [{ addon: 'y', reason: 'clarification says P1, trusted account says P2' }])
    assert.deepEqual(v.suggestions.map(s => s.addon), ['x'])
    // the review opens blank, a batch run is blocked
    const open = reconcile(v, undefined)
    assert.deepEqual(open, { answer: '', basis: '', decided: false })
    assert.equal(blockedInBatch([{ disagree: v.disagree, answer: batchAnswer(open, v), decided: open.decided }]).length, 1)
    // a decided owner answer stands and is not blocked
    const his = reconcile(v, { answer: 'P1', basis: 'P2', decided: true })
    assert.equal(his.answer, 'P1')
    assert.equal(blockedInBatch([{ disagree: v.disagree, answer: batchAnswer(his, v), decided: his.decided }]).length, 0)
    // a blank conflict is no conflict; a conflict alone, with no answer anywhere, still flags the vote
    assert.equal(mergeSources([{ addon: 'y', label: '', answers: [a('', { conflict: '  ' })] }]).get(voteKey(a('')))!.disagree, false)
    assert.equal(mergeSources([{ addon: 'y', label: '', answers: [a('', { conflict: 'contested' })] }]).get(voteKey(a('')))!.disagree, true)
    // joined across a timestamped and a timestamp-less source too
    const joined = lookupVote(mergeSources([
        { addon: 'x', label: '', answers: [a('P2')] },
        { addon: 'y', label: '', answers: [a('', { timestamp: undefined, conflict: 'contested' })] },
    ]), { ancillaryData: AD, timestamp: 1n })!
    assert.equal(joined.disagree, true); assert.equal(joined.answer, '')
})

test('MULTIPLE_VALUES takes exactly one value per label, and the labels come from the request text as the dApp reads them', () => {
    // the dApp parses the text up to its last "}" as {title, description, labels}
    const text = '{"title":"Minnesota Lynx vs Atlanta Dream","description":"Final score","labels":["Lynx","Dream"]},initializer:abcd'
    assert.deepEqual(multipleValuesLabels(text), ['Lynx', 'Dream'])
    assert.equal(multipleValuesLabels('q: title: not json'), undefined)
    assert.equal(multipleValuesLabels('{"labels":[]}'), undefined)
    assert.equal(multipleValuesLabels(`{"labels":${JSON.stringify(Array(8).fill('x'))}}`), undefined)
    // round 10162: 322122547273 = [73, 75] on a two-label request
    assert.equal(encodePrice('73, 75', 'MULTIPLE_VALUES', 2), 322122547273n)
    assert.equal(encodePrice('322122547273', 'MULTIPLE_VALUES', 2), 322122547273n)
    assert.equal(describePrice(322122547273n, 'MULTIPLE_VALUES', 2), 'values [73, 75]')
    // Typed under v, one value for two labels is refused, not padded with a
    // zero: the old input let "73" through as the packed price [73, 0]
    const two = ['Lynx', 'Dream']
    assert.match(typedPriceProblem('73', 'MULTIPLE_VALUES', two)!, /2 label\(s\).*2 value\(s\).*1 given/)
    assert.match(typedPriceProblem('[73]', 'MULTIPLE_VALUES', two)!, /1 given/)
    assert.equal(typedPriceProblem('73, 75', 'MULTIPLE_VALUES', two), undefined)
    assert.equal(typedPriceProblem('73', 'MULTIPLE_VALUES', ['Lynx']), undefined, 'one label: one value is the list form')
    assert.equal(typedPriceProblem('73', 'MULTIPLE_VALUES', undefined)!.startsWith('label count unknown'), true)
    assert.equal(typedPriceProblem('x', 'YES_OR_NO_QUERY', undefined), 'a number, like 1.5')
    // From a source file a bare integer stays the packed price it is, and its empty slot is shown
    assert.equal(encodePrice('73', 'MULTIPLE_VALUES', 2), 73n)
    assert.equal(describePrice(73n, 'MULTIPLE_VALUES', 2), 'values [73, 0]')
    assert.equal(encodePrice('[73]', 'MULTIPLE_VALUES', 2), undefined)
    assert.equal(encodePrice('73, 75, 1', 'MULTIPLE_VALUES', 2), undefined)
    assert.match(priceProblem('73, 75, 1', 'MULTIPLE_VALUES', 2)!, /2 label\(s\).*3 given/)
    // a packing that uses slots beyond the labels is refused
    assert.equal(encodePrice((1n << 64n).toString(), 'MULTIPLE_VALUES', 2), undefined)
    assert.equal(describePrice(1n << 64n, 'MULTIPLE_VALUES', 2), 'slots [0, 0, 1, 0, 0, 0, 0] (beyond the 2 label(s))')
    // label count unknown: a list from a source packs as given (nothing to check it against), a packed integer reads as is
    assert.equal(encodePrice('73, 75', 'MULTIPLE_VALUES'), 322122547273n)
    assert.equal(priceProblem('73, 75, 1', 'MULTIPLE_VALUES'), undefined)
})

test('a typed price with more decimals than the identifier takes is refused, not rounded', () => {
    // the dApp's parseFixed throws on these; viem's parseUnits rounded them to 1000000000000000001 and 112345679
    assert.equal(encodePrice('1.0000000000000000005', 'YES_OR_NO_QUERY'), undefined)
    assert.equal(encodePrice('1.123456789', 'USDBTC'), undefined)
    assert.equal(priceProblem('1.123456789', 'USDBTC'), '9 decimals; USDBTC takes at most 8')
    assert.equal(priceProblem('1.0000000000000000005', 'YES_OR_NO_QUERY'), '19 decimals; YES_OR_NO_QUERY takes at most 18')
    // within the precision nothing changes
    assert.equal(encodePrice('1.12345678', 'USDBTC'), 112345678n)
    assert.equal(encodePrice('1.000000000000000001', 'YES_OR_NO_QUERY'), 1_000000000000000001n)
    assert.equal(encodePrice('-2', 'YES_OR_NO_QUERY'), -2_000000000000000000n)
    assert.equal(priceProblem('1.5', 'YES_OR_NO_QUERY'), undefined)
})

test('a row the owner cleared says so, and does not block a batch run', () => {
    const base = { question: 'q', identifierDecoded: 'YES_OR_NO_QUERY', time: 1n, ancillaryData: AD, answer: '', mergedAnswer: '', decided: false, sourceAnswer: '', suggestions: [] as Array<{ addon: string; answer: string; confidence: string }>, conflicts: [] as Array<{ addon: string; reason: string }>, disagree: false, known: true }
    const sugg = [{ addon: 'x', answer: 'P2', confidence: NOT_RATED }]
    // cleared while a source answers: the old text said "no source answered this one"
    assert.equal(rowProblem({ ...base, decided: true, sourceAnswer: 'P2', suggestions: sugg }), 'CLEARED    "q" — you cleared this one; the sources say P2; nothing is signed for it')
    assert.equal(rowProblem({ ...base, decided: true }), 'CLEARED    "q" — you cleared this one and no source answers it; nothing is signed for it')
    assert.equal(rowProblem({ ...base, decided: true, disagree: true, suggestions: sugg, conflicts: [{ addon: 'y', reason: 'contested' }] }), 'CLEARED    "q" — you cleared this one; x P2 vs y sees a conflict (contested); nothing is signed for it')
    // the undecided cases keep their words
    assert.equal(rowProblem({ ...base, disagree: true, suggestions: [...sugg, { addon: 'y', answer: 'P1', confidence: NOT_RATED }] }), 'DISAGREE   "q" — x P2 vs y P1; decide it yourself')
    assert.equal(rowProblem({ ...base, disagree: true, conflicts: [{ addon: 'y', reason: 'contested' }] }), 'DISAGREE   "q" — y sees a conflict (contested); decide it yourself')
    assert.equal(rowProblem({ ...base, mergedAnswer: 'P4' }), 'UNCONFIRMED "q" — the saved review holds the suggestion P4 you never confirmed, and no source answers now')
    assert.equal(rowProblem({ ...base }), 'NO ANSWER  "q" — no source answered this one')
    assert.match(rowProblem({ ...base, known: false })!, /^UNMATCHED  YES_OR_NO_QUERY @ 1 — no source knows ancillaryData/)
    assert.equal(rowProblem({ ...base, answer: 'P2' }), undefined)
    // a decided clear on a contested vote is a decision, not "you have not decided"
    assert.deepEqual(blockedInBatch([{ disagree: true, answer: '', decided: true }, { disagree: true, answer: '', decided: false }]).map(r => r.decided), [false])
})

test('a batch run never replaces a commitment already on chain, with a suggestion or with a decided answer', () => {
    // committed P2 (dApp, or an earlier build whose file reads as a suggestion); the sources now say P1
    assert.equal(keepsCommitment({ decided: false, price: P1_VALUE, onchainPrice: P2_VALUE }), true)
    // he confirmed P1 here, then recommitted P2 in the dApp: both are his, a
    // batch run cannot tell which he meant and leaves P2. The old rule let
    // the decided P1 through and replaced the later commitment.
    assert.equal(keepsCommitment({ decided: true, price: P1_VALUE, onchainPrice: P2_VALUE }), true)
    // an unchanged or uncommitted row is sent as usual
    assert.equal(keepsCommitment({ decided: false, price: P2_VALUE, onchainPrice: P2_VALUE }), false)
    assert.equal(keepsCommitment({ decided: true, price: P1_VALUE, onchainPrice: undefined }), false)
    assert.equal(keepsCommitment({ decided: false, price: undefined, onchainPrice: P2_VALUE }), false)
    // the saved file of the previous build: answer equal to its basis reads as a suggestion
    assert.equal(reconcile(vote('P1'), { answer: 'P2', basis: 'P2' }).decided, false)
})

test('a malformed addon answer costs one line, not the run', async () => {
    const bad = [
        { ancillaryData: AD, timestamp: 1, question: { title: 'object' }, answer: 'P1', confidence: 97 },
        { ancillaryData: AD2, timestamp: 2, question: 'fine', answer: 'P2' },
        'not an object',
        { ancillaryData: AD2, timestamp: 3, question: 'q', answer: 'P3', conflict: 12 },
    ] as unknown as Answer[]
    const good = [a('P1')]
    const r = await collectAnswers(ROUND, { out: quiet, addons: [addon('sloppy', bad), addon('tidy', good)] })
    assert.deepEqual(r.failures, ['⚠ sloppy: 4 malformed answer field(s) (non-string values) dropped, a malformed conflict kept as a conflict; the rest is used'])
    const v = r.votes.get(voteKey(a('')))!
    assert.equal(v.answer, 'P1'); assert.equal(v.question, 'q')
    assert.deepEqual(v.suggestions, [{ addon: 'sloppy', answer: 'P1', confidence: NOT_RATED }, { addon: 'tidy', answer: 'P1', confidence: NOT_RATED }])
    assert.equal(r.votes.get(voteKey({ ancillaryData: AD2, timestamp: 2 }))!.answer, 'P2')
    // A non-string conflict fails closed: the field is there to hold the vote
    // back, so the vote stays blank with the reason shown. The old code
    // dropped it and the vote read as "no opinion".
    const malformed = r.votes.get(voteKey({ ancillaryData: AD2, timestamp: 3 }))!
    assert.equal(malformed.disagree, true)
    assert.equal(malformed.answer, '')
    assert.deepEqual(malformed.conflicts, [{ addon: 'sloppy', reason: MALFORMED_CONFLICT }])
    // another source cannot fill it either
    const filled = mergeSources([
        { addon: 'x', label: '', answers: [a('P2')] },
        { addon: 'y', label: '', answers: sanitizeAnswers([{ ...a(''), conflict: true } as unknown as Answer]).answers },
    ]).get(voteKey(a('')))!
    assert.equal(filled.disagree, true); assert.equal(filled.answer, '')
    // an empty non-string conflict (null, false, 0) is no conflict, dropped like any other bad field
    for (const empty of [null, false, 0]) {
        const s = sanitizeAnswers([{ ...a('P1'), conflict: empty } as unknown as Answer])
        assert.equal(s.problems, 1); assert.equal(s.answers[0].conflict, undefined)
    }
    // the display copies never throw on what is left
    for (const x of r.answers) assert.equal(typeof x.question, 'string')
    // a clean array is handed to its gate untouched
    assert.equal(answersForGate(r, 'tidy'), good)
    assert.equal(sanitizeAnswers(good).answers, good)
})

test('the disagreement banner counts per request with the timed/untimed join the rows use', () => {
    // a timed P1 and an untimed P2 for one request: the row shows ⚠, and the
    // banner must say 1, where counting the raw map (keyed apart) said 0
    const votes = mergeSources([
        { addon: 'timed', label: '', answers: [a('P1')] },
        { addon: 'untimed', label: '', answers: [a('P2', { timestamp: undefined })] },
    ])
    assert.equal([...votes.values()].filter(v => v.disagree).length, 0, 'the old count')
    const req = { ancillaryData: AD, timestamp: 1n }
    const o = roundOverview(votes, [req], undefined)
    assert.equal(o.disagreements.length, 1)
    assert.equal(o.anyAnswer, true, 'the sources answered, they disagree; not "no source answered"')
    // a plain agreement and a vote nobody knows
    const agreed = roundOverview(mergeSources([{ addon: 'x', label: '', answers: [a('P1')] }]), [req, { ancillaryData: AD2, timestamp: 2n }], undefined)
    assert.deepEqual(agreed, { disagreements: [], anyAnswer: true })
    // nothing from any source: the saved review alone decides whether there is anything to work with
    assert.equal(roundOverview(new Map(), [req], undefined).anyAnswer, false)
    assert.equal(roundOverview(new Map(), [req], new Map([[voteKey(req), { answer: '', basis: '' }]])).anyAnswer, false)
    assert.equal(roundOverview(new Map(), [req], new Map([[voteKey(req), { answer: 'P3', basis: '' }]])).anyAnswer, true)
    // a request outside this round's set does not count
    assert.equal(roundOverview(votes, [{ ancillaryData: AD2, timestamp: 2n }], undefined).disagreements.length, 0)
})

test('a row with every source gone shows the title the saved review kept', () => {
    writeSaved([{ ancillaryData: AD, timestamp: 1, question: 'Will it rain?', answer: 'P2', source: 'P1', decided: true }] as Array<Answer & { source?: string; decided?: boolean }>)
    try {
        const s = loadSavedReview(ROUND)!.get(voteKey({ ancillaryData: AD, timestamp: 1 }))!
        assert.equal(s.question, 'Will it rain?')
        // no source, no title in the ancillary bytes: the saved title, where the row used to read "YES_OR_NO_QUERY @ 1"
        assert.equal(rowTitle(undefined, s, AD), 'Will it rain?')
        // a source's question wins, then the title the ancillary data itself carries
        assert.equal(rowTitle({ question: 'From a source' }, s, AD), 'From a source')
        const withTitle = `0x${Buffer.from('q: title: In the bytes, description: d').toString('hex')}` as const
        assert.equal(rowTitle(undefined, s, withTitle), 'In the bytes')
        assert.equal(rowTitle(undefined, undefined, AD), undefined)
        assert.equal(rowTitle(undefined, { answer: 'P1', basis: 'P1' }, AD), undefined)
    } finally { dropSaved() }
})

test('pinned warnings are capped, the rest counted for p', () => {
    const lines = ['⚠ a', '⚠ b', '⚠ c', '⚠ d', '⚠ e', '⚠ f']
    assert.deepEqual(pinnedWarnings(lines, 4), { shown: ['⚠ a', '⚠ b', '⚠ c', '⚠ d'], more: 2 })
    assert.deepEqual(pinnedWarnings(lines.slice(0, 4), 4), { shown: lines.slice(0, 4), more: 0 })
    assert.deepEqual(pinnedWarnings([], 4), { shown: [], more: 0 })
    // the default cap is small enough to fit under the list
    assert.ok(pinnedWarnings(Array(40).fill('⚠')).shown.length <= 6)
})

test('the legacy decided inference compares answers like every other comparison: case-insensitively', () => {
    // 'p1' saved against basis 'P1' is a followed suggestion, not his
    assert.equal(reconcile(vote('P1'), { answer: 'p1', basis: 'P1' }).decided, false)
    assert.equal(reconcile(vote('P1'), { answer: 'P2', basis: 'P1' }).decided, true)
})
