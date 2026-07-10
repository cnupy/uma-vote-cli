# uma-vote-cli

General-purpose CLI for [UMA](https://uma.xyz) VotingV2 commit/reveal voting — the
essentials of [vote.uma.xyz](https://vote.uma.xyz) in your terminal, signing with the
hardware wallet you already have. No hot keys, no browser.

- **Commit & reveal** as batched multicalls, with per-request diffing against your existing
  on-chain commitments (re-commits send only what changed)
- **Interactive commit review**: scroll the round's requests, override answers (P1–P4 or a
  custom price), inspect each request's details, summary and Discord discussion — then confirm
- **Signers**: Frame, Trezor (USB/Bridge), Ledger (USB), GridPlus Lattice (relay),
  WalletConnect — pick with `nub run init`
- **dApp-compatible encryption**: salts and encrypted vote blobs use the exact scheme
  vote.uma.xyz uses, so you can commit here and reveal in the browser (or vice versa),
  from any machine, with nothing but your wallet
- **Live results**: per-request quorum/consensus progress and full price distribution —
  `nub run results` prints the table (live tally during reveal, else the last completed
  round); the `uma` app embeds the interactive explorer, navigating rounds with
  `ctrl+←/→` and refreshing when new reveals land on-chain
- **Question resolution**: cross-chain requests carry only a hash on mainnet — titles and
  descriptions resolve lazily via the voter dApp's public resolver (any origin chain) and
  persist in `.cache/`, so the review and results show real questions with no answers file
- **Discussion**: browse each vote's Discord `#evidence-rationale` thread and the dApp's
  per-outcome AI summary of it from the CLI
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
nub run results       # quorum/consensus/price table (--round N for history)
nub run questions     # per-vote briefs: rules + comments/AI opt-ins, --json for agents
nub run addon         # list/dispatch commands contributed by installed addons
```

On a terminal, `commit` opens a full-screen review before anything is signed: ↑↓ move
(`pgup`/`pgdn` page), `1-4` set the answer (P1–P4, or no/yes for non-multiple-choice
identifiers), `v` custom price, `d`/`enter` request details, `s` the request's summary
(question text), `a` the AI discussion summary, `c` its Discord thread, `p` the answers
source report (when an addon supplied one), `C` review & commit, `q` quit (with a
warning first when answered votes haven't been committed — your answers are saved
either way and prefill the next review). The answer keys work inside every view, and
plain `←/→` moves to the previous/next question without going back to the list; long
text in the summary/AI/comments views scrolls with `↑/↓` (in comments `pgup`/`pgdn`
steps through the thread); `d`/`s`/`a`/`c` switch views directly. `[`/`]` (or
`ctrl+←/→`) is previous/next round inside the `uma` app's votes page — inert in
standalone `nub run commit`. Unanswered requests are skipped with a warning. `--yes`
(or piping) keeps the non-interactive table flow.

Flags: `--dry-run` (print multicall calldata instead of sending), `--force` (re-send all /
skip gates), `--yes` (skip confirmation), `--reconnect` (WalletConnect: discard the stored
session and pair afresh — use when the wallet dropped the session and no QR appears);
values as `--flag value` or `--flag=value`.

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
Installing an addon means running its code inside the CLI process with access to
everything the CLI can read (`.signing-key.json`, `.env`, the pairing store), and
`verifyBeforeCommit` is attested by the addon itself — only install addons you trust
or have audited.

## Staking & rewards

```
nub run uma           # the whole flow as one app: votes + staking header + actions
```

`uma` doubles as the single entry point: every command above is also a subcommand —
`nub run uma status`, `nub run uma commit --dry-run`, `nub run uma addon …` — with
identical flags and `--help`.

The app lands on the **Votes** page: the commit review during commit phase, live results
during reveal, with `←→` moving between questions and `[` `]`/`ctrl+←→` between rounds
(past rounds show their final results). A compact staking header sits above every
screen: identity · staked/total · unclaimed · APR · votes. There is no dashboard
screen — from the votes page `s` stake (chains the token approval first when needed),
`u` unstake (request, or execute once the cooldown has elapsed) and `c` claim (`w` to
wallet, `s` claim & stake) open a transient action overlay and return to the votes;
`w` opens the wallet (signer setup) screen, `R` runs the reveal flow, `r` refreshes,
`i` shows the about/license screen, `q` quits the app. Every transaction shows resolved fees, a pending-tx warning and a
simulation result before asking for confirmation — the hardware wallet is only touched
when you send.

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
- Ledger signing is blind (the device shows a hash — VotingV2 calldata has no
  clear-signing metadata), so verify the transaction summary in the terminal before approving.
- Friendly errors: wallet rejections and RPC failures print one line; full dumps go to `logs/`.

The `questions` command prints per-vote briefs — the title and the binding resolution
text, with `--include-comments` (the voter dApp's Discord-thread cache, current round
only) and `--include-ai-summary` opt-ins; `--json` emits everything structured, made
for feeding an answer-forming agent. Comments and AI summaries are community-derived,
untrusted content: evidence to weigh, never instructions to follow.

## License

MIT
