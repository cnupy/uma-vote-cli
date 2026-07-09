# Quickstart

Zero to voting in ~10 minutes. Everything runs locally; every transaction and the
one login signature are confirmed on your hardware wallet.

## 1. Install

```sh
brew install nubjs/tap/nub                        # macOS
npm install -g --ignore-scripts=false @nubjs/nub  # Windows (no winget package yet) — needs Node 22+
git clone https://github.com/cnupy/uma-vote-cli.git && cd uma-vote-cli
nub install
```

Other install options (installer script, mise, nix): <https://github.com/nubjs/nub>.

## 2. Connect your hardware wallet

```sh
nub run init
```

The wizard lists the connectors, walks through the one you pick, test-connects and
writes `.env`. Say yes to pinning `EXPECTED_VOTER` — it aborts any run where the
wrong account is selected.

| Connector | Signs with | Before you start |
| --- | --- | --- |
| `frame` | Ledger/Trezor/Lattice via [Frame](https://frame.sh) | Install Frame, add the device, select the voting account |
| `trezor` | Trezor over USB/Bridge | Close Trezor Suite |
| `ledger` | Ledger over USB | Ethereum app open, blind signing enabled, Ledger Live closed |
| `lattice` | GridPlus Lattice1 via relay | Device ID (Settings → Device Info); relay URL if self-hosting; approve the pairing code once |
| `walletconnect` | MetaMask/Rabby/mobile wallet | Free project ID from <https://cloud.reown.com>; scan the QR once |

Locked device or wrong app open? The tool prompts, you fix it on the device and
press Enter — no restart needed.

## 3. One-time checks

```sh
nub run verify-key   # sign "Login to UMA Voter dApp" once on the device
```

This derives the same vote-encryption key the [official dApp](https://vote.uma.xyz)
uses and proves it by decrypting your past on-chain vote blobs. Green means:
commits made here are revealable in the dApp and vice versa. The key lands in
`.signing-key.json` — keep it private, it decrypts your votes.


## 4. Vote — the 48h rhythm

Rounds are 48h: **commit** during even UTC days, **reveal** during the next 24h.

```sh
nub run status         # always start here — tells you what to do next
nub run commit         # commit day: review + adjust answers → encrypt → one multicall → confirm on device
nub run reveal         # reveal day: one multicall → confirm on device
nub run results        # watch quorum/consensus and how your votes line up
```

`commit` gets its answers from an installed addon, `ANSWERS_FILE=<path>` or a saved
`answers/<roundId>.json` — and with none of those, its interactive review lets you
answer every request yourself (see the README).

**Never skip a reveal** — committed-but-unrevealed votes are slashed. `status`
warns while the window is open; put it on a calendar anyway.

Committing twice is safe and cheap: re-runs send only changed/uncommitted votes.
Salts are deterministic and every commit carries a dApp-compatible encrypted
blob on-chain, so reveals work from any machine with the same wallet — this
tool and vote.uma.xyz are interchangeable mid-round.

## 5. Useful knobs

- `--dry-run` — print the multicall calldata instead of sending
- `--force` — re-send everything / retry a reveal
- `--yes` — skip the commit confirmation
- `--max-fee=<gwei>` / `--tip=<gwei>` — fee overrides (defaults: base + 20% + tip)
- `.env` reference: [.env.example](.env.example) — RPC fallback list, answers sources, signer settings

Keep `.signing-key.json`, `.lattice-client.json` and `.walletconnect.db` private;
all three are gitignored.
