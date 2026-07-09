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

export type AnswerSourcePlugin = {
    name: string
    /** Resolve a round's answers. Return undefined to pass. */
    getAnswers(roundId: number): Promise<{ source: string; answers: Answer[] } | undefined>
    /** Fetch the current round's answers from upstream — called by `commit` when
     *  getAnswers came up empty, before falling back to an all-unanswered
     *  interactive review. Cache locally if re-runs should reuse the download
     *  (verifyBeforeCommit still runs on the result). Return undefined to pass. */
    pullAnswers?(roundId: number): Promise<{ source: string; answers: Answer[] } | undefined>
    /** Pre-commit gate. Return ok:false to block the commit (--force overrides).
     *  Throw when verification itself failed (network etc.) — also blocks. */
    verifyBeforeCommit?(roundId: number, answers: Answer[]): Promise<{ ok: boolean; detail: string }>
    /** Print provenance / trust warnings before the vote table. */
    report?(roundId: number): Promise<void>
    /** Extra commands, dispatched by `nub run addon <name>` (process.argv is preserved). */
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
