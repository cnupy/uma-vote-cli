// Verifies dApp compatibility end-to-end: derives the signing key via your
// hardware wallet, then decrypts one of YOUR OWN past EncryptedVote blobs that
// vote.uma.xyz published when you committed through it. If decryption succeeds,
// the signing message matches production and browser reveal will work for
// commits made by this tool (and vice versa).
import { getWalletAccount, getEncryptedVoteEvents, decodeIdentifier, handleHelp } from './common'
import { getSigningKey, decryptVote, SIGNING_MESSAGE } from './crypto'

handleHelp(`Usage: nub run verify-key
Derive the vote-encryption key via your wallet and prove it decrypts one of
your own past on-chain EncryptedVote blobs (dApp compatibility check).
Touches the signer. No options. --help, -h show this help.`)

const account = await getWalletAccount()
console.log(`Account: ${account}`)
console.log(`Signing message: "${SIGNING_MESSAGE}"\n`)

const key = await getSigningKey(account)

console.log(`Scanning last ~50k blocks (~7 days) for your EncryptedVote events...`)
const events = (await getEncryptedVoteEvents(account, undefined, 50_000n)).filter(e => e.encryptedVote !== '0x')
if (events.length === 0) {
    console.error(`No EncryptedVote blobs found for ${account}. Commit once via vote.uma.xyz first, then re-run.`)
    process.exit(1)
}
console.log(`Found ${events.length} blob(s). Trying to decrypt...\n`)

let ok = 0
for (const ev of events) {
    try {
        const { price, salt } = await decryptVote(key.privateKey, ev.encryptedVote)
        ok++
        if (ok <= 3) console.log(`✓ round ${ev.roundId} ${decodeIdentifier(ev.identifier)} @ ${ev.time} → price=${price} salt=${salt.slice(0, 12)}…`)
    } catch { /* counted below */ }
}

if (ok > 0) {
    console.log(`\n✅ Decrypted ${ok}/${events.length} blob(s) — key derivation matches the production dApp.`)
    console.log(`Commits made by this tool will be revealable on vote.uma.xyz, and this tool can recover dApp commits.`)
    // USB/WalletConnect signer sessions hold the event loop open — exit explicitly
    process.exit(0)
} else {
    console.error(`\n❌ Decrypted 0/${events.length}. The production dApp uses a different signing message than "${SIGNING_MESSAGE}".`)
    console.error(`Sign into vote.uma.xyz once, copy localStorage key "signingKeys" → "signedMessage", and figure out the message — or set SIGNING_MESSAGE in .env.`)
    process.exit(1)
}
