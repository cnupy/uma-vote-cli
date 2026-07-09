import path from 'node:path'
import { rmSync } from 'node:fs'
import { createWalletClient, custom, getAddress } from 'viem'
import { toAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { ROOT, RPC_URLS } from '../config'
import { note } from './prompt'
import type { Wallet } from './types'

// Any WalletConnect v2 wallet: MetaMask/Rabby (incl. their Trezor/Ledger
// integrations) or a mobile wallet. First run shows a QR to pair; the session
// persists in .walletconnect.db so later runs reconnect silently.
export async function connect(): Promise<Wallet> {
    const projectId = process.env.WALLETCONNECT_PROJECT_ID
    if (!projectId) throw new Error('WALLETCONNECT_PROJECT_ID not set — create a free project at https://cloud.reown.com, then run `nub run init`.')
    // named export: the CJS interop `default` is the module object, not the class
    const [{ EthereumProvider }, { default: qrcode }] = await Promise.all([
        import('@walletconnect/ethereum-provider'),
        import('qrcode-terminal'),
    ])
    // A session the wallet has dropped still sits in .walletconnect.db, so
    // enable() silently reuses the corpse and no QR ever shows. --reconnect
    // wipes the stored session for a guaranteed fresh pairing.
    const db = path.join(ROOT, '.walletconnect.db')
    if (process.argv.includes('--reconnect')) {
        note('--reconnect: discarding the stored WalletConnect session — a new pairing QR follows.')
        rmSync(db, { recursive: true, force: true })
    }
    const provider = await EthereumProvider.init({
        projectId,
        chains: [mainnet.id],
        rpcMap: { [mainnet.id]: RPC_URLS[0] },
        showQrModal: false,
        metadata: { name: 'uma-vote-cli', description: 'UMA VotingV2 CLI', url: 'https://github.com/cnupy/uma-vote-cli', icons: [] },
        storageOptions: { database: db },
    })
    provider.on('display_uri', (uri: string) => {
        // note() so an ink app (init wizard) renders the QR instead of a mid-frame print
        note('\nPair a wallet: scan the QR, or paste the URI into its WalletConnect dialog.\n')
        qrcode.generate(uri, { small: true }, qr => note(qr))
        note(`${uri}\n`)
    })

    // Expired sessions re-pair automatically (fresh QR) instead of failing on use
    if (provider.session && provider.session.expiry * 1000 < Date.now()) {
        note('WalletConnect session expired — pairing again.')
        await provider.disconnect().catch(() => { /* relay unreachable — enable() below starts fresh anyway */ })
    }

    const accounts = await provider.enable()
    if (accounts.length === 0) throw new Error('WalletConnect session has no account.')
    const address = getAddress(accounts[0])

    const client = createWalletClient({ chain: mainnet, transport: custom(provider) })
    return { kind: 'walletconnect', client, account: toAccount(address) }
}
