// Staking data + transaction layer for the `nub run uma` dashboard: VotingV2
// stake/rewards reads, the UMA token's balance/allowance, the dApp's subgraph
// vote count, and plain tx plans the UI simulates and sends.
import { formatUnits } from 'viem'
import { publicClient, votingContract } from './common'
import { UMA_VOTING_V2 } from './config'
import { umaContractAbi } from './umaAbi'

// Minimal ERC-20 surface — only what the dashboard touches on the UMA token
export const erc20Abi = [
    { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

export type StakingSnapshot = {
    voter: `0x${string}`
    staked: bigint
    pendingUnstake: bigint
    // VotingV2 stores the time the unstake becomes EXECUTABLE (requestUnstake
    // sets it to now + unstakeCoolDown) — no addition needed here.
    unstakeExecutableAt: bigint
    rewards: bigint
    emissionRate: bigint
    cumulativeStake: bigint
    unstakeCoolDown: bigint
    umaToken: `0x${string}`
    walletBalance: bigint
    allowance: bigint
    aprPercent: string
    fetchedAt: number
}

// The dApp truncates APR to 1 decimal (21.28 → "21.2") — no rounding
export function aprPercent(emissionRate: bigint, cumulativeStake: bigint): string {
    if (cumulativeStake === 0n) return '0.0'
    const tenths = emissionRate * 31536000n * 1000n / cumulativeStake
    return `${tenths / 10n}.${tenths % 10n}`
}

export async function fetchDashboard(voter: `0x${string}`): Promise<StakingSnapshot> {
    const [stakes, rewards, emissionRate, cumulativeStake, unstakeCoolDown, umaToken] = await Promise.all([
        publicClient.readContract({ ...votingContract, functionName: 'voterStakes', args: [voter] }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, `0x${string}`]>,
        publicClient.readContract({ ...votingContract, functionName: 'outstandingRewards', args: [voter] }) as Promise<bigint>,
        publicClient.readContract({ ...votingContract, functionName: 'emissionRate' }) as Promise<bigint>,
        publicClient.readContract({ ...votingContract, functionName: 'cumulativeStake' }) as Promise<bigint>,
        publicClient.readContract({ ...votingContract, functionName: 'unstakeCoolDown' }) as Promise<bigint>,
        publicClient.readContract({ ...votingContract, functionName: 'votingToken' }) as Promise<`0x${string}`>,
    ])
    const [staked, pendingUnstake, , , , , unstakeExecutableAt] = stakes
    const [walletBalance, allowance] = await Promise.all([
        publicClient.readContract({ address: umaToken, abi: erc20Abi, functionName: 'balanceOf', args: [voter] }),
        publicClient.readContract({ address: umaToken, abi: erc20Abi, functionName: 'allowance', args: [voter, UMA_VOTING_V2] }),
    ])
    return {
        voter, staked, pendingUnstake, unstakeExecutableAt, rewards,
        emissionRate, cumulativeStake, unstakeCoolDown: BigInt(unstakeCoolDown),
        umaToken, walletBalance, allowance,
        aprPercent: aprPercent(emissionRate, cumulativeStake),
        fetchedAt: Date.now(),
    }
}

// ---------- vote count (dApp subgraph) ----------

const SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_clus2fndawbcc01w31192938i/subgraphs/mainnet-voting-v2/0.1.1/gn'

let voteCountCache: { voter: string; count: number; at: number } | undefined

// Failure-tolerant: undefined on any error, successes cached for 60s
export async function fetchVoteCount(voter: `0x${string}`): Promise<number | undefined> {
    const key = voter.toLowerCase()
    if (voteCountCache?.voter === key && Date.now() - voteCountCache.at < 60_000) return voteCountCache.count
    try {
        const res = await fetch(SUBGRAPH_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: `{users(where:{address:"${key}"}){countCorrectVotes countWrongVotes}}` }),
            signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) return undefined
        const json = await res.json() as { data?: { users?: { countCorrectVotes: string; countWrongVotes: string }[] } }
        if (!json.data?.users) return undefined
        const u = json.data.users[0]
        const count = u ? Number(u.countCorrectVotes) + Number(u.countWrongVotes) : 0
        voteCountCache = { voter: key, count, at: Date.now() }
        return count
    } catch {
        return undefined
    }
}

// ---------- tx plans ----------

// Everything simulateContract/writeContract need; the UI adds account + fees.
export type TxPlan = {
    label: string
    address: `0x${string}`
    abi: typeof umaContractAbi | typeof erc20Abi
    functionName: string
    args: readonly unknown[]
}

export const txApprove = (umaToken: `0x${string}`, amount: bigint): TxPlan =>
    ({ label: `approve ${formatUnits(amount, 18)} UMA for staking`, address: umaToken, abi: erc20Abi, functionName: 'approve', args: [UMA_VOTING_V2, amount] })

export const txStake = (amount: bigint): TxPlan =>
    ({ label: `stake ${formatUnits(amount, 18)} UMA`, address: UMA_VOTING_V2, abi: umaContractAbi, functionName: 'stake', args: [amount] })

export const txRequestUnstake = (amount: bigint): TxPlan =>
    ({ label: `request unstake of ${formatUnits(amount, 18)} UMA`, address: UMA_VOTING_V2, abi: umaContractAbi, functionName: 'requestUnstake', args: [amount] })

export const txExecuteUnstake = (): TxPlan =>
    ({ label: 'execute unstake', address: UMA_VOTING_V2, abi: umaContractAbi, functionName: 'executeUnstake', args: [] })

export const txWithdrawRewards = (): TxPlan =>
    ({ label: 'claim rewards to wallet', address: UMA_VOTING_V2, abi: umaContractAbi, functionName: 'withdrawRewards', args: [] })

export const txWithdrawAndRestake = (): TxPlan =>
    ({ label: 'claim & stake rewards', address: UMA_VOTING_V2, abi: umaContractAbi, functionName: 'withdrawAndRestake', args: [] })
