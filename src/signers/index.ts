import { SIGNER_KINDS, type SignerKind, type Wallet } from './types'

export { SIGNER_KINDS, type SignerKind, type Wallet } from './types'

// SIGNER env picks the backend (default: frame). Read at call time, not module
// load, so the init wizard can set it before connecting.
export function signerKind(): SignerKind {
    const kind = (process.env.SIGNER ?? 'frame').toLowerCase() as SignerKind
    if (!SIGNER_KINDS.includes(kind)) {
        throw new Error(`Unknown SIGNER "${kind}" — expected one of: ${SIGNER_KINDS.join(', ')}. Run \`nub run init\`.`)
    }
    return kind
}

// Lazy singleton: Frame/USB/relay is only touched on first use, and read-only
// commands never touch it at all.
let wallet: Promise<Wallet> | undefined
export function getWallet(): Promise<Wallet> {
    wallet ??= connectWallet()
    return wallet
}

async function connectWallet(): Promise<Wallet> {
    switch (signerKind()) {
        case 'frame': return (await import('./frame')).connect()
        case 'trezor': return (await import('./trezor')).connect()
        case 'ledger': return (await import('./ledger')).connect()
        case 'lattice': return (await import('./lattice')).connect()
        case 'walletconnect': return (await import('./walletconnect')).connect()
    }
}
