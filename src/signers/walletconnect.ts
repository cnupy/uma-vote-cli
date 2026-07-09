import path from 'node:path'
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
    const provider = await EthereumProvider.init({
        projectId,
        chains: [mainnet.id],
        rpcMap: { [mainnet.id]: RPC_URLS[0] },
        showQrModal: false,
        metadata: { name: 'uma-vote-cli', description: 'UMA VotingV2 CLI', url: 'https://github.com/cnupy/uma-vote-cli', icons: [] },
        storageOptions: { database: path.join(ROOT, '.walletconnect.db') },
    })
    provider.on('display_uri', (uri: string) => {
        // note() so an ink app (init wizard) renders the QR instead of a mid-frame print
        note('\nPair a wallet: scan the QR, or paste the URI into its WalletConnect dialog.\n')
        qrcode.generate(uri, { small: true }, qr => note(qr))
        note(`${uri}\n`)
    })

    const accounts = await provider.enable()
    if (accounts.length === 0) throw new Error('WalletConnect session has no account.')
    const address = getAddress(accounts[0])

    const client = createWalletClient({ chain: mainnet, transport: custom(provider) })
    return { kind: 'walletconnect', client, account: toAccount(address) }
}
