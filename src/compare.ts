// Your existing on-chain commitments for a round, decrypted from EncryptedVote
// blobs with the cached signing key — no wallet interaction. Covers commits made
// by this tool AND by vote.uma.xyz (same key derivation). Used by commit and
// status (and answer addons) to diff planned answers against what is committed.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT, EXPECTED_VOTER } from './config'
import { getEncryptedVoteEvents, decodeIdentifier, encodePrice, P1_VALUE, P2_VALUE, P3_VALUE, type Answer } from './common'
import { decryptVote } from './crypto'

export type OnChainCommitment = {
    identifier: `0x${string}`
    time: bigint
    ancillaryData: `0x${string}`
    price: bigint
}

// Returns undefined when nothing is committed; THROWS on RPC failure so callers
// can distinguish "no commitments" from "couldn't check" (a silent empty result
// here once made a freshly-committed round look uncommitted).
export async function getOnChainCommitments(roundId: number): Promise<{ address: `0x${string}`; commitments: OnChainCommitment[] } | undefined> {
    const keyCachePath = path.join(ROOT, '.signing-key.json')
    if (!existsSync(keyCachePath)) return undefined
    const cache = JSON.parse(readFileSync(keyCachePath, 'utf8')) as Record<string, { address: `0x${string}`; privateKey: `0x${string}` }>
    const key = EXPECTED_VOTER ? cache[EXPECTED_VOTER.toLowerCase()] : Object.values(cache)[0]
    if (!key) return undefined
    const events = await getEncryptedVoteEvents(key.address, roundId)
    if (events.length === 0) return undefined
    const commitments: OnChainCommitment[] = []
    for (const ev of events) {
        // ECIES decryption is synchronous CPU-bound math — yield between votes
        // so an embedding Ink UI keeps processing input during the sweep
        await new Promise(resolve => setImmediate(resolve))
        try {
            const { price } = await decryptVote(key.privateKey, ev.encryptedVote)
            commitments.push({ identifier: ev.identifier, time: ev.time, ancillaryData: ev.ancillaryData, price: BigInt(price) })
        } catch { /* blob from another key — ignore */ }
    }
    return commitments.length > 0 ? { address: key.address, commitments } : undefined
}

// Find (and consume) the commitment for a request; time optional for
// answers-file entries that may lack a timestamp.
export function takeCommitment(pool: OnChainCommitment[], ancillaryData: string, time?: bigint): OnChainCommitment | undefined {
    const idx = pool.findIndex(c =>
        c.ancillaryData.toLowerCase() === ancillaryData.toLowerCase() &&
        (time === undefined || c.time === time))
    return idx === -1 ? undefined : pool.splice(idx, 1)[0]
}

export const priceLabel = (p: bigint) =>
    p === P1_VALUE ? 'P1/no' : p === P2_VALUE ? 'P2/yes' : p === P3_VALUE ? 'P3' : 'P4'

// ANSI colors for diff tables
import { GREEN, RED, DIM, RESET } from './common'
export { GREEN, RED, DIM, CYAN, BOLD, RESET } from './common'

// Answer table, colored against existing on-chain commitments when provided:
// green = matches, red = differs (shows committed value), dim = not committed.
// Shared by status and answer addons.
export function renderAnswersDiff(
    answers: Answer[],
    onchain?: { address: `0x${string}`; commitments: OnChainCommitment[] },
): { mismatches: number; unclaimed: OnChainCommitment[] } {
    const unclaimed = onchain ? [...onchain.commitments] : []
    let mismatches = 0
    console.log(`\n  #  Answer  Question`)
    console.log(`  ${'-'.repeat(92)}`)
    for (const [i, a] of answers.entries()) {
        let color = '', note = ''
        if (onchain) {
            const c = takeCommitment(unclaimed, a.ancillaryData, a.timestamp !== undefined ? BigInt(a.timestamp) : undefined)
            if (!c) { color = DIM; note = '  (you have not committed this one)'; mismatches++ }
            else {
                const expected = encodePrice(a.answer, decodeIdentifier(c.identifier))
                if (expected !== undefined && expected === c.price) color = GREEN
                else { color = RED; note = `  (you committed ${priceLabel(c.price)})`; mismatches++ }
            }
        }
        console.log(`${color}  ${String(i + 1).padStart(2)}  ${(a.answer ?? '?').padEnd(6)}  ${(a.question ?? '(no title)').slice(0, 90)}${note}${RESET}`)
    }
    return { mismatches, unclaimed }
}
