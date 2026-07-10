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

// Mirror the dApp's title normalization: >90 chars → first 87 + "..."
export const dappTitle = (title: string) => title.length > 90 ? `${title.slice(0, 87)}...` : title

// Empty array on any failure — a cache hiccup reads as "no comments".
export async function fetchDiscordThread(time: number | string, identifierDecoded: string, title: string): Promise<ThreadMessage[]> {
    const params = new URLSearchParams({ time: String(time), identifier: identifierDecoded, title: dappTitle(title) })
    try {
        const res = await fetch(`${DAPP_URL}/api/discord-thread?${params}`)
        if (!res.ok) return []
        return sanitizeThread(((await res.json()) as { thread?: ThreadMessage[] }).thread ?? [])
    } catch { return [] }
}

// Depth-first flatten with reply nesting level, for one-comment-at-a-time UIs.
// Each level is sorted chronologically — the API returns newest-first, which
// puts "continued from previous message" parts BEFORE their beginning.
export function flattenThread(thread: ThreadMessage[]): Array<ThreadMessage & { depth: number }> {
    const out: Array<ThreadMessage & { depth: number }> = []
    const walk = (ms: ThreadMessage[], depth: number) => {
        for (const m of [...ms].sort((a, b) => a.time - b.time)) { out.push({ ...m, depth }); walk(m.replies ?? [], depth + 1) }
    }
    walk(thread, 0)
    return out
}
