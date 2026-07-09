import { createWalletClient, getAddress, http } from 'viem'
import { toAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import type { Wallet } from './types'

// Frame.sh local RPC — Frame's GUI routes signing to the hardware wallet
// (Ledger/Trezor/Lattice) and lets you edit fees before approving.
export async function connect(): Promise<Wallet> {
    const url = process.env.FRAME_URL ?? 'http://127.0.0.1:1248'
    const client = createWalletClient({
        chain: mainnet,
        // 5 min timeout: requests wait for physical confirmation on the hardware wallet
        // Origin header identifies this tool in Frame's permission prompt
        transport: http(url, { timeout: 300_000, fetchOptions: { headers: { Origin: 'http://uma-vote-cli' } } }),
    })
    let addresses: `0x${string}`[]
    try {
        addresses = await client.requestAddresses()
    } catch (e) {
        throw new Error(`Couldn't reach Frame at ${url}. Is Frame running and your hardware wallet connected/unlocked?\n(${(e as Error).message})`)
    }
    if (addresses.length === 0) throw new Error('Frame returned no account. Select an account in Frame first.')
    return { kind: 'frame', client, account: toAccount(getAddress(addresses[0])) }
}
