import readline from 'node:readline'

// One shared line queue for every prompt in the process. readline's question()
// drops lines that arrive while no question is pending, which breaks piped
// stdin (answers arrive all at once) — so buffer every line and let ask() pop.
// The interface stays open, holding stdin — command entry points end with
// process.exit().
const lines: string[] = []
const waiters: ((line: string) => void)[] = []
let started = false

function start(): void {
    if (started) return
    started = true
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', line => {
        const waiter = waiters.shift()
        if (waiter) waiter(line)
        else lines.push(line)
    })
    // EOF with a question pending: resolve empty so fallbacks apply
    rl.on('close', () => { for (const waiter of waiters.splice(0)) waiter('') })
}

// While an ink app is registered here, prompts render through it instead of
// readline (which would fight ink for stdin and tear frames). With no bridge,
// ask()/note() behavior is byte-identical to the plain readline/console path.
export type PromptBridge = {
    ask(question: string): Promise<string>
    note?(text: string): void
}
let bridge: PromptBridge | undefined

export function setPromptBridge(b: PromptBridge | undefined): void {
    bridge = b
}

export async function ask(question: string, fallback?: string): Promise<string> {
    if (bridge) {
        const line = await bridge.ask(fallback ? `${question} [${fallback}]` : question)
        return line.trim() || fallback || ''
    }
    start()
    process.stdout.write(fallback ? `${question} [${fallback}]: ` : `${question}: `)
    const line = lines.shift() ?? await new Promise<string>(resolve => waiters.push(resolve))
    return line.trim() || fallback || ''
}

// Mid-flow prints (pairing hints, the WalletConnect QR) — rendered by the ink
// app while a bridge is registered, console.log otherwise.
export function note(text: string): void {
    if (bridge?.note) bridge.note(text)
    else console.log(text)
}
