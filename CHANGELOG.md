# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version is `0.0.0`. The package is unpublished until a human publishes it.

## [Unreleased]

### Added

- Opt-in `@qntx/nostr/wasm`: `await loadNostrWasm()` then `Client.builder().verifyEvent(wasm.verifyEvent)`. Noble remains default. No auto-detect. Instantiate failure throws. Verify only. Live EVENT verify is sync after init. A `Worker` is not a drop-in (`alreadyHaveEvent` / watermarks). v1 requires WASM SIMD (`simd128`). CSP: `'wasm-unsafe-eval'` on `script-src` (WASM compile, not JS `eval()`). `build` stays `vp pack`. `build:wasm` needs wasm-capable clang (macOS: Homebrew llvm, not Apple clang). Sibling CI `wasm` job.
- `Client` / `ClientBuilder` forward `verifyEvent`, `enablePing`, `pingIntervalMs`, and `pingTimeoutMs` to `Pool`. `verifyEvent` is `(event: Event) => boolean` and is called synchronously on EVENT. Ping stays off by default.
- `Client.subscribe` and `subscribePrivateMessages` accept `eoseTimeoutMs` (no default). The timer fires `oneose` once; it does not close the subscription.
- `Pool.connectedUrls()` returns URLs whose relay is currently connected.
- Blossom: `blobExists` (HEAD only; 2xx true, 404 false, other HTTP including 405 throws), `getBlob` (GET then sha256 verify), `healBlobUrl` (NIP-B7 SHOULD; uses the caller-supplied kind 10063 list for that author), `uploadToServers`.
- `mergeCountHll`: register-wise max of NIP-45 HyperLogLog sketches. Empty input is 512 zero hex. Output is always lowercase 512 hex. No cardinality estimator. `Pool.count` does not auto-merge.
- `Client.sync` / `Client.syncToRelay` (NIP-77) against `EventStore.negentropyItems`.
- `EventStore.count` and `EventStore.negentropyItems`.
- `IndexedDbEventStore` schema v2: compound indexes, prefix-range cursors, persisted NIP-09 tombstones.
- Relay reconnect watermark: REQ uses inclusive `since=lastCreatedAt` plus `ids` at that timestamp. A generation token drops frames from a previous socket.
- Remaining NIP-57 receipt checks in `validateZapReceipt` (tag copy, request `P`/`a`, bolt11/description/preimage). Never throws. No LNURL HTTP.

### Changed

- `IndexedDbEventStore.setOutboxBound` serializes through the write queue so it cannot overlap `putMany` or `clear`.
- Pool/Client `oneose` waits for the slowest relay unless `eoseTimeoutMs` is set. Each URL contributes at most once; reconnect EOSE does not complete the set. Caller `close()` does not fire `oneose`. An empty relay list still calls `onclose("no relays")` and not `oneose`.
- `eoseTimeoutMs` no longer closes the live REQ. Timeout synthesizes `oneose` once; a later real EOSE is ignored. Direct `Relay.subscribe` may `oneose` again after reconnect. `Relay.fetch` remains the one-shot closer.
- `Client.sync` mixed-success no longer fail-fast. Per-relay sessions run in parallel (`Promise.allSettled`). Fulfilled summaries merge. Throw only when `urls.length > 0` and every relay rejects (first rejection in URL order).
- Gossip `publish` includes up to five normalized `e`/`a` tag relay hints (index 2).
- `groupAuthorsByOutboxRelay` / `OutboxFeed` prefer already-connected URLs that are already candidates. A connected URL that is not in the author's outbox or discovery list is not added.
- `OutboxFeed` rehydrates newest bounds from `storage.query({ limit: 1 })`. Mixed bounded/unbounded author groups split filters. Bounds stay process-local.
- `Kind` catalog is 28 production names.
- NIP-10: unknown `e` markers (including `mention`) go to `mentions` only, not positional root/reply.
- `EventBuilder.repost` / `genericRepost` require a `relayHint` URL (NIP-18).
- `EventBuilder.reaction` emits `a` only when the target is addressable (NIP-25).
- NIP-59 seals have empty tags.
- NIP-46 `connect` accepts `bunker://` or a pointer only. A NIP-05 identifier is not a bunker pointer.
- `itemCompare` lives in `core`. NIP-77 does not re-export it.
- `Filter.search` (NIP-50) is relay-side. Local `matchFilter` / `EventStore.query` ignore it.
- `CountResult.hll` is a 512-char hex sketch, not opaque base64.

### Removed

- Dual-key DM kinds 10044 / 4454 / 4455.
- NIP-59 `encryptTo`.
- NIP-46 NIP-05 identifier login.

[Unreleased]: https://github.com/qntx/nostr.js/commits/HEAD
