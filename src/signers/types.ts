import type { Account, Chain, Transport, WalletClient } from 'viem'

// Signing backends. Each connects to a hardware wallet a different way but
// yields the same shape: a viem wallet client plus the account that signs.
//  - frame / walletconnect: json-rpc account — the external app signs and sends
//  - trezor / ledger / lattice: local account — the device signs, we broadcast
//    via the read RPC (eth_sendRawTransaction)
export const SIGNER_KINDS = ['frame', 'trezor', 'ledger', 'lattice', 'walletconnect'] as const
export type SignerKind = (typeof SIGNER_KINDS)[number]

export type Wallet = {
    kind: SignerKind
    client: WalletClient<Transport, Chain>
    account: Account
}
