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
