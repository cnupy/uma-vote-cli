// Addon host. Drop an addon into the gitignored addons/ directory
// (addons/<name>/index.ts default-exporting an AnswerSourcePlugin) and the CLI
// picks it up: answers resolution, pre-commit verification gates, provenance
// reporting, and extra commands (run them via `nub run addon <command>`).
// Addons are plain TypeScript — nub runs them directly, no build step.
import { existsSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { ROOT } from './config'
import type { Answer } from './common'

// Every installed addon is asked for every round and the host merges their
// answers per vote (src/answers.ts): one source answering is a suggestion, two
// agreeing is a suggestion, two giving different non-empty answers is a
// disagreement the review leaves blank for the owner. An empty answer ('') is
// "no opinion" and never disagrees with anything. An answer with a non-empty
// `conflict` (a short reason) says this source itself found the vote
// contested: the host treats the vote exactly like a disagreement, whatever
// the other sources say (left blank for the owner, flagged with the reason
// per row and in details, a batch run aborts on it unless the owner has a
// decided answer for it). `conflict` with answer '' is not "no opinion".
// Fields that are not strings are dropped at ingestion with one visible line
// for the addon; the rest of its answers are used. A present, non-empty
// `conflict` of the wrong type is the exception: it stays a conflict (reason
// "malformed conflict field"), since the field is there to hold a vote back
// and dropping it would let another source fill it. An addon written against
// the original interface (no confidence, no conflict, no empty answers) keeps
// working unchanged.
// Why the host is asking. `review` is true only when the interactive commit
// review will show the answers before anything is signed; false for batch
// commits (--yes, piped, --dry-run) and for read-only commands (status,
// questions, results), which ask for titles and never sign. An addon whose
// answers are suggestions for a human can use it to do nothing otherwise.
export type AnswersContext = { review: boolean }

export type AnswerSourcePlugin = {
    name: string
    /** Resolve a round's answers. Return undefined to pass (the host prints one
     *  line saying this addon passed, not that it failed; the other addons
     *  carry on). Each answer may carry `confidence` (see Answer in
     *  common.ts): a measured figure with what it rests on. Leave it out when
     *  nothing was measured; the review then shows "not rated". An answer may
     *  carry `conflict`, a short reason this source found the vote contested;
     *  the host then leaves the vote for the owner like a disagreement, even
     *  with answer ''. `ctx` says whether a human will review the answers;
     *  addons written without it keep working. */
    getAnswers(roundId: number, ctx?: AnswersContext): Promise<{ source: string; answers: Answer[] } | undefined>
    /** Fetch the current round's answers from upstream — called by `commit` when
     *  this addon's getAnswers came up empty, and again on the review's refresh
     *  (r / --refetch). Cache locally if re-runs should reuse the download, and
     *  serve that cache from getAnswers: while an addon with pullAnswers is
     *  installed the host treats answers/<round>.json as that addon's cache and
     *  does not read it itself. Return undefined to pass. */
    pullAnswers?(roundId: number): Promise<{ source: string; answers: Answer[] } | undefined>
    /** Pre-commit gate over the answers THIS addon supplied (never another
     *  addon's). Return ok:false to block the commit (--force overrides).
     *  Throw when verification itself failed (network etc.) — also blocks.
     *  Not called when the addon supplied nothing. ANSWERS_FILE is the one
     *  exception: an explicit override file goes through every gate. */
    verifyBeforeCommit?(roundId: number, answers: Answer[]): Promise<{ ok: boolean; detail: string }>
    /** Print provenance / trust warnings before the vote table. */
    report?(roundId: number): Promise<void>
    /** Extra commands, dispatched by `nub run addon <command>` — or
     *  `nub run addon <addon> <command>` when two addons share a command name
     *  (the unqualified form refuses ambiguity). process.argv is preserved. */
    commands?: Record<string, { description: string; run(argv: string[]): Promise<void> }>
}

let cache: AnswerSourcePlugin[] | undefined

export async function loadAddons(): Promise<AnswerSourcePlugin[]> {
    if (cache) return cache
    cache = []
    const dir = path.join(ROOT, 'addons')
    if (!existsSync(dir)) return cache
    for (const name of readdirSync(dir)) {
        const entry = path.join(dir, name, 'index.ts')
        if (!existsSync(entry)) continue
        try {
            const mod = await import(pathToFileURL(entry).href)
            if (mod.default?.name) cache.push(mod.default as AnswerSourcePlugin)
            else console.error(`⚠ addon "${name}" has no default AnswerSourcePlugin export — skipped`)
        } catch (e) {
            console.error(`⚠ addon "${name}" failed to load: ${(e as Error).message.split('\n')[0]}`)
        }
    }
    return cache
}
