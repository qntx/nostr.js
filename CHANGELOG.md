# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version is `0.1.0`. `0.0.1` was the local `npm publish`. Tag `v0.1.0` runs `publish.yml`: Ubuntu `build:wasm`, then `npm publish --provenance`. `pack:local` stays JS-only.

## [Unreleased]

### Added

- `@qntx/nostr/store`: `ReactiveEventStore`, a synchronous in-memory event store with `useSyncExternalStore`-style watches (`watchEvent`, `watchReplaceable`, `watchQuery`), per-relay `seenOn` tracking, insertion listeners, and LRU eviction that never drops subscribed-watch snapshots or the latest replaceable/addressable events. `Client` owns one by default (`client.index`, `ClientBuilder.index`) and writes every inbound and published event into it before invoking caller callbacks.
- `@qntx/nostr/testing`: transport-agnostic fake relay shared by an in-process `createFakeRelayNetwork` (`websocketImplementation` for `Client`/`Pool`/`Relay`) and `serveFakeRelay` (real `ws` server, dynamic `import("ws")`, ephemeral `port: 0`). NIP-01 EVENT/REQ/CLOSE/EOSE/OK/NOTICE/CLOSED with library `verifyEvent` and `MemoryEventStore`/`decidePut` storage semantics, NIP-42 AUTH gating (per-kind reads, writes), NIP-45 COUNT, NIP-50 `search`, NIP-77 `NEG-*`. Faults: `latencyMs`, `rateLimited`, `eoseBeforeEvents`, `inject`, `disconnect`, `closeSubscriptions`. Also `eventStoreConformanceCases` (framework-agnostic `EventStore` suite) and `createFakeNip46Signer` (in-process NIP-46 remote signer).
- Source relay URL on subscription callbacks: `fanIn`/`Pool.subscribe`/`Client.subscribe` `onevent(event, relayUrl)` fires on first receipt (deduped across relays) and `receivedEvent(id, relayUrl)` fires for every receipt from every relay, including duplicates skipped by dedupe or `alreadyHaveEvent`. `fetchRouted`/`Pool.fetch`/`fetchGossip`/`Client.fetchEvents` accept `onevent(event, relayUrl)` fired for every event of every relay batch, including cross-relay duplicates. `relayUrl` is the `normalizeURL` result. `ReceivedPrivateMessage.relayUrl` is populated by `fetchPrivateMessages`/`subscribePrivateMessages`.
- NIP-51 private tags: `encryptPrivateTags` / `decryptPrivateTags` / `parseMuteListPrivate` via NIP-44 to the author's own pubkey. No NIP-04 sniff. `muteListEventBuilder` and loaders stay public-only.
- `filterFingerprint(filters)`: canonical identity for live REQ coalescing. Object keys sorted; list fields copied and sorted; hex `ids`/`authors`/`#e`/`#p` lowercased; `#t` case preserved. `since`/`until`/`limit`/`search` included. A missing key is not an empty array. Filter arrays are ordered by each filter’s canonical JSON.
- `SubscribeOptions.closeOnEose` (default false). `Relay.fetch` passes true so a one-shot query does not join a live group and CLOSES on EOSE.
- Opt-in `@qntx/nostr/wasm`: `await loadNostrWasm()` then `Client.builder().verifyEvent(wasm.verifyEvent)`. Noble remains default. No auto-detect. Instantiate failure throws. Verify only. Live EVENT verify is sync after init. A `Worker` is not a drop-in (`alreadyHaveEvent` / watermarks). v1 requires WASM SIMD (`simd128`). CSP: `'wasm-unsafe-eval'` on `script-src` (WASM compile, not JS `eval()`). `build` stays `vp pack`. `build:wasm` needs wasm-capable clang (macOS: Homebrew llvm, not Apple clang). Sibling CI `wasm` job.
- `Client` / `ClientBuilder` forward `verifyEvent`, `enablePing`, `pingIntervalMs`, and `pingTimeoutMs` to `Pool`. `verifyEvent` is `(event: Event) => boolean` and is called synchronously on EVENT. Ping stays off by default.
- `Client.subscribe` and `subscribePrivateMessages` accept `eoseTimeoutMs` (no default). The timer fires `oneose` once; it does not close the subscription.
- `NoSignerError` (`NostrError` subclass): thrown by a lazy AUTH sign function when no signer is configured at challenge time. `Relay` catches it and ignores the challenge — no AUTH frame, connection stays open.
- `PoolOptions.maxRelays`: soft cap on connected non-pinned relays. At the cap, `ensureRelay` first closes the least-recently-used idle relay (no subscriptions, no in-flight requests); with none idle it still connects.
- `PoolOptions.pinnedUrls` + `Pool.setPinnedUrls`: relays never closed by idle cleanup or `maxRelays` eviction.
- `Relay.inFlightCount`: one-shot requests still awaiting a reply (publish ACK, COUNT, NEG); idle detection uses it alongside `subscriptionCount`.
- `ClientOptions` / `ClientBuilder` forward `allowInsecure`, `trustedInsecureUrls`, `idleTimeoutMs`, `maxRelays`, and `pinnedUrls` to the pool. `Client.setSigner` accepts `undefined` to remove the signer.
- `Pool.connectedUrls()` returns URLs whose relay is currently connected.
- `Relay.resetAuth` / `Pool.resetAuth`: clear a cached AUTH rejection for the pending challenge and re-fire `onauth` so automatic auth can retry; `Client.setSigner` calls it so a new signer applies to already-connected relays. `OutboxFeedOptions.observe` now receives the relay URL and `OutboxFeedOptions.seen` fires for every event receipt from every relay (#125).
- Blossom: `blobExists` (HEAD only; 2xx true, 404 false, other HTTP including 405 throws), `getBlob` (GET then sha256 verify), `healBlobUrl` (NIP-B7 SHOULD; uses the caller-supplied kind 10063 list for that author), `uploadToServers`.
- `mergeCountHll`: register-wise max of NIP-45 HyperLogLog sketches. Empty input is 512 zero hex. Output is always lowercase 512 hex. No cardinality estimator. `Pool.count` does not auto-merge.
- `Client.sync` / `Client.syncToRelay` (NIP-77) against `EventStore.negentropyItems`.
- `EventStore.count` and `EventStore.negentropyItems`.
- `IndexedDbEventStore` schema v4: compound indexes, prefix-range cursors, persisted NIP-09 tombstones, `outbox_bounds` store.
- Relay reconnect watermark: REQ uses inclusive `since=lastCreatedAt` plus `ids` at that timestamp. A generation token drops frames from a previous socket.
- Remaining NIP-57 receipt checks in `validateZapReceipt` (tag copy, request `P`/`a`, bolt11/description/preimage). Never throws. No LNURL HTTP.
- NIP-42 `auth-required:` retries COUNT after AUTH (timeout paused during AUTH; a second CLOSED does not retry). EVENT OK `auth-required:` AUTH then republishes.
- `MemoryEventStore` `#byKindPubkey` (kinds+authors) and `#e`/`#p` indexes.
- First-connect reconnect: with `enableReconnect`, a failed or timed-out initial connect keeps live subscriptions and REQs them on the next socket.
- Wasm verify poison: `WebAssembly.RuntimeError` poisons as `WasmVerifyPoisonedError`. `Relay` drops subsequent EVENTs and notices once. No noble fallback.

### Changed

- `MemoryEventStore` internals: indexing, querying, tombstones, and outbox bounds moved into the synchronous `MemoryIndex` (`src/storage/memory-index.ts`). `MemoryEventStore` is now a thin async facade with unchanged `EventStore` semantics.
- `IndexedDbEventStore.setOutboxBound` serializes through the write queue so it cannot overlap `putMany` or `clear`.
- User-facing library throws use `NostrError` subclasses: `Nip19Error` (event loader nsec/npub), `OutboxError` (closed feed), `LoaderError` (DataLoader batch length), `RelayPublishError` (`Pool.publishAny` rejected OK), `RelayClosedError` (async-iterator close reason), `CryptoError` (wasm HTTP fetch), `StorageError` (IndexedDB `req.error` fallbacks). `WasmVerifyPoisonedError` extends `NostrError` and keeps `name = "WasmVerifyPoisonedError"` for relay duck-typing.
- `subscribePrivateMessages` live REQ includes kind 21059 in addition to 1059. `fetchPrivateMessages` still REQs 1059 only. Kind 21059 wraps are not stored.
- `KeysSigner` caches NIP-44 conversation keys per peer pubkey. Gift-wrap `encryptToPubkey` still derives per call.
- `Relay.subscribe` coalesces identical live REQs (`filterFingerprint`). First subscribe sends REQ; later identical live attaches reuse the wire id. `close()` decrements; the last close sends CLOSE. Verify and watermark run once per EVENT, then fan out (`alreadyHaveEvent` skips that listener only). Late attach after EOSE fires that listener’s `oneose` on a microtask. Pool/Client inherit. Non-identical filters (including different `limit` or subset `authors`) are not merged.
- Pool/Client `oneose` waits for the slowest relay unless `eoseTimeoutMs` is set. Each URL contributes at most once; reconnect EOSE does not complete the set. Caller `close()` does not fire `oneose`. An empty relay list still calls `onclose("no relays")` and not `oneose`.
- `eoseTimeoutMs` no longer closes the live REQ. Timeout synthesizes `oneose` once; a later real EOSE is ignored. Direct `Relay.subscribe` may `oneose` again after reconnect. `Relay.fetch` remains the one-shot closer.
- `Client.sync` mixed-success no longer fail-fast. Per-relay sessions run in parallel (`Promise.allSettled`). Fulfilled summaries merge. Throw only when `urls.length > 0` and every relay rejects (first rejection in URL order).
- NIP-77 upload: one `storage.query([{ ids: have }])` (skipped when `have` is empty), then publish in chunks of 8. Ids missing from the store go to `sendFailures`. `sent` order is not stable.
- Gossip `publish` includes up to five normalized `e`/`a` tag relay hints (index 2).
- `groupAuthorsByOutboxRelay` / `OutboxFeed` prefer already-connected URLs that are already candidates. A connected URL that is not in the author's outbox or discovery list is not added.
- `OutboxFeed` rehydrates via `EventStore.getOutboxBound` / persists via `setOutboxBound`. Mixed bounded/unbounded author groups split filters.
- `Kind` catalog is 28 production names.
- NIP-10: unknown `e` markers (including `mention`) go to `mentions` only, not positional root/reply.
- `EventBuilder.repost` / `genericRepost` require a `relayHint` URL (NIP-18).
- `EventBuilder.reaction` emits `a` only when the target is addressable (NIP-25).
- **BREAKING**: Event `id`/`pubkey`/`sig` must be canonical lowercase hex. `isHex32`/`isHex64` are strict lowercase predicates; `validateEvent`/`validateSignedEvent` reject uppercase fields, `serializeEvent`/`verifyEvent` no longer lowercase them, and wire parsing (`parseRelayMessage`/`parseClientMessage`) rejects non-canonical events. Caller input stays case-insensitive via `assertHex32` and lowercased lookups (#128).
- **BREAKING**: `PutResult` gains `"invalid"`: `EventStore.put`/`MemoryIndex.put`/`ReactiveEventStore.add` return it for events failing `validateSignedEvent` instead of silently lowercasing and storing them. The fake relay answers `OK false "invalid: malformed event"` (#128).
- **BREAKING**: `normalizeURL` throws `UrlError` for non-websocket schemes (`ftp:`, …); only `ws:`/`wss:` (and `http(s):` rewrites or bare hosts) are accepted (#128).
- `bytesToHex`/`hexToBytes` delegate to `@noble/hashes` (`hexToBytes` still throws `HexError`); `createSubscriptionId` reuses `bytesToHex` (#128).
- Event ordering drops `localeCompare`: `compareEventsDesc`/`itemCompare` order by `created_at` then plain `<` id compare over canonical lowercase ids (#128).
- NIP-59 seals have empty tags.
- NIP-46 `connect` accepts `bunker://` or a pointer only. A NIP-05 identifier is not a bunker pointer.
- `itemCompare` lives in `core`. NIP-77 does not re-export it.
- `Filter.search` (NIP-50) is relay-side. Local `matchFilter` / `EventStore.query` ignore it.
- `CountResult.hll` is a 512-char hex sketch, not opaque base64.
- Gossip mixed authors: unrouted keys REQ Client default relays. Gossip `onclose` fires once after every inner sub closes.
- `EventBuilder.repost` is kind 1 only; `genericRepost` rejects kind 1. Empty `d` is a valid addressable identifier. NIP-10 `parseThreadTags` / `buildReplyTags` parse and emit `q` tags. `replyTo` is kind 1 only.
- Custom REQ and COUNT ids are validated to 1..64 characters.
- `SyncOptions.observe: false` skips `putMany` and ingestMeta; received ids are still listed.
- Pool `connectTimeoutMs` default is 5000.
- `createEventLoader` batch fetches run in parallel.
- `ClientError` for Client lifecycle (shutdown, no signer, no relays, abort).
- `Client.fetchEvents` merges storage, index, and network results through NIP-01 semantics — replaceable/addressable winners, kind-5 deletions, id dedupe, and per-filter `limit` — instead of a plain id-keyed map (#125).
- BREAKING: `ClientOptions.automaticAuth` defaults to `true` regardless of signer presence. The AUTH sign function reads the current signer at challenge time, so `setSigner()` applies to already-connected relays; a challenge with no signer is ignored (previously automatic auth was only enabled when a signer was passed in the constructor).
- BREAKING: `PoolOptions.allowInsecure` defaults to `false`. `ws://` relays are rejected by `ensureRelay` unless listed in `trustedInsecureUrls` or `setAllowInsecure(true)` is called (previously allowed by default).

### Removed

- Dual-key DM kinds 10044 / 4454 / 4455.
- NIP-59 `encryptTo`.
- NIP-46 NIP-05 identifier login.
- Pool `seenOn` / `trackRelays` / `allowConnectingToRelay`.

### Fixed

- A throwing `onevent` no longer drops the rest of a relay fetch batch; user-callback errors are isolated via `reportError` across `fetchRouted`/`fanIn`, REQ dispatch, `Subscription.close`, and `ReactiveEventStore` watch/`onInsert` listeners (#125).
- Equivalent relay URL spellings no longer duplicate fan-in attachments or `Client` relay entries: job URLs are normalized and deduped, and `Client` stores normalized `relays` (#125).
- `maxRelays` no longer closes relays that are still connecting (#125).
- `Relay.auth` caches the relay's settled OK verdict per challenge instead of the in-flight promise: a rejected AUTH replays the cached `OK false` without re-signing, while timeouts and send failures are not cached so the next `auth()` signs again (#125).
- Fake relay (`src/testing`): per-filter `limit` and NIP-50 `search` are applied per filter in REQ/COUNT/NEG-OPEN, live delivery only fires for retained events, re-publishes answer `duplicate:`/`invalid:` correctly, and malformed AUTH/NEG-MSG frames no longer poison the session queue (#125).
- `ReactiveEventStore`: `query`/`hydrate` keep newest entries hottest in LRU order, `add` never evicts the just-inserted event, re-entrant writes are notified within the same flush, `seenOn` records normalized ids, and `watchQuery` cache entries are released on unsubscribe (#125).
- `MemoryIndex.isDeleted`/`getByAddress` canonicalize coordinates (lowercase pubkey), and a replacement newer than the tombstone's `until` clears the deletion (#125).
- NIP-77 down-sync, outbox live/sync receipts, and `fetchPrivateMessages`/`subscribePrivateMessages` now write every received event into `client.index` and record each delivering relay in `seenOn` (#125).
- EVENT `auth-required:` rearms the publish timeout after AUTH.
- Extra live REQ while disconnected does not reset reconnect backoff.
- `subscribePrivateMessages` close/abort skips later persist and `onevent`; junk wraps are not stored.

[Unreleased]: https://github.com/qntx/nostr.js/commits/HEAD
