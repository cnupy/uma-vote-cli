import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Minimal .env loader (no dependency)
const envPath = path.join(ROOT, '.env')
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
        if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
}

export const UMA_VOTING_V2 = '0x004395edb43EFca9885CEdad51EC9fAf93Bd34ac' as const

// Read-only RPC(s) for queries and simulation. RPC_URL accepts a single URL or a
// comma-separated list tried in order (viem fallback transport). Endpoints must
// support eth_getLogs over ~10k-block ranges (drpc free tier does; publicnode
// does not).
export const RPC_URLS = (process.env.RPC_URL ?? 'https://eth.drpc.org')
    .split(',').map(u => u.trim()).filter(Boolean)

// Signing backend config (SIGNER, FRAME_URL, TREZOR_PATH, LEDGER_PATH,
// LATTICE_*, WALLETCONNECT_PROJECT_ID) is read by src/signers/* at connect
// time — see `nub run init` and .env.example.

// Optional local answers file override (path to a JSON file). Without it,
// answers come from the local answers/ cache or an installed addon.
export const ANSWERS_FILE = process.env.ANSWERS_FILE

// Optional: assert the wallet account matches this address before sending
export const EXPECTED_VOTER = process.env.EXPECTED_VOTER as `0x${string}` | undefined

// Where round files (salts, tx hashes) are stored. Point it at a private,
// version-controlled location if you want git-backed backups.
export const ROUNDS_DIR = process.env.ROUNDS_DIR
    ? path.resolve(ROOT, process.env.ROUNDS_DIR)
    : path.join(ROOT, 'rounds')

// GitHub API auth: GITHUB_TOKEN env → gh CLI session → anonymous (60 req/h)
function resolveGithubToken(): string | undefined {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
    try {
        return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
    } catch {
        return undefined
    }
}
const githubToken = resolveGithubToken()
export const GITHUB_ANONYMOUS = !githubToken
export const GITHUB_HEADERS: Record<string, string> = {
    accept: 'application/vnd.github+json',
    ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
}
