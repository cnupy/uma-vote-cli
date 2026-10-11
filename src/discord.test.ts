// Tests for the Discord discussion link and the three states a vote's
// discussion can be in, run offline against a stubbed fetch:
//
//   nub src/discord.test.ts   (part of nub run test)
//
// What they pin down: the link is built as the voter dApp builds it (the
// thread when one is known, else the #evidence-rationale channel); a thread
// whose text Discord withheld is told apart from no thread and from a failed
// request; and fetchDiscordThread keeps returning just the messages, [] on
// failure, for the callers that only want those.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discussionLink, discussionNote, fetchDiscussion, fetchDiscordThread, UMA_DISCORD_GUILD_ID, EVIDENCE_RATIONALE_CHANNEL_ID } from './discord'

const THREAD = '1557535829981790232'
const message = (id: string, text: string, time: number) => ({ id, message: text, sender: 'someone', time })

// Serve one response for every fetch during `run`, then restore fetch
const withFetch = async (reply: () => Promise<Response>, run: () => Promise<void>) => {
    const real = globalThis.fetch
    globalThis.fetch = (() => reply()) as typeof fetch
    try { await run() } finally { globalThis.fetch = real }
}
const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

test('the discussion link is the dApp\'s: the thread when known, the channel otherwise', () => {
    assert.equal(discussionLink(THREAD), `https://discord.com/channels/${UMA_DISCORD_GUILD_ID}/${THREAD}`)
    assert.equal(discussionLink(), `https://discord.com/channels/${UMA_DISCORD_GUILD_ID}/${EVIDENCE_RATIONALE_CHANNEL_ID}`)
    // ids the dApp would not accept as a thread fall back to the channel
    assert.equal(discussionLink('invalid'), discussionLink())
    assert.equal(UMA_DISCORD_GUILD_ID, '718590743446290492')
    assert.equal(EVIDENCE_RATIONALE_CHANNEL_ID, '964000735073284127')
})

test('a thread with messages: the messages, sorted, and the thread link', async () => {
    await withFetch(json({ thread: [message('2', 'later', 20), message('1', 'first', 10)], threadId: THREAD }), async () => {
        const d = await fetchDiscussion(1, 'YES_OR_NO_QUERY', 'q')
        assert.equal(d.ok, true)
        assert.equal(d.threadId, THREAD)
        assert.equal(d.link, discussionLink(THREAD))
        assert.deepEqual(d.thread.map(m => m.message), ['first', 'later'])
        assert.equal(discussionNote(d), undefined)
        assert.deepEqual((await fetchDiscordThread(1, 'YES_OR_NO_QUERY', 'q')).map(m => m.message), ['first', 'later'])
    })
})

test('a thread whose text Discord withheld is said plainly, with the thread link', async () => {
    // what the dApp answers for every vote of round 10368: HTTP 200, threadId set, thread []
    await withFetch(json({ identifier: 'YES_OR_NO_QUERY', time: 1, thread: [], threadId: THREAD }), async () => {
        const d = await fetchDiscussion(1, 'YES_OR_NO_QUERY', 'q')
        assert.deepEqual(d, { thread: [], threadId: THREAD, ok: true, link: discussionLink(THREAD) })
        assert.equal(discussionNote(d), `Discord returned no message text for this vote's thread; read it on Discord: ${discussionLink(THREAD)}`)
        // the old callers still get an empty list
        assert.deepEqual(await fetchDiscordThread(1, 'YES_OR_NO_QUERY', 'q'), [])
    })
})

test('no thread known: the channel link; a failed request is told apart from both', async () => {
    await withFetch(json({ thread: [] }), async () => {
        const d = await fetchDiscussion(1, 'YES_OR_NO_QUERY', 'q')
        assert.deepEqual(d, { thread: [], threadId: undefined, ok: true, link: discussionLink() })
        assert.match(discussionNote(d)!, /^No thread is known for this vote/)
    })
    // an id the dApp would not link is not a thread here either
    await withFetch(json({ thread: [], threadId: 'N/A' }), async () => {
        assert.equal((await fetchDiscussion(1, 'YES_OR_NO_QUERY', 'q')).threadId, undefined)
    })
    await withFetch(async () => new Response('nope', { status: 500 }), async () => {
        const d = await fetchDiscussion(1, 'YES_OR_NO_QUERY', 'q')
        assert.deepEqual(d, { thread: [], ok: false, link: discussionLink() })
        assert.match(discussionNote(d)!, /^Couldn't fetch the discussion/)
        assert.deepEqual(await fetchDiscordThread(1, 'YES_OR_NO_QUERY', 'q'), [])
    })
    await withFetch(async () => { throw new Error('offline') }, async () => {
        assert.equal((await fetchDiscussion(1, 'YES_OR_NO_QUERY', 'q')).ok, false)
        assert.deepEqual(await fetchDiscordThread(1, 'YES_OR_NO_QUERY', 'q'), [])
    })
})
