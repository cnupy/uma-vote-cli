// Reveal committed votes for the current round. Chain-first: the price+salt for
// every reveal comes from decrypting your own on-chain EncryptedVote blobs (the
// latest per request wins), which covers commits made by this tool AND by
// vote.uma.xyz — including mixed rounds where some requests were re-committed
// with different salts. The local round file is only a fallback for legacy
// commits that carried no encrypted blob.
import { encodeFunctionData } from 'viem'
import { readdirSync, existsSync } from 'node:fs'
import { umaContractAbi } from './umaAbi'
import { ROUNDS_DIR } from './config'
import {
    publicClient, votingContract, getWalletAccount, getVotePhase, getCurrentRoundId,
    getVoterFromDelegate, getEncryptedVoteEvents, decodeIdentifier, resolveFees, sendMulticallBatched,
    loadRound, saveRound, hasFlag, phaseEndsAt, fmtCountdown, type RoundFile,
} from './common'
import { getSigningKey, decryptVote } from './crypto'
import { priceLabel } from './compare'

const dryRun = hasFlag('--dry-run')
const force = hasFlag('--force')

// Tool-managed rounds that were committed but never revealed before their window closed
function missedRounds(currentRoundId: number): number[] {
    if (!existsSync(ROUNDS_DIR)) return []
    return readdirSync(ROUNDS_DIR)
        .map(f => /^(\d+)\.json$/.exec(f)?.[1])
        .filter((id): id is string => id !== undefined)
        .map(Number)
        .filter(id => id < currentRoundId)
        .filter(id => { const r = loadRound(id); return r?.commitTxHash && !r.revealTxHash })
}

const phase = await getVotePhase()
if (phase !== 1) {
    const currentRoundId = await getCurrentRoundId()
    console.error(`Not reveal phase (current phase: commit).`)
    const missed = missedRounds(currentRoundId)
    if (missed.length > 0) {
        console.error(`\n💀 MISSED REVEAL: round(s) ${missed.join(', ')} were committed but never revealed and their window has closed.`)
        console.error(`Those commitments count as no-shows (slashed); revealing them is no longer possible.`)
        console.error(`The reveal phase starting ${phaseEndsAt().toISOString()} is for the CURRENT round (${currentRoundId}) only.`)
    } else {
        console.error(`Reveal phase for round ${currentRoundId} starts ${phaseEndsAt().toISOString()} (${fmtCountdown(phaseEndsAt())}).`)
    }
    process.exit(1)
}

const roundId = await getCurrentRoundId()
console.log(`Round ${roundId} — reveal phase, ends ${phaseEndsAt().toISOString()} (${fmtCountdown(phaseEndsAt())} left)\n`)

const missedEarlier = missedRounds(roundId)
if (missedEarlier.length > 0) {
    console.log(`💀 Note: earlier round(s) ${missedEarlier.join(', ')} were committed but never revealed — their window closed (slashed). Only round ${roundId} can be revealed now.\n`)
}

const account = await getWalletAccount()
const fileRound = loadRound(roundId)

if (fileRound?.revealTxHash && !force) {
    console.error(`Already revealed this round (tx ${fileRound.revealTxHash}). Use --force to retry.`)
    process.exit(1)
}

// Latest commitment per request, from on-chain blobs
const events = await getEncryptedVoteEvents(account, roundId)
type Reveal = { identifier: `0x${string}`; time: bigint; ancillaryData: `0x${string}`; price: bigint; salt: bigint; label: string }
const reveals: Reveal[] = []
const undecryptable: string[] = []

if (events.length > 0) {
    const key = await getSigningKey(account)
    const fileVotes = fileRound?.votes ?? []
    for (const ev of events) {
        const label = `${decodeIdentifier(ev.identifier)} @ ${ev.time}`
        try {
            if (ev.encryptedVote === '0x' || ev.encryptedVote.length <= 4) throw new Error('empty blob')
            const { price, salt } = await decryptVote(key.privateKey, ev.encryptedVote)
            reveals.push({ identifier: ev.identifier, time: ev.time, ancillaryData: ev.ancillaryData, price: BigInt(price), salt: BigInt(salt), label })
        } catch {
            // No/foreign blob — fall back to the local round file (legacy random-salt commits)
            const v = fileVotes.find(f =>
                f.identifier.toLowerCase() === ev.identifier.toLowerCase() &&
                BigInt(f.time) === ev.time &&
                f.ancillaryData.toLowerCase() === ev.ancillaryData.toLowerCase())
            if (v) reveals.push({ identifier: ev.identifier, time: ev.time, ancillaryData: ev.ancillaryData, price: BigInt(v.price), salt: BigInt(v.salt), label: `${label} (salt from local file)` })
            else undecryptable.push(label)
        }
    }
} else if (fileRound && fileRound.votes.length > 0) {
    console.log(`No EncryptedVote events found — falling back entirely to rounds/${roundId}.json.`)
    for (const v of fileRound.votes) {
        reveals.push({ identifier: v.identifier, time: BigInt(v.time), ancillaryData: v.ancillaryData, price: BigInt(v.price), salt: BigInt(v.salt), label: v.question })
    }
} else {
    console.error(`No commitments found for ${account} in round ${roundId} — nothing to reveal.`)
    process.exit(1)
}

if (undecryptable.length > 0) {
    console.log(`⚠️  ${undecryptable.length} commitment(s) can't be revealed (no decryptable blob, no local salt):`)
    for (const u of undecryptable) console.log(`  ⚠ ${u}`)
    console.log(`If these were committed by the dApp with a different signing key, reveal them on vote.uma.xyz.\n`)
}

console.log(`Votes to reveal (${reveals.length}):`)
for (const [i, r] of reveals.entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. [${priceLabel(r.price)}] ${r.label}`)
}

// Simulate each reveal individually so one already-revealed/uncommitted entry
// doesn't block the rest of the batch.
const datas: `0x${string}`[] = []
const skipped: string[] = []
for (const r of reveals) {
    const args = [r.identifier, r.time, r.price, r.ancillaryData, r.salt] as const
    try {
        await publicClient.simulateContract({ ...votingContract, functionName: 'revealVote', args: args as any, account })
        datas.push(encodeFunctionData({ abi: umaContractAbi, functionName: 'revealVote', args: args as any }))
    } catch (e) {
        skipped.push(`${r.label} — ${(e as Error).message.split('\n')[0]}`)
    }
}

if (skipped.length > 0) {
    console.log(`\nSkipping ${skipped.length} (simulation failed — likely already revealed):`)
    for (const s of skipped) console.log(`  ⚠ ${s}`)
}
if (datas.length === 0) {
    console.log('\nNothing to reveal.')
    process.exit(0)
}

if (dryRun) {
    const calldata = encodeFunctionData({ abi: umaContractAbi, functionName: 'multicall', args: [datas] })
    console.log(`\n--dry-run: not sending. To submit manually:\n  to:   ${votingContract.address}\n  data: ${calldata}`)
    process.exit(0)
}

console.log('')
const fees = await resolveFees()
const txHashes = await sendMulticallBatched(datas, account, fees, 'reveal')
const txHash = txHashes[txHashes.length - 1]

const round: RoundFile = fileRound ?? {
    roundId, caller: account, voter: await getVoterFromDelegate(account),
    answersSource: 'on-chain', createdAt: new Date().toISOString(),
    votes: reveals.map(r => ({
        identifier: r.identifier, identifierDecoded: decodeIdentifier(r.identifier),
        time: r.time.toString(), ancillaryData: r.ancillaryData,
        question: r.label, answer: priceLabel(r.price), price: r.price.toString(), salt: r.salt.toString(),
    })),
}
round.revealTxHash = txHash
saveRound(round)
console.log(`\n✅ Revealed ${datas.length} vote(s) in round ${roundId}. Done for this round.`)
// USB/WalletConnect signer sessions hold the event loop open — exit explicitly
process.exit(0)
