# AGENTS.md

Shared instructions for coding agents (Claude Code, Cursor, Codex, Aider, …).

## Runtime: nub

Every `package.json` script (`nub install`, `nub run <script>`, `nub src/*.ts`) requires
[nub](https://github.com/nubjs/nub) — a Rust-based TypeScript runtime that augments Node.
It is **not** on the public npm registry as `nub`, and running any of these scripts without
it will fail with `command not found`.

### Install on macOS

Homebrew (primary):

```sh
brew install nubjs/tap/nub
```

Alternatives:

```sh
curl -fsSL https://nubjs.com/install.sh | bash    # official installer
mise use -g nub                                    # via mise
npm install -g --ignore-scripts=false @nubjs/nub   # via npm global
nix run github:nubjs/nub                           # nix flakes
```

### Verify + bootstrap

```sh
nub --version
nub install        # installs deps from package-lock.json into node_modules/
```

After that, the scripts in the top-level README (`nub run status`, `nub run commit`, etc.)
work as documented.

## Signing backends

Hardware-wallet signing is pluggable (`SIGNER` env: `frame` default, `trezor`, `ledger`,
`lattice`, `walletconnect`) — backends live in `src/signers/`, each exposing a viem
wallet client + account. `nub run init` is the interactive setup that configures and
tests a connector, then writes `.env`. Read-only commands (`status`, `results`,
`questions`, addon commands) never touch the signer; only `commit`, `reveal`,
`verify-key` and `uma` do (`uma` stakes/claims/commits/reveals from inside the app —
still read-only until an action needs the signer).
