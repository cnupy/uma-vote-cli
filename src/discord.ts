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

// Empty array on any failure — a cache hiccup reads as "no comments".
export async function fetchDiscordThread(time: number | string, identifierDecoded: string, title: string): Promise<ThreadMessage[]> {
    const params = new URLSearchParams({ time: String(time), identifier: identifierDecoded, title: dappTitle(title) })
    try {
        const res = await fetch(`${DAPP_URL}/api/discord-thread?${params}`)
        if (!res.ok) return []
        return sortThread(sanitizeThread(((await res.json()) as { thread?: ThreadMessage[] }).thread ?? []))
    } catch { return [] }
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
