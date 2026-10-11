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
source report (when an addon supplied one; the list pins at most 4 of its warning
lines and says how many more `p` holds), `C` review & commit, `q` quit (with a
warning first when answered votes haven't been committed — your answers are saved
either way and prefill the next review). The list shows the highlighted vote's
suggestions with their sources and confidence; a vote the sources disagree on is marked
⚠ with both answers, a source that moved since you decided is marked ⟳ with the new
value, a suggestion that changed since you last looked is marked ⟳ too, and a source
that failed or had nothing is one ⚠ line in the banner; `d` shows the same per vote,
and says whether the planned answer is yours or a suggestion you have not confirmed.
Confirming means pressing `y` on the "Commit N vote(s)?" modal (`C`, then `y`), in
`nub run commit` and in the `uma` app alike; that is the only act that makes a
prefilled suggestion your answer; the status a row shows ("yours" or "suggested, not
yet yours", a flagged move) follows your edits as you type. For `MULTIPLE_VALUES`
requests `v` takes exactly one value per label, in label order ("73, 75" for a
two-label request; the labels are read from the request text as the dApp reads them),
and refuses a single number for a request with several labels ("73" would pack as
[73, 0]; a packed integer is accepted only from a source file, never typed). The list
shows every slot the packed price holds, zeros included; when the request
text does not resolve the label count is unknown and custom values are refused rather
than packed on a guess (`4`, "too early", still works). A custom price with more
decimals than the identifier's precision (18, or the dApp's table) is refused with the
count, where a rounded price would otherwise be signed. The answer keys work inside every view, and
plain `←/→` moves to the previous/next question without going back to the list; long
text in the summary/AI/comments views scrolls with `↑/↓` (in comments `pgup`/`pgdn`
steps through the thread; the view also links to the vote's thread on Discord as the
dApp does, or to the discussion channel when no thread is known, and says so when
Discord returned the thread without its message text, as it has since 2026-10);
`d`/`s`/`a`/`c` switch views directly. `[`/`]` (or
`ctrl+←/→`) is previous/next round inside the `uma` app's votes page — inert in
standalone `nub run commit`. Unanswered requests are skipped with a warning. `--yes`
(or piping) keeps the non-interactive table flow.

Flags: `--dry-run` (print multicall calldata instead of sending), `--force` (skip the
verification and diff aborts, and re-send the votes whose on-chain commitment already
matches instead of skipping them; it does not replace a commitment that differs, see
below), `--yes` (skip confirmation), `--reconnect` (WalletConnect: discard the stored
session and pair afresh — use when the wallet dropped the session and no QR appears);
values as `--flag value` or `--flag=value`.

### Where answers come from

`commit` needs an answer (P1–P4 or a custom price) per request.

- `ANSWERS_FILE=<path>` — a JSON array of `{ancillaryData, timestamp, question, answer}`.
  An explicit instruction: when set it is the only source, nothing is merged with it
  (no addon is asked and your saved review is not read), and every addon gate still
  checks it.
- Otherwise **every installed addon** (below) is asked, every run, and the answers are
  merged **per vote**: one source answering, or several agreeing, gives the planned
  answer; two sources with different answers is a disagreement, shown with both and
  left blank for you to decide. A source can also report a conflict on a vote (its own
  reading found it contested, with a short reason): that vote is left blank for you
  the same way, flagged ⚠ with the reason, whatever another source says. A source that
  gives the request's timestamp and one that omits it are joined the same way. An
  empty answer ("no opinion"), a source that passes on the round or a failing one
  never counts as a disagreement: it costs one visible line (a pass is worded as a
  pass, a failure as a failure) and the other sources carry on; a malformed answer
  entry costs one line too and the rest of that source is used. Each suggestion shows its source and the confidence that
  source measured for it, in that source's own words (a figure and what it rests on);
  a source that measured nothing shows "not rated". The host invents no figures.
- `answers/<roundId>.json` — same schema as ANSWERS_FILE. An addon that pulls from
  upstream caches there and serves it (the file is that addon's and its gate checks
  it); without such an addon the host reads it as a plain, unrated source.
- `answers/<roundId>.local.json` — your review, saved automatically on confirm or quit
  and laid over the merge every time. Each row records whether it is yours
  (`decided`): a row you set yourself, and every answered row of a review you
  confirmed. Your answer always wins: when a source moves after you decided, the row
  is flagged with the new value and never replaced, even if the source first agreed
  with you and then moved on. A prefilled suggestion you quit without confirming is
  saved as a suggestion: the next review prefills it (flagged if it changed meanwhile),
  and a batch run never signs it. A source that returns nothing keeps what you saved,
  so refreshing (`r`, `--refetch`) can never blank a review.
- no source answers anything — the interactive review opens from your saved review
  (its answers and the titles it kept), or with every request unanswered, so you can
  vote from scratch like on the dApp. Batch
  runs (`--yes`, piped, `--dry-run`) sign only your decided answers and what the sources
  agree on now; they abort with nothing to commit, and on any disagreement or reported
  conflict you have not decided: nobody is there to pick a side. A row you cleared is
  decided: nothing is signed for it and it does not block. A commitment already on
  chain (made here, in the dApp, or under an earlier build) is a choice you made: a
  batch run never replaces it, whether this run would send what the sources say now
  or an answer you decided earlier (you may have recommitted in the dApp since, and
  the run cannot tell which you meant); it leaves it as committed, prints the
  difference, and the interactive review, which shows both, is where you pick one.
  For the same reason an undecided disagreement on a vote you already committed does
  not abort the batch run: nothing would be sent for it, so it is listed under "left
  as committed" and the rest goes on. `--force` changes none of this: with the diff
  available it only re-sends the commitments that already match. The one exception is
  when your on-chain commitments could not be fetched (an RPC failure): the run aborts,
  and with `--force` it sends every matched vote without a diff, which does replace
  whatever is committed. An undecided disagreement still aborts in that case, since
  the run cannot see what is committed.

### Addons

Drop a directory into the gitignored `addons/` folder with an `index.ts` default-exporting
an `AnswerSourcePlugin` ([src/addons.ts](src/addons.ts)):

```ts
export default {
    name: 'my-source',
    getAnswers(roundId, ctx) { ... },       // this source's answers; '' = no opinion on that vote; ctx.review: a human will see them
    pullAnswers?(roundId),                  // fetch from upstream when getAnswers has nothing, and on refresh
    verifyBeforeCommit?(roundId, answers),  // gate over the answers THIS addon supplied
    report?(roundId),                       // provenance / trust warnings
    commands?: { 'sync': { description, run } },  // nub run addon <cmd>
}
```

Each answer may carry `confidence`, a string with a measured figure and what it rests
on; the review shows it next to the suggestion and shows "not rated" when it is absent.
An answer may carry `conflict`, a short reason this source found the vote contested;
the host then treats the vote like a disagreement (blank for the owner, flagged with
the reason, a batch run aborts unless the owner decided it), even with `answer: ''`,
which on its own would be "no opinion". Non-string fields are dropped at ingestion
with one line naming the addon; the rest of its answers are used. The exception is a
`conflict` that is present but not a string (`true`, a number): it is kept as a
conflict with the reason "malformed conflict field", since dropping it would let
another source fill a vote the addon meant to hold back.
`ctx.review` is true only when the interactive commit review will show the answers
before anything is signed, false for batch commits and for the read-only commands
(`status`, `questions`, `results` ask for titles): an addon whose answers are
suggestions for a human can return nothing otherwise. Addons written before either
existed keep working unchanged. A `getAnswers` or `pullAnswers` call that has not
settled after 60 s is given up: it costs the same one line a throw costs ("answers
timed out") and the other addons carry on, so a hung upstream cannot hold the review
shut; the host's own dApp requests give up after 15 s each. Addons are plain
TypeScript (nub runs them directly) and can be private repos cloned into `addons/` — the
core never needs to know where your answers come from. Set
`ROUNDS_DIR=addons/<name>/rounds` to keep salt backups version-controlled in the addon repo.
An addon that measures its own record against on-chain outcomes can read them through
`src/resolutions.ts`, a cached scan of `RequestResolved` events (chain facts only; what
counts as right is the addon's business). Installing an addon means running its code
inside the CLI process with access to everything the CLI can read (`.signing-key.json`,
`.env`, the pairing store), and `verifyBeforeCommit` is attested by the addon itself —
only install addons you trust or have audited.

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
