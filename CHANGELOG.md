# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version is `0.1.0`. `0.0.1` was the local `npm publish`. Tag `v0.1.0` runs `publish.yml`: Ubuntu `build:wasm`, then `npm publish --provenance`. `pack:local` stays JS-only.

## [Unreleased]

### Breaking changes

- Event `id`/`pubkey`/`sig` must be canonical lowercase hex: `isHex32`/`isHex64` are strict lowercase predicates, `validateEvent`/`validateSignedEvent` and wire parsing (`parseRelayMessage`/`parseClientMessage`) reject uppercase fields, and `serializeEvent`/`verifyEvent` no longer lowercase them. Caller input stays case-insensitive via `assertHex32` and lowercased lookups (#129).
- `PutResult` gains `"invalid"`: `EventStore.put`/`MemoryIndex.put`/`ReactiveEventStore.add` return it for events failing `validateSignedEvent` instead of silently lowercasing and storing them; handle the new variant. The fake relay answers `OK false "invalid: malformed event"` (#129).
- `normalizeURL` throws `UrlError` for non-websocket schemes (`ftp:`, …); pass `ws:`/`wss:` (or `http(s):`/bare hosts, which are rewritten) (#129).
- Every abort-aware API rejects with `signal.reason` (falling back to an `AbortError`-named `Error`) instead of a synthesized `RelayConnectionError`/`Nip13Error`/`ClientError`; `fetchRouted`/`Pool.fetch`/`Pool.count`/`Client.fetchEvents` and outbox `sync` reject on abort instead of resolving partial results. Catch `signal.reason`/`AbortError`; subscription `onclose("aborted")` reason strings are unchanged (#131).
- `Nip46Transport.publish` must return `Promise<readonly { result?: { ok: boolean; message: string }; error?: string }[]>` (satisfied by `Pool.publish`); when no relay accepts the request event, `Nip46Signer` fails fast with `Nip46Error` instead of waiting for the timeout (#131).
- `RelayError` takes `options?: ErrorOptions` (so `cause` works), and every relay timeout — connect, publish, auth, COUNT, NIP-77 session — rejects with the new `RelayTimeoutError` subclass (#131).
- `ClientOptions.automaticAuth` defaults to `true` regardless of signer presence; the AUTH sign function reads the current signer at challenge time (a challenge with no signer is ignored). Pass `automaticAuth: false` to restore the 0.1.0 opt-in behavior (#123).
- `PoolOptions.allowInsecure` defaults to `false`; `ws://` relays are rejected unless listed in `trustedInsecureUrls` or `setAllowInsecure(true)` is called (#123).
- `Relay.connect` no longer lets a caller's `AbortSignal` own the shared connect attempt: every caller races its own signal and rejects with `signal.reason`, while the attempt keeps running and only `close()` cancels it (#135).
- `subscriptionToAsyncIterable` distinguishes local vs remote closes by state, not reason strings: an `onclose` without a preceding local close throws `RelayClosedError(reason)` from the iterator after draining queued events; locally initiated closes complete normally (#135).
- `createLoaders` requires `index: ReactiveEventStore` and drops the `cache` option — pass `client.index` (or your own store); fetched events flow through the new optional `ingest` callback (default `index.add`). `Loaders` drops `context` and gains `addRelay`/`removeRelay`/`replaceable(kind)`; `Client` wires `index` and `ingest` itself (#137).
- `EventBuilder.deletion` takes `targets, reason` where each target is an event-id string, `{ id, kind? }`, or `{ address }`; deduped `k` tags are emitted automatically (NIP-09 SHOULD) and the `kinds`/`addresses` options are gone (#133).
- `Nip96UploadResult` is a discriminated union — `{ status: "success"; url; tags }` or `{ status: "processing"; processingUrl; tags }`; check `status` before reading `url` (#133).
- `CountResult.hll` is a 512-char lowercase hex HyperLogLog sketch, not opaque base64.
- Validation that returned corrupt output in 0.1.0 now throws: NIP-19 encoders reject bad hex/kinds/>255-byte TLV values (`Nip19Error`), `getPow` rejects non-hex input (`Nip13Error`), `relayListToTags` rejects `{ read: false, write: false }` (`EventValidationError`), `dmRelayListEventBuilder`/`blossomServerListEventBuilder` throw when no valid tag would be emitted, and `createAuthTemplate` throws `BlossomError` for an explicitly empty `message` (#131, #133).

### Added

- `SqliteEventStore`: a production `EventStore` over a minimal async SQLite driver (`SqlDriver`: `exec`/`run`/`all`/exclusive `transaction`), for React Native (`expo-sqlite`, `op-sqlite`) and desktop runtimes — no dependency on Expo. Same semantics as `MemoryEventStore`/`IndexedDbEventStore`: shared `decidePut` insertion policy, NIP-09 tombstones, single winner row per address, per-filter SQL query plans with 500-value `IN` chunking, outbox-bound persistence and derivation, `negentropyItems`, and `count`. One driver transaction per `putMany`; a mid-batch failure rolls back atomically. Covered by the shared `eventStoreConformanceCases` suite (#139).
- `@qntx/nostr/store`: `ReactiveEventStore`, a synchronous in-memory event store with `useSyncExternalStore`-style watches (`watchEvent`, `watchReplaceable`, `watchQuery`), per-relay `seenOn` tracking, insertion listeners, and bounded LRU eviction that never evicts a subscribed watch's snapshot; evicted replaceable/addressable winners leave a bounded watermark so a stale version stays rejected while a newer one is re-accepted (#121, #137). `Client` owns one by default (`client.index`, `ClientBuilder.index`) and writes every inbound and published event into it before invoking caller callbacks.
- `@qntx/nostr/testing`: transport-agnostic fake relay shared by an in-process `createFakeRelayNetwork` (`websocketImplementation` for `Client`/`Pool`/`Relay`) and `serveFakeRelay` (real `ws` server, `port: 0`). NIP-01 EVENT/REQ/CLOSE/EOSE/OK/NOTICE/CLOSED, NIP-42 AUTH gating, NIP-45 COUNT, NIP-50 `search`, NIP-77 `NEG-*`; faults (`latencyMs`, `rateLimited`, `inject`, `disconnect`, …). Also `eventStoreConformanceCases` (shared `EventStore` suite) and `createFakeNip46Signer` (#119).
- Source relay URL on callbacks: `onevent(event, relayUrl)` fires on first receipt, `receivedEvent(id, relayUrl)` fires for every receipt including deduped duplicates; `fetchRouted`/`Pool.fetch`/`fetchGossip`/`Client.fetchEvents` `onevent` fires per event per relay. `relayUrl` is the `normalizeURL` result; `ReceivedPrivateMessage.relayUrl` is populated (#117).
- `RelayTimeoutError` (`RelayError` subclass) for every relay timeout, and `Nip46SignerOptions.authTimeoutMs` (default 300s) applied while waiting for the real response after a bunker `auth_url` answer (#131).
- `Relay.resetAuth` / `Pool.resetAuth`: clear a cached AUTH rejection and re-fire `onauth` so automatic auth can retry; `Client.setSigner` calls it so a new signer applies to already-connected relays (#125).
- `OutboxFeedOptions.observe` receives the relay URL and new `OutboxFeedOptions.seen` fires for every event receipt from every relay (#125).
- `NoSignerError` (`NostrError` subclass): thrown by a lazy AUTH sign function when no signer is configured at challenge time; `Relay` ignores the challenge — no AUTH frame, connection stays open (#123).
- `PoolOptions.pinnedUrls` + `Pool.setPinnedUrls`: relays never closed by idle cleanup or `maxRelays` eviction (#123).
- `Relay.inFlightCount`: one-shot requests still awaiting a reply; idle detection uses it alongside `subscriptionCount` (#123).
- `ClientOptions`/`ClientBuilder` forward `allowInsecure`, `trustedInsecureUrls`, `idleTimeoutMs`, `maxRelays`, and `pinnedUrls` to the pool. `Client.setSigner` accepts `undefined` to remove the signer (#123).
- `GossipOptions.maxPubkeys` (default 10_000): routing state is LRU — route lookups refresh recency and inserts beyond the cap drop the oldest pubkey (#137).
- `nip44.getMessageKeys` export covering the spec's `get_message_keys` vectors (#133).
- `MemoryIndex` and `MemoryIndexOptions` are exported from `./storage` (the synchronous index behind `MemoryEventStore`/`ReactiveEventStore`), with `maxTombstones` bounding all three deletion-state collections (#135).
- Runtime requirements are now documented: the host must provide `crypto.getRandomValues`, `TextEncoder`, a UTF-8 `TextDecoder`, WHATWG `URL`/`URLSearchParams`, `queueMicrotask`, `setTimeout`, and `AbortController`, plus `fetch`/`WebSocket` for network features (Node, browsers, and Expo/React Native all satisfy them; the library ships no polyfills). Verified by a bundled smoke test run on the Hermes V1 engine React Native 0.86 ships (`bun run smoke:hermes`), exercised in CI on every pull request (#140).

### Changed

- `MemoryEventStore` internals moved into the synchronous `MemoryIndex`; `MemoryEventStore` is a thin async facade with unchanged `EventStore` semantics.
- User-facing throws use `NostrError` subclasses (`Nip19Error`, `OutboxError`, `RelayPublishError`, `RelayClosedError`, `CryptoError`, `StorageError`, `ClientError` for Client lifecycle, …); `WasmVerifyPoisonedError` keeps `name` for relay duck-typing.
- `subscribePrivateMessages` live REQ includes kind 21059 in addition to 1059; `fetchPrivateMessages` still REQs 1059 only. Kind 21059 wraps are not stored.
- `KeysSigner` caches NIP-44 conversation keys per peer pubkey; gift-wrap `encryptToPubkey` still derives per call.
- `Relay.subscribe` coalesces identical live REQs (`filterFingerprint`): the first subscribe sends REQ, later identical attaches reuse the wire id, and the last `close()` sends CLOSE; verify/watermark run once per EVENT then fan out; a late attach after EOSE fires that listener's `oneose` on a microtask; non-identical filters are not merged.
- Pool/Client `oneose` waits for the slowest relay unless `eoseTimeoutMs` is set; `eoseTimeoutMs` synthesizes `oneose` once and no longer closes the live REQ. `Relay.fetch` remains the one-shot closer.
- `Client.sync` runs per-relay sessions in parallel (`Promise.allSettled`) and merges fulfilled summaries, throwing only when every relay rejects. NIP-77 upload queries `ids: have` once, then publishes in chunks of 8.
- Gossip `publish` includes up to five normalized `e`/`a` tag relay hints; mixed-author feeds REQ unrouted keys on the Client default relays, and `onclose` fires once after every inner sub closes.
- `groupAuthorsByOutboxRelay`/`OutboxFeed` prefer already-connected candidate URLs; `OutboxFeed` rehydrates/persists via `EventStore.getOutboxBound`/`setOutboxBound` and splits mixed bounded/unbounded groups.
- `SyncOptions.observe: false` skips `putMany` and ingest meta; received ids are still listed.
- `Client.fetchEvents` merges storage, index, and network results through NIP-01 semantics — replaceable/addressable winners, kind-5 deletions, id dedupe, per-filter `limit` — instead of a plain id-keyed map (#125).
- Client inbound events share one ingest path — index add (with relay URL) -> gossip/loader meta -> persistence queue (#135).
- `Kind` catalog is 28 production names; dual-key DM kinds 10044/4454/4455 dropped.
- NIP spec alignments (#133): NIP-10 unknown `e` markers go to `mentions` only and `buildReplyTags` omits an unknown root pubkey hint; NIP-59 seals carry empty tags and `unwrap` accepts expiration-only seal tags (NIP-17); `isNip05`/`parseNip05` share one validator (`[a-z0-9._-]`, case-insensitive); `nip44.decodePayload` checks the `#` version marker then `DEFAULT_MAX_PAYLOAD_CHARS` before base64; NIP-77 `Negentropy.reconcile` answers a single `0x61` to foreign 0x60-0x6f queries; `fetchNip96Info` follows `delegated_to_url` exactly one hop.
- `bytesToHex`/`hexToBytes` delegate to `@noble/hashes` (`hexToBytes` still throws `HexError`); event ordering drops `localeCompare` for `created_at`-then-id over canonical ids; custom REQ/COUNT ids are validated to 1..64 characters (#129).
- `signEvent`/`finalizeEvent` accept a `Keys` instance and reuse its cached public key; `Nip07Signer.getPublicKey` validates with `assertHex32`; NIP-46 request ids are 128-bit random (#131).
- `MemoryIndexOptions.maxTombstones` bounds tombstoned ids, pending e-tag ids, and coordinate tombstones, each FIFO; `ReactiveEventStore` keeps a 100_000 default, `MemoryEventStore` stays unbounded (#135).
- IndexedDB `scanFilter` opens at most 64 merge cursors per filter, then falls back to one cursor per kind or a single `created_at` scan plus `matchFilter`; results and per-filter limits are unchanged (#135).
- TypeScript strictness: `tsconfig` enables `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `noImplicitOverride`, and `isolatedDeclarations`; every root export carries a TSDoc summary; `check:pkg` (`WASM_PACK=1 vp pack && publint && attw --pack . --profile esm-only`) validates the published package at the end of `build:wasm` (#138).

### Removed

- `isMarkedVerified`, `utf8Encoder`, and `utf8Decoder` are no longer exported from the root entry or `./core`; `cloneFilter` is deleted (it had no callers). Internal users import from `core/util.ts`/`core/event.ts` directly (#138).
- Loader internals are no longer exported from `./loaders` or the root entry: `DataLoader`, `LoaderError`, `LoaderContext`, `LoaderContextOptions`, `ReplaceableCache`, `createReplaceableLoader`, `createListLoaders`, `createProfileLoader`, `createEventLoader`; `Loaders.context` is gone — use `createLoaders` and `Loaders.replaceable(kind)` (#137).

### Fixed

- A throwing `onevent` no longer drops the rest of a relay fetch batch; user-callback errors are isolated via `reportError` across `fetchRouted`/`fanIn`, REQ dispatch, `Subscription.close`, and store watch/`onInsert` listeners (#125).
- Equivalent relay URL spellings no longer duplicate fan-in attachments or `Client` relay entries: job URLs are normalized and deduped, and `Client` stores normalized `relays` (#125).
- Event stores canonicalize address coordinates (lowercase pubkey) in `isDeleted`/`getByAddress`, and a replacement newer than the tombstone's `until` clears the deletion (#125).
- `IndexedDbEventStore.setOutboxBound` serializes through the write queue so it cannot overlap `putMany` or `clear`.
- `Nip46Signer`: an `auth_url` reply re-arms the request under `authTimeoutMs` instead of consuming it, `close()` clears pending auth waits, and `onAuthUrl` (plus `Relay.onnotice`/`onclose`/`onauth`/`onreconnect`, `PoolOptions.onIdleRelaysClosed`, `Client.onstorageerror`, `OutboxFeed` `onEvent`/`observe`/`seen`) throwing is isolated via `reportError` (#131).
- `Relay.fetch` aborted mid-flight rejects with `signal.reason` instead of resolving a partial batch (#131).
- EVENT `auth-required:` rearms the publish timeout after AUTH.
- An extra live REQ while disconnected no longer resets reconnect backoff.
- `subscribePrivateMessages` close/abort skips later persist and `onevent`; junk wraps are not stored.

[Unreleased]: https://github.com/qntx/nostr.js/commits/HEAD
