# uma-vote-cli

General-purpose CLI for [UMA](https://uma.xyz) VotingV2 commit/reveal voting — the
essentials of [vote.uma.xyz](https://vote.uma.xyz) in your terminal, signing with the
hardware wallet you already have. No hot keys, no browser.

- **Commit & reveal** as batched multicalls, with per-request diffing against your existing
  on-chain commitments (re-commits send only what changed)
- **Interactive commit review**: scroll the round's requests, override answers (P1–P4 or a
  custom price), inspect each request's details, docs and Discord discussion — then confirm
- **Signers**: Frame, Trezor (USB/Bridge), Ledger (USB), GridPlus Lattice (relay),
  WalletConnect — pick with `nub run init`
- **dApp-compatible encryption**: salts and encrypted vote blobs use the exact scheme
  vote.uma.xyz uses, so you can commit here and reveal in the browser (or vice versa),
  from any machine, with nothing but your wallet
- **Live results**: an interactive explorer with per-request quorum/consensus progress and
  full price distribution — navigate rounds with `ctrl+←/→`, auto-refreshing every 60s
  while the reveal phase is live (piped output keeps the plain table)
- **Discussion**: browse each vote's Discord `#evidence-rationale` thread from the CLI
- **Addons**: pluggable answer sources with pre-commit verification gates (see below)

## Setup

Requires [nub](https://nubjs.com) and Node 22+.

```
nub install
nub run init          # pick + test a signing backend, writes .env
nub run verify-key    # one-time: proves dApp encryption compatibility
```

## Voting

UMA rounds are 48h: 24h commit (even UTC days), 24h reveal.

```
nub run status        # phase, round, deadlines, your commitments vs answers
nub run commit        # commit phase: interactive review → diff → confirm → sign
nub run reveal        # reveal phase: chain-first (decrypts your own blobs), sign
nub run results       # quorum/consensus/price explorer (--round N for history)
nub run comments      # per-vote Discord threads (--q <title substring>)
nub run addon         # list/dispatch commands contributed by installed addons
```

On a terminal, `commit` opens a full-screen review before anything is signed: ↑↓ scroll,
`1-4` set the answer (P1–P4, or no/yes for non-multiple-choice identifiers), `v` custom
price, `d` request details, `s` the request's docs (decoded ancillary data), `c` its
Discord thread, `enter` review & confirm, `q` abort. The answer keys work inside every
view, and `ctrl+←/→` (or `[`/`]`) jumps to the previous/next request without going back
to the list; `d`/`s`/`c` switch views directly. Unanswered requests are skipped with
a warning. `--yes` (or piping) keeps the non-interactive table flow.

Flags: `--dry-run` (print multicall calldata instead of sending), `--force` (re-send all /
skip gates), `--yes` (skip confirmation); values as `--flag value` or `--flag=value`.

### Where answers come from

`commit` needs an answer (P1–P4 or a custom price) per request. Precedence:

1. `ANSWERS_FILE=<path>` — a JSON array of `{ancillaryData, timestamp, question, answer}`
2. `answers/<roundId>.json` — same schema, saved locally (e.g. pulled by an addon)
3. `answers/<roundId>.local.json` — your last interactive review, saved automatically on
   confirm; kept separate so a pulled file is never overwritten (and, once pulled, wins)
4. an installed **addon** (below) — asked to resolve, then to pull from upstream
5. none of the above — the interactive review opens with every request unanswered,
   so you can vote from scratch like on the dApp (batch runs abort instead)

### Addons

Drop a directory into the gitignored `addons/` folder with an `index.ts` default-exporting
an `AnswerSourcePlugin` ([src/addons.ts](src/addons.ts)):

```ts
export default {
    name: 'my-source',
    getAnswers(roundId) { ... },            // resolve a round's answers
    pullAnswers?(roundId),                  // fetch from upstream when commit finds nothing local
    verifyBeforeCommit?(roundId, answers),  // gate: block stale/tampered answers
    report?(roundId),                       // provenance / trust warnings
    commands?: { 'sync': { description, run } },  // nub run addon <cmd>
}
```

Addons are plain TypeScript (nub runs them directly) and can be private repos cloned into
`addons/` — the core never needs to know where your answers come from. Set
`ROUNDS_DIR=addons/<name>/rounds` to keep salt backups version-controlled in the addon repo.

## Safety model

- Commit hashes bind `price, salt, voter, time, ancillaryData, roundId, identifier`
  exactly as VotingV2 requires; salts are derived deterministically from a one-time
  wallet signature (the dApp's own scheme), so reveals are recoverable from any machine —
  local round files are a convenience cache, on-chain encrypted blobs are the backup.
- Reveal is chain-first: it decrypts your own `EncryptedVote` blobs (latest per request),
  so mixed CLI/dApp commits and partial re-commits reveal correctly.
- Every send prints resolved gas fees (defaults: tip 0.0001 gwei, max = base + 20%),
  warns when transactions are pending on the account, and asks for explicit confirmation.
- Missed-reveal detection: round files that were committed but never revealed are called
  out as slashed instead of silently ignored.
- Friendly errors: wallet rejections and RPC failures print one line; full dumps go to `logs/`.

The `comments` command reads the voter dApp's Discord-thread cache — the same data shown
on the voting page. Threads are available for the current round only.

## License

MIT
