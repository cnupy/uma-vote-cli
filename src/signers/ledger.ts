import { createRequire } from 'node:module'
import { createWalletClient, fallback, getAddress, http, serializeTransaction } from 'viem'
import { toAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { RPC_URLS } from '../config'
import { ask } from './prompt'
import type { Wallet } from './types'

export const DEFAULT_LEDGER_PATH = "44'/60'/0'/0/0"

// Direct Ledger signing over USB. The Ethereum app must be open on the device
// with blind signing enabled (multicall calldata has no clear-signing
// metadata, so the device shows hashes only). Close Ledger Live while this runs.
export async function connect(): Promise<Wallet> {
    const path = process.env.LEDGER_PATH ?? DEFAULT_LEDGER_PATH
    // require() the CJS builds: the packages' ESM builds have broken
    // extensionless internal imports that fail under node/nub ESM
    const require = createRequire(import.meta.url)
    const { default: TransportNodeHid } = require('@ledgerhq/hw-transport-node-hid') as typeof import('@ledgerhq/hw-transport-node-hid')
    const { default: Eth, ledgerService } = require('@ledgerhq/hw-app-eth') as typeof import('@ledgerhq/hw-app-eth')

    // Fixable device states get a wait-and-retry prompt instead of an error:
    // not plugged in, locked (0x5515/0x6b0c), no/wrong app open (0x6511/
    // 0x6d00/0x6e00), or the USB re-enumeration when an app opens/closes
    // (which kills the current transport — hence reconnecting from scratch).
    let eth: InstanceType<typeof Eth> | undefined
    let transport: Awaited<ReturnType<typeof TransportNodeHid.create>> | undefined
    const getEth = async () => {
        if (!eth) {
            transport = await TransportNodeHid.create()
            eth = new Eth(transport)
        }
        return eth
    }
    const RETRYABLE = /0x6511|0x6d00|0x6e00|0x5515|0x6b0c|locked|disconnected|no device|cannot open|access denied/i
    const withDeviceRetry = async <T>(fn: (eth: InstanceType<typeof Eth>) => Promise<T>): Promise<T> => {
        for (;;) {
            try {
                return await fn(await getEth())
            } catch (e) {
                const err = e as Error
                if (!RETRYABLE.test(`${err?.name ?? ''} ${err?.message ?? String(e)}`)) throw e
                await transport?.close().catch(() => {})
                eth = undefined
                transport = undefined
                await ask('On the Ledger: connect, unlock and open the Ethereum app, then press Enter to retry')
            }
        }
    }

    const address = getAddress((await withDeviceRetry(e => e.getAddress(path))).address as `0x${string}`)

    const account = toAccount({
        address,
        async signMessage({ message }) {
            if (typeof message !== 'string') throw new Error('raw message signing not supported by the ledger backend')
            const sig = await withDeviceRetry(e => e.signPersonalMessage(path, Buffer.from(message, 'utf8').toString('hex')))
            return `0x${sig.r}${sig.s}${sig.v.toString(16).padStart(2, '0')}` as `0x${string}`
        },
        async signTransaction(tx) {
            const unsigned = serializeTransaction(tx).slice(2)
            // Clear-signing metadata lookup is best-effort — none exists for VotingV2
            const resolution = await ledgerService
                .resolveTransaction(unsigned, {}, { erc20: false, externalPlugins: false, nft: false })
                .catch(() => null)
            const sig = await withDeviceRetry(e => e.signTransaction(path, unsigned, resolution))
            const v = parseInt(sig.v, 16)
            return serializeTransaction(tx, { r: `0x${sig.r}`, s: `0x${sig.s}`, yParity: v >= 27 ? v - 27 : v })
        },
        async signTypedData() { throw new Error('typed-data signing not needed by this tool') },
    })
    const client = createWalletClient({ chain: mainnet, transport: fallback(RPC_URLS.map(u => http(u))) })
    return { kind: 'ledger', client, account }
}
