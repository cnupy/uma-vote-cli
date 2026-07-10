import { format } from 'node:util'

// Pluggable output for the extracted commit/reveal flows: a shell app passes
// its own sink to capture pipeline output; the CLI entrypoints use the
// console-backed default, which is byte-identical to the original scripts'
// console.log/console.error calls.
export type OutputSink = {
    log(line: string): void
    warn(line: string): void
    error(line: string): void
}

export const consoleSink: OutputSink = {
    log: line => console.log(line),
    warn: line => console.warn(line),
    error: line => console.error(line),
}

// Addons print with console.* (their API has no sink). While one runs inside
// an Ink app, those prints would render as raw stdout above the frame — so
// callers wrap addon calls to capture console output into the sink for the
// duration. Sinks may themselves write to the console (consoleSink, or a tee
// around it, resolves console.log at call time) — the originals are restored
// around every sink call so that can't recurse back into the capture.
export async function captureConsole<T>(out: OutputSink, fn: () => Promise<T>): Promise<T> {
    const orig = { log: console.log, warn: console.warn, error: console.error }
    const route = (write: (line: string) => void) => (...args: unknown[]) => {
        const captured = { log: console.log, warn: console.warn, error: console.error }
        Object.assign(console, orig)
        // util.format = console.log's own serialization (format specifiers,
        // object inspection), so the console-backed path stays byte-identical
        try { write(format(...args)) }
        finally { Object.assign(console, captured) }
    }
    console.log = route(out.log)
    console.warn = route(out.warn)
    console.error = route(out.error)
    try { return await fn() } finally { Object.assign(console, orig) }
}
