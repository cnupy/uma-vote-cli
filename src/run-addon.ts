// Dispatch addon-contributed commands:
//   nub run addon                      — list every command
//   nub run addon <command>            — run it (must be unambiguous)
//   nub run addon <addon>              — list one addon's commands
//   nub run addon <addon> <command>    — qualified, for names shared by addons
import { renderHelp, appVersion } from './common'
import { loadAddons } from './addons'

const args = process.argv.slice(2)
// Help/version only as the FIRST arg — a later --help belongs to the addon
// command being dispatched and must reach it untouched
if (args[0] === '--version' || args[0] === '-v') {
    console.log(appVersion())
    process.exit(0)
}
if (args[0] === '--help' || args[0] === '-h') {
    console.log(renderHelp(`Usage: nub run addon [<addon>] [<command>] [args]
Dispatch addon-contributed commands.
  nub run addon                     list every command
  nub run addon <command>           run it (must be unambiguous)
  nub run addon <addon>             list one addon's commands
  nub run addon <addon> <command>   qualified, for names shared by addons
Addon commands parse their own --flags.`))
    process.exit(0)
}
const addons = await loadAddons()

const available: Array<[string, string, string]> = [] // [command, addon, description]
for (const a of addons) {
    for (const [name, c] of Object.entries(a.commands ?? {})) available.push([name, a.name, c.description])
}
const list = (items: typeof available) => {
    for (const [name, addon, desc] of items) console.log(`  nub run addon ${name.padEnd(16)} ${desc} (${addon})`)
}

if (args.length === 0) {
    if (available.length === 0) {
        console.log('No addon commands available. Install an addon into addons/ (see README).')
    } else {
        console.log('Addon commands:')
        list(available)
    }
    process.exit(0)
}

// Qualified form: the first arg names an installed addon
const byName = addons.find(a => a.name === args[0])
if (byName) {
    const [, cmd, ...rest] = args
    if (!cmd || cmd === '--help' || cmd === '-h') {
        console.log(`Commands from ${byName.name}:`)
        list(available.filter(([, addon]) => addon === byName.name))
        process.exit(0)
    }
    const c = byName.commands?.[cmd]
    if (!c) {
        console.error(`Addon "${byName.name}" has no command "${cmd}".`)
        process.exit(1)
    }
    await c.run(rest)
    process.exit(0)
}

const [cmd, ...rest] = args
const providers = addons.filter(a => a.commands?.[cmd])
if (providers.length > 1) {
    // Never silently pick a winner by directory order — make the user choose
    console.error(`"${cmd}" is provided by ${providers.length} addons — qualify it:`)
    for (const p of providers) console.error(`  nub run addon ${p.name} ${cmd}`)
    process.exit(1)
}
if (providers.length === 1) {
    await providers[0].commands![cmd].run(rest)
    process.exit(0)
}
console.error(`No addon provides "${cmd}".${available.length ? ` Available: ${available.map(([n]) => n).join(', ')}` : ' No addons installed.'}`)
process.exit(1)
