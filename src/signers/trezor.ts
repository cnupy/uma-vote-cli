import { createWalletClient, fallback, getAddress, http, numberToHex } from 'viem'
import { toAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { RPC_URLS } from '../config'
import { ask } from './prompt'
import type { Wallet } from './types'

export const DEFAULT_TREZOR_PATH = "m/44'/60'/0'/0/0"

const hex0x = (s: string): `0x${string}` => (s.startsWith('0x') ? s : `0x${s}`) as `0x${string}`

// Direct Trezor signing over Trezor Bridge or USB. Close Trezor Suite while
// this runs — Suite holds the device session and causes connect loops.
export async function connect(): Promise<Wallet> {
    const path = process.env.TREZOR_PATH ?? DEFAULT_TREZOR_PATH
    const trz = await import('@trezor/connect')
    // CJS interop can leave the real export under default.default — unwrap either shape
    const TrezorConnect = (trz.default as unknown as { default?: typeof trz.default }).default ?? trz.default
    const { UI, UI_EVENT } = trz

    // Older devices enter PIN/passphrase on the host; newer ones on the device
    TrezorConnect.on(UI_EVENT, event => {
        if (event.type === UI.REQUEST_PIN) {
            void ask('Trezor PIN (keypad positions as shown on the device, 1-9)').then(pin =>
                TrezorConnect.uiResponse({ type: UI.RECEIVE_PIN, payload: pin }))
        } else if (event.type === UI.REQUEST_PASSPHRASE) {
            void ask('Trezor passphrase (Enter for standard wallet)').then(value =>
                TrezorConnect.uiResponse({ type: UI.RECEIVE_PASSPHRASE, payload: { value, save: true } }))
        }
    })
    await TrezorConnect.init({
        manifest: { appName: 'uma-vote-cli', email: 'noreply@uma-vote-cli.invalid', appUrl: 'https://github.com/cnupy/uma-vote-cli' },
        transports: ['BridgeTransport', 'NodeUsbTransport'],
    })
    // (payload is a success/error union TS doesn't narrow — hence the casts)
    const failure = (payload: unknown) => (payload as { error: string }).error

    const res = await TrezorConnect.ethereumGetAddress({ path, showOnTrezor: false })
    if (!res.success) {
        throw new Error(`Trezor: ${failure(res.payload)}. Is the device connected and unlocked? (Close Trezor Suite — it holds the device.)`)
    }
    const address = getAddress(res.payload.address)

    const account = toAccount({
        address,
        async signMessage({ message }) {
            if (typeof message !== 'string') throw new Error('raw message signing not supported by the trezor backend')
            const signed = await TrezorConnect.ethereumSignMessage({ path, message })
            if (!signed.success) throw new Error(`Trezor signMessage: ${failure(signed.payload)}`)
            return hex0x(signed.payload.signature)
        },
        async signTransaction(tx) {
            if (!tx.to) throw new Error('trezor backend only signs calls to a contract address')
            const signed = await TrezorConnect.ethereumSignTransaction({
                path,
                transaction: {
                    to: tx.to,
                    value: numberToHex(tx.value ?? 0n),
                    data: tx.data ?? '0x',
                    chainId: tx.chainId ?? mainnet.id,
                    nonce: numberToHex(tx.nonce!),
                    gasLimit: numberToHex(tx.gas!),
                    maxFeePerGas: numberToHex(tx.maxFeePerGas!),
                    maxPriorityFeePerGas: numberToHex(tx.maxPriorityFeePerGas!),
                },
            })
            if (!signed.success) throw new Error(`Trezor signTransaction: ${failure(signed.payload)}`)
            return hex0x(signed.payload.serializedTx)
        },
        async signTypedData() { throw new Error('typed-data signing not needed by this tool') },
    })
    const client = createWalletClient({ chain: mainnet, transport: fallback(RPC_URLS.map(u => http(u))) })
    return { kind: 'trezor', client, account }
}
