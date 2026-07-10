// Wallet screen for the uma dashboard: embeds the init wizard (init-ui) so
// the signer can be switched, re-paired and re-tested — rewriting .env —
// without leaving `nub run uma`. Deps come from the same makeWizardDeps() the
// standalone `nub run init` entrypoint uses. The running process keeps its
// current signer/env (nothing is hot-reloaded): a saved .env only takes
// effect on the next `nub run uma`, and the result line says so.
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { InitWizard, type WizardOutcome } from './init-ui'
import { makeWizardDeps } from './init'
import { getPromptBridge, setPromptBridge } from './signers/prompt'

export function WalletScreen({ onExit }: { onExit: () => void }) {
    const [deps] = useState(makeWizardDeps)
    const [outcome, setOutcome] = useState<WizardOutcome | undefined>()

    // InitWizard owns the prompt bridge while mounted and its cleanup sets it
    // to *undefined* — which would leave the dashboard (still mounted
    // underneath) bridgeless, so signer prompts on the next send would fall
    // back to raw readline and tear frames. Capture the dashboard's bridge
    // now (before the wizard's mount effect clobbers it) and put it back once
    // the wizard is gone: React runs the deleted child's cleanup before this
    // effect, so the restore wins.
    const savedBridge = useRef(getPromptBridge())
    useEffect(() => {
        if (outcome !== undefined) setPromptBridge(savedBridge.current)
    }, [outcome])

    // Only listens on the result line below — while the wizard is up, its own
    // input handler is the single active one
    useInput(() => onExit(), { isActive: outcome !== undefined })

    if (outcome === undefined) return <InitWizard deps={deps} onDone={setOutcome} />

    return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {outcome === 'saved'
                ? <Text color="green">✓ saved — .env updated</Text>
                : <Text>{outcome === 'failed' ? '❌ connection failed — nothing saved' : 'aborted — nothing saved'}</Text>}
            {outcome === 'saved' && <Text color="yellow" wrap="wrap">⚠ the running app keeps its current signer/env — restart `nub run uma` to apply the new signer.</Text>}
            <Text dimColor> press any key to return</Text>
        </Box>
    )
}
