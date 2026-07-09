// Browse per-vote Discord discussion (#evidence-rationale) from the CLI, via
// the voter dApp's thread cache (thread-name convention binds threads to votes;
// cache is ≤10 min stale and entries expire ~1h after the round ends → current
// round only).
//
// Usage: nub run comments [--q <title substring>] [--round N]
import { getCurrentRoundId, getPendingRequests, getAnswers, decodeIdentifier, argValue, type Answer } from './common'
import { fetchDiscordThread, type ThreadMessage } from './discord'
import { DIM, GREEN, RESET } from './compare'

const roundId = argValue('round') ? Number(argValue('round')) : await getCurrentRoundId()
const filter = argValue('q')?.toLowerCase()

// Titles + timestamps from the answers file; identifiers from pending requests
const answers = (await getAnswers(roundId).catch(() => undefined))?.answers ?? []
if (answers.length === 0) {
    console.error(`No answers available for round ${roundId} — provide them first (addon / ANSWERS_FILE / answers/${roundId}.json); titles are needed to locate threads.`)
    process.exit(1)
}
const pending = await getPendingRequests().catch(() => [])
const identifierFor = (a: Answer): string => {
    const req = pending.find(r =>
        r.ancillaryData.toLowerCase() === a.ancillaryData.toLowerCase() &&
        (a.timestamp === undefined || r.time === BigInt(a.timestamp)))
    if (req) return decodeIdentifier(req.identifier)
    return (a.question ?? '').toLowerCase().includes('across') ? 'ACROSS-V2' : 'YES_OR_NO_QUERY'
}

const selected = answers.filter(a => !filter || (a.question ?? '').toLowerCase().includes(filter))
if (selected.length === 0) {
    console.error(`No questions match "${filter}".`)
    process.exit(1)
}
console.log(`Round ${roundId} — fetching Discord threads for ${selected.length} vote(s)${filter ? ` matching "${filter}"` : ''}...\n`)

const fmtTime = (unix: number) => new Date(unix * 1000).toISOString().slice(5, 16).replace('T', ' ')
const printMessage = (m: ThreadMessage, indent: string) => {
    console.log(`${indent}${GREEN}${m.sender}${RESET} ${DIM}${fmtTime(m.time)}${RESET}`)
    for (const line of (m.message ?? '').split('\n')) console.log(`${indent}  ${line}`)
    for (const r of m.replies ?? []) printMessage(r, indent + '    ')
}

let withComments = 0
for (const a of selected) {
    const title = a.question ?? 'N/A'
    const thread = await fetchDiscordThread(a.timestamp ?? '', identifierFor(a), title)

    if (thread.length === 0) {
        if (filter) console.log(`${DIM}— ${title} @ ${a.timestamp}: no comments (or thread not cached)${RESET}`)
        continue
    }
    withComments++
    console.log(`━━━ ${title} ${DIM}@ ${a.timestamp} · ${thread.length} comment(s)${RESET}`)
    for (const m of thread) printMessage(m, '  ')
    console.log('')
}
if (!filter) console.log(`${withComments}/${selected.length} vote(s) have comments. Filter with --q <substring>.`)
