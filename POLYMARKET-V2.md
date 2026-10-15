# Polymarket V2 migration checklist

Polymarket is moving new markets to its V2 contracts, which use a new ancillary data format. V2 test markets already create real Optimistic Oracle requests, and some have reached DVM votes. The first one found is a Central Park request at time 1790096754 (2026-09-22 UTC, round 10359).

Net new production markets switch over in November. The dates conflict. UMA's announcement says November 2. The migration docs say canary markets run "until October 30th, with a tentative switchover of net new markets on November 11th".

Research done 2026-10-15. Sources are listed at the end.

## What does not change

- Voting itself. Nothing in the migration touches VotingV2, commit/reveal or rounds. voter-dapp-v2 shows V2 requests "without changing the original bytes used for commit/reveal".
- The L1 ancillary data. It stays hash-only (`ancillaryDataHash:…,childBlockNumber:…,childOracle:…,childRequester:…,childChainId:137`), so `titleFromAncillary` and `decodeIdentifier` need no change.
- Getting the full text. `/api/resolve-l2-ancillary-data` works for V2 as before, so `resolveAncillaryText` needs no change.
- The Proposer API. It replaces on-chain proposing. This tool only votes.

## How to spot a V2 request

The resolved text is a JSON object followed by a stamp:

```
{"title":"…","description":"…","market_id":"4805182","res_data":"p1: 0, p2: 1, p3: 0.5. …","product_spec":"","version":"1"},ooRequester:53703dd6129d723066b6362510e5ae2fecd48218,childRequester:2c0367a9db231ddebd88a94b4f6461a6e47c58b1,childChainId:137
```

voter-dapp-v2 (`lib/polymarket-v2.ts`, `parsePolymarketV2AncillaryData`) splits at the last `}`. It then requires the stamp `^,ooRequester:<reporter>,childRequester:<MOOV2>,childChainId:137$` and parses the JSON. A MOOV2 childRequester alone does not make a request V2, because older MOOV2 markets carry it too. Do the same here.

The docs and the live data disagree on the JSON shape, so accept both. The spec lists `type` (1 binary, 2 atomic neg-risk), `title`, `description`, `market_id`, `res_data` as an array of `{"value","outcome"}`, `product_spec` and `integration`. The live request has `res_data` as a string, no `type`, and a `version` field.

## Changes needed

- [x] **`src/common.ts` `titleFromText`.** It looks for `title:` and never matches `"title":"…"`. A V2 vote then gets a placeholder title, and the Discord thread lookup and AI summary both miss. Parse V2 first (JSON plus stamp check) and return its `title`. Then strip U+202F, which is all the dApp's `stripInvalidCharacters` removes, so the title matches the dApp's thread key.
- [ ] **`src/resolve.ts` `descriptionFromText`.** It looks for `description:` and returns nothing for V2. Build the description as the dApp does: `description`, then `res_data` (string or array), then `product_spec`, separated by blank lines.
- [ ] **`src/common.ts` `encodePrice` for `NUMERICAL`.** Atomic neg-risk markets use the identifier `NUMERICAL`. The answer is the winning outcome's index times 1e18, and the index must be lower than the number of outcomes. A plain number already encodes that way (`"2"` gives 2e18). Two things are open. First, "too early" has no way in: `p4` returns nothing, and a typed min-int256 gets scaled. Second, it is not confirmed that `NUMERICAL` is approved for DVM votes. Decide both once a `NUMERICAL` vote shows up.
- [ ] **Binary P3.** For V2 markets P3 (0.5) is valid only for the binary market type. Do not offer P3 on an atomic neg-risk vote.
- [ ] **Optional, V2 rule updates.** Clarifications for V2 markets live on MOOV2 on Polygon (`getRequestRulesUpdates`). Each update replaces the market rules in full. The dApp serves them at `POST /api/polymarket-v2-rule-updates` with body `{"identifier": "YES_OR_NO_QUERY" | "NUMERICAL", "ancillaryData": "<resolved hex, stamp included>"}`. It answers `{"bulletins": [{"timestamp": number, "update": string}]}`, or 400 when the request is not V2 and 503 on an RPC failure. Showing these in the details view would help.

## Unchanged, but check after the fix

- `src/discord.ts` (`dappTitle`, `fetchDiscussion`). The route takes the same `time`, `identifier`, `title`. It is right once the title is right.
- `src/resolve.ts` `fetchAiSummary`. Same, it depends on the title.
- `/api/fetch-summary` has not changed since October 2025, and `/api/resolve-l2-ancillary-data` has had no V2 change.

## Still unknown

- Whether the Discord Herald bot names V2 threads with the JSON `title`. Its code is not public.
- What "too early" looks like on a `NUMERICAL` vote.
- Whether `NUMERICAL` is on the DVM's approved identifier list.

## Contract addresses (Polygon, chain 137)

| Contract | Address |
|---|---|
| PolymarketOOReporter (V2 `ooRequester`) | `0x53703dd6129d723066b6362510e5ae2fecd48218` |
| MOOV2 (`childRequester`) | `0x2C0367a9DB231dDeBd88a94b4f6461a6e47C58B1` |
| OOReporterModule (proxy) | `0x000012e0009c84078c4924fba808A41b9f67527f` |
| OracleAggregator | `0x0A0a0A0A8B00C51b7D810501b03F230028C04a87` |

The reporter address comes from voter-dapp-v2 (`lib/polymarket-v2.ts`). The UMA docs do not list it.

## Sources

- UMA, Polymarket V2 migration overview: https://docs.uma.xyz/polymarket-v2-migration/overview
- UMA, ancillary data JSON specification: https://docs.uma.xyz/polymarket-v2-migration/ancillary-data-json-specification
- UMA, smart contract overview: https://docs.uma.xyz/polymarket-v2-migration/smart-contract-overview
- Risk Labs Proposer API: https://docs.risklabs.co/docs
- UMAprotocol/voter-dapp-v2: `lib/polymarket-v2.ts`, `helpers/voting/getVoteMetaData.ts`, `lib/discord-utils.ts`, `pages/api/polymarket-v2-rule-updates.ts` (PR #488), `pages/api/discord-thread/index.ts` (PR #489), `docs/polymarket-v2.md`, `tests/helpers/voting/projects/polymarket-v2-fixture.json`
- Polymarket/polymarket-v2-external: `src/oracle/libraries/OptimisticOraclePayoutLib.sol`, `OOReporterModule.sol`
