// Dispatch addon-contributed commands: nub run addon <command> [args]
import { loadAddons } from './addons'

const [cmd, ...rest] = process.argv.slice(2)
const addons = await loadAddons()

const available: Array<[string, string, string]> = [] // [command, addon, description]
for (const a of addons) {
    for (const [name, c] of Object.entries(a.commands ?? {})) available.push([name, a.name, c.description])
}

if (!cmd) {
    if (available.length === 0) {
        console.log('No addon commands available. Install an addon into addons/ (see README).')
    } else {
        console.log('Addon commands:')
        for (const [name, addon, desc] of available) console.log(`  nub run addon ${name.padEnd(16)} ${desc} (${addon})`)
    }
    process.exit(0)
}

for (const a of addons) {
    const c = a.commands?.[cmd]
    if (c) {
        await c.run(rest)
        process.exit(0)
    }
}
console.error(`No addon provides "${cmd}".${available.length ? ` Available: ${available.map(([n]) => n).join(', ')}` : ' No addons installed.'}`)
process.exit(1)
