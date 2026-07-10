// About/license screen (Ink). Opened from the votes screen with i: version,
// repository link, installed addons and the full LICENSE text. Read-only —
// any of q/esc/i returns home.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { ROOT } from './config'
import { appVersion } from './common'
import { hyperlink } from './tui'
import { loadAddons } from './addons'

// Static by definition — read once per process
let cached: { version: string; license: string; repoUrl: string } | undefined
const info = () => {
    if (cached) return cached
    const version = appVersion()
    let license = 'MIT', repoUrl = 'https://github.com/cnupy/uma-vote-cli'
    try {
        const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { repository?: string }
        const m = /^github:(.+)$/.exec(pkg.repository ?? '')
        if (m) repoUrl = `https://github.com/${m[1]}`
    } catch { /* keep defaults */ }
    // \r stripped: a CRLF checkout leaves carriage returns that garble Ink's layout
    try { license = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').replace(/\r/g, '').trimEnd() } catch { /* keep the one-word fallback */ }
    return cached = { version, license, repoUrl }
}

export function AboutScreen({ onExit }: { onExit: () => void }) {
    const { version, license, repoUrl } = info()
    const [addons, setAddons] = useState<string[]>()
    useEffect(() => { loadAddons().then(a => setAddons(a.map(x => x.name))) }, [])

    useInput((input, key) => {
        if (input === 'q' || input === 'i' || key.escape) onExit()
    })

    return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>uma-vote-cli <Text dimColor>v{version}</Text></Text>
            <Text dimColor wrap="wrap">General-purpose CLI for UMA VotingV2: commit/reveal voting with hardware wallets, live round results, staking, and pluggable answer-source addons.</Text>
            <Text>repository: <Text color="cyan">{hyperlink(repoUrl, repoUrl.replace('https://', ''))}</Text></Text>
            <Text>addons:     {addons === undefined ? <Text dimColor>…</Text> : addons.length > 0 ? addons.join(', ') : <Text dimColor>none installed</Text>}</Text>
            <Text> </Text>
            {license.split('\n').map((l, i) => <Text key={i} dimColor wrap="wrap">{l || ' '}</Text>)}
            <Text> </Text>
            <Text dimColor>q/esc/i back</Text>
        </Box>
    )
}
