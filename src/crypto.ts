import EthCrypto from 'eth-crypto'
import { keccak256, encodePacked } from 'viem'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT, EXPECTED_VOTER } from './config'
import { getWallet } from './common'

// Must match the voter dApp's NEXT_PUBLIC_SIGNING_MESSAGE for vote.uma.xyz to be
// able to decrypt/reveal our commits. Verify with `nub run verify-key`.
export const SIGNING_MESSAGE = process.env.SIGNING_MESSAGE ?? 'Login to UMA Voter dApp'

const KEY_CACHE = path.join(ROOT, '.signing-key.json')

// The voter identity as a lowercase address, without touching the wallet:
// EXPECTED_VOTER takes precedence, else the first cached signing-key entry.
export function voterIdentity(): `0x${string}` | undefined {
    if (EXPECTED_VOTER) return EXPECTED_VOTER.toLowerCase() as `0x${string}`
    if (!existsSync(KEY_CACHE)) return undefined
    const cache = JSON.parse(readFileSync(KEY_CACHE, 'utf8')) as Record<string, { address: string }>
    return Object.values(cache)[0]?.address.toLowerCase() as `0x${string}` | undefined
}

export type SigningKey = {
    address: `0x${string}`
    signedMessage: `0x${string}`
    privateKey: `0x${string}`
    publicKey: string
}

// Mirrors voter-dapp-v2 helpers/web3/crypto.ts derivePrivateKey():
// solidityKeccak256(["string"], [signature]) — keccak over the UTF-8 bytes of
// the "0x..." signature string, not the raw signature bytes.
function derivePrivateKey(signature: `0x${string}`): `0x${string}` {
    return keccak256(encodePacked(['string'], [signature]))
}

// One personal_sign on the hardware wallet per account (cached afterwards).
// The derived key encrypts/decrypts vote blobs — identical to what vote.uma.xyz
// derives when you sign its login message with the same account.
export async function getSigningKey(account: `0x${string}`): Promise<SigningKey> {
    if (existsSync(KEY_CACHE)) {
        const cached = JSON.parse(readFileSync(KEY_CACHE, 'utf8')) as Record<string, SigningKey>
        if (cached[account.toLowerCase()]) return cached[account.toLowerCase()]
    }
    console.log(`Requesting one-time signature ("${SIGNING_MESSAGE}") — confirm on your hardware wallet...`)
    const wallet = await getWallet()
    if (wallet.account.address.toLowerCase() !== account.toLowerCase()) {
        throw new Error(`Signer account ${wallet.account.address} doesn't match ${account} — the key would be cached under the wrong address.`)
    }
    const signedMessage = await wallet.client.signMessage({ account: wallet.account, message: SIGNING_MESSAGE })
    const privateKey = derivePrivateKey(signedMessage)
    const publicKey = EthCrypto.publicKeyByPrivateKey(privateKey)
    const key: SigningKey = { address: account, signedMessage, privateKey, publicKey }

    const cached = existsSync(KEY_CACHE) ? JSON.parse(readFileSync(KEY_CACHE, 'utf8')) : {}
    cached[account.toLowerCase()] = key
    writeFileSync(KEY_CACHE, JSON.stringify(cached, null, 2), { mode: 0o600 }) // owner-only on POSIX (no-op on Windows)
    console.log(`Signing key cached in .signing-key.json (keep private — it decrypts your vote blobs).`)
    return key
}

// Deterministic per-request salt derived from the signature: any machine with the
// same hardware wallet can regenerate it (RFC 6979 signatures are deterministic).
// >> 8 keeps it a positive int256 (248 bits).
export function deterministicSalt(
    signedMessage: `0x${string}`, roundId: number,
    identifier: `0x${string}`, time: bigint, ancillaryData: `0x${string}`,
): bigint {
    const h = keccak256(encodePacked(
        ['string', 'uint256', 'bytes32', 'uint256', 'bytes'],
        [signedMessage, BigInt(roundId), identifier, time, ancillaryData],
    ))
    return BigInt(h) >> 8n
}

// dApp blob format: "0x" + EthCrypto.cipher.stringify(encryptWithPublicKey(...))
export async function encryptVote(publicKey: string, price: bigint, salt: bigint): Promise<`0x${string}`> {
    const payload = JSON.stringify({ price: price.toString(), salt: salt.toString() })
    const encrypted = await EthCrypto.encryptWithPublicKey(publicKey, payload)
    return ('0x' + EthCrypto.cipher.stringify(encrypted)) as `0x${string}`
}

export async function decryptVote(privateKey: `0x${string}`, encryptedVote: `0x${string}`): Promise<{ price: string; salt: string }> {
    const parsed = EthCrypto.cipher.parse(encryptedVote.slice(2))
    return JSON.parse(await EthCrypto.decryptWithPrivateKey(privateKey, parsed)) as { price: string; salt: string }
}
