// Per-vote Discord discussion (#evidence-rationale) via the voter dApp's thread
// cache. Threads are bound to votes by the dApp's thread-name convention; the
// cache is ≤10 min stale and entries expire ~1h after the round ends, so this
// only works for the current round. Shared by the comments command and the
// interactive commit UI.
import { DAPP_URL } from './config'
import { sanitizeText } from './common'

export type ThreadMessage = { message: string; sender: string; time: number; id: string; replies?: ThreadMessage[] }

// Discord content is attacker-controlled — strip control chars before it can
// reach an Ink frame (nested replies included)
const sanitizeThread = (ms: ThreadMessage[]): ThreadMessage[] =>
    ms.map(m => ({ ...m, message: sanitizeText(m.message), sender: sanitizeText(m.sender), replies: m.replies && sanitizeThread(m.replies) }))

// Clarifications outrank chat: messages the bot posts as
// **Polymarket Clarification** amend the question's resolution rules, so they
// sort before everything else (each group chronologically — the API returns
// newest-first, which also puts "continued from previous message" parts
// before their beginning). Applied per nesting level.
const isClarification = (m: ThreadMessage): boolean => /\*\*\s*Polymarket Clarification/i.test(m.message)
const sortThread = (ms: ThreadMessage[]): ThreadMessage[] =>
    [...ms]
        .sort((a, b) => (isClarification(b) ? 1 : 0) - (isClarification(a) ? 1 : 0) || a.time - b.time)
        .map(m => ({ ...m, replies: m.replies && sortThread(m.replies) }))

// Mirror the dApp's title normalization: >90 chars → first 87 + "..."
export const dappTitle = (title: string) => title.length > 90 ? `${title.slice(0, 87)}...` : title

// UMA's public Discord: the guild and its #evidence-rationale channel, as the
// voter dApp has them (constant/voting/discord.ts). The dApp links a vote's
// Comments button straight to its thread when its thread map matched one
// without ambiguity, else to the channel (voter-dapp-v2 PR #489).
export const UMA_DISCORD_GUILD_ID = '718590743446290492'
export const EVIDENCE_RATIONALE_CHANNEL_ID = '964000735073284127'
export const discussionLink = (threadId?: string): string =>
    `https://discord.com/channels/${UMA_DISCORD_GUILD_ID}/${threadId && /^\d{17,20}$/.test(threadId) ? threadId : EVIDENCE_RATIONALE_CHANNEL_ID}`

// A vote's discussion as the dApp's cache serves it. Since Discord began
// withholding message content from the server (2026-10), the endpoint can
// answer with a threadId and an empty thread: the thread exists, its text is
// not available here. That differs from a failed request, where nothing is
// known; `ok` tells the two apart. `link` is where to read it on Discord.
export type Discussion = {
    thread: ThreadMessage[]
    threadId?: string       // the vote's thread, when the dApp matched one; absent = unknown or ambiguous
    ok: boolean             // the request succeeded (thread and threadId are what the dApp knows); false = failed, nothing known
    link: string            // the thread when known, else the discussion channel
}

export async function fetchDiscussion(time: number | string, identifierDecoded: string, title: string): Promise<Discussion> {
    const params = new URLSearchParams({ time: String(time), identifier: identifierDecoded, title: dappTitle(title) })
    try {
        const res = await fetch(`${DAPP_URL}/api/discord-thread?${params}`, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) return { thread: [], ok: false, link: discussionLink() }
        const body = (await res.json()) as { thread?: ThreadMessage[]; threadId?: unknown }
        const threadId = typeof body.threadId === 'string' && /^\d{17,20}$/.test(body.threadId) ? body.threadId : undefined
        return { thread: sortThread(sanitizeThread(body.thread ?? [])), threadId, ok: true, link: discussionLink(threadId) }
    } catch { return { thread: [], ok: false, link: discussionLink() } }
}

// What to say when a discussion has no messages to show, with its link:
// the thread exists but Discord gave no text, no thread is known, or the
// request itself failed. undefined when there are messages.
export function discussionNote(d: Discussion): string | undefined {
    if (d.thread.length > 0) return undefined
    if (!d.ok) return `Couldn't fetch the discussion (request failed); the discussion channel on Discord: ${d.link}`
    if (d.threadId) return `Discord returned no message text for this vote's thread; read it on Discord: ${d.link}`
    return `No thread is known for this vote (not cached, or the title matched several); the discussion channel on Discord: ${d.link}`
}

// Empty array on any failure — a cache hiccup reads as "no comments". Kept
// for callers that only want the messages; fetchDiscussion tells more.
export async function fetchDiscordThread(time: number | string, identifierDecoded: string, title: string): Promise<ThreadMessage[]> {
    return (await fetchDiscussion(time, identifierDecoded, title)).thread
}

// Depth-first flatten with reply nesting level, for one-comment-at-a-time
// UIs. Ordering (clarifications first, then chronological) comes from
// fetchDiscordThread — shared with the questions command and its --json.
export function flattenThread(thread: ThreadMessage[]): Array<ThreadMessage & { depth: number }> {
    const out: Array<ThreadMessage & { depth: number }> = []
    const walk = (ms: ThreadMessage[], depth: number) => {
        for (const m of ms) { out.push({ ...m, depth }); walk(m.replies ?? [], depth + 1) }
    }
    walk(thread, 0)
    return out
}
