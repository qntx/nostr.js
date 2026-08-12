# nostr.js

Nostr protocol implementation and SDK in TypeScript (`@qntx/nostr`).

Architecture: **nula-aligned layering** + **nostr-tools protocol fidelity** + **gadgets client patterns without globals**. See [docs/adr/0001-layering.md](docs/adr/0001-layering.md).

## Install

```bash
npm install @qntx/nostr
# Node without global WebSocket (optional peer):
npm install ws
```

## Quickstart

```ts
import { Client, EventBuilder, Keys, KeysSigner } from "@qntx/nostr";

const keys = Keys.generate();
const client = Client.builder()
  .signer(new KeysSigner(keys))
  .relays(["wss://relay.damus.io"])
  // optional: .storage(new IndexedDbEventStore()) after await store.open()
  .build();

await client.connect();
await client.publish(EventBuilder.textNote("hello from @qntx/nostr"));
// publish/fetch/subscribe auto-observe into MemoryEventStore + gossip/loader cache

const profile = await client.loaders.profile(keys.publicKey);
const follows = await client.loaders.follows(keys.publicKey);

// Load NIP-65 lists into gossip routing (explicit, predictable)
await client.hydrateGossip(follows.items.slice(0, 50));
await client.publish(EventBuilder.textNote("via outbox"), { gossip: true });

// Local-first read
const cached = await client.fetchEvents({ kinds: [1], limit: 20 }, { localFirst: true });

// Outbox feed (NIP-65 write relays)
const feed = client.outbox({ authors: follows.items.slice(0, 50) });
const history = await feed.sync({ limit: 30 });
const live = feed.startLive();
void profile;
void cached;
void history;

await client.shutdown();
live.close();
feed.close();
```

Node without global `WebSocket`:

```ts
import WebSocket from "ws";
import { useWebSocketImplementation } from "@qntx/nostr";
useWebSocketImplementation(WebSocket);
```

## Layers & subpaths

| Subpath               | Contents                                                             |
| --------------------- | -------------------------------------------------------------------- |
| `@qntx/nostr`         | Curated public facade                                                |
| `@qntx/nostr/core`    | Events, keys, filter, messages, EventBuilder                         |
| `@qntx/nostr/signer`  | `NostrSigner`, `KeysSigner`, `Nip07Signer`, `Nip46Signer`            |
| `@qntx/nostr/relay`   | `Relay`, `Pool`, reconnect, AUTH                                     |
| `@qntx/nostr/client`  | `Client`, `ClientBuilder`                                            |
| `@qntx/nostr/storage` | `EventStore`, `MemoryEventStore`, `IndexedDbEventStore`              |
| `@qntx/nostr/loaders` | List/profile/event loaders + `OutboxFeed` (instance-scoped)          |
| `@qntx/nostr/gossip`  | NIP-65 routing / `breakDownFilter`                                   |
| `@qntx/nostr/nips/*`  | nip04, nip05, nip10, nip19, nip21, nip27, nip42, nip44, nip46, nip65 |

## Signers

```ts
import { KeysSigner, Nip07Signer, isNip07Available } from "@qntx/nostr";

// local keys
const local = new KeysSigner(keys);

// browser extension (NIP-07)
if (isNip07Available()) {
  const ext = new Nip07Signer();
  // Client.builder().signer(ext) or:
  client.setSigner(ext);
}

// remote bunker (NIP-46) — inject Pool (signer does not import relay)
// const remote = await Nip46Signer.connect("bunker://…?relay=wss://…&secret=…", {
//   createPool: () => new Pool({ enableReconnect: true }),
//   // or: pool: client.pool,
// })
// NIP-05 bunker identity:
// await Nip46Signer.connect("alice@example.com", {
//   createPool: () => new Pool({ enableReconnect: true }),
//   secret: "…",
// })
// client.setSigner(remote)
```

## Storage

```ts
import { MemoryEventStore, IndexedDbEventStore } from "@qntx/nostr";

const memory = new MemoryEventStore();
if (IndexedDbEventStore.isAvailable()) {
  const idb = new IndexedDbEventStore();
  await idb.open();
}
```

## Production notes

- ESM-only (`"type": "module"`), `sideEffects: false`, explicit `exports.types`
- Source maps published with the build (`*.mjs.map`)
- Tree-shake via subpath imports
- No module-level client/pool singletons
- Optional peer `ws` for Node when `globalThis.WebSocket` is absent
- `SecretKey.zeroize()` for best-effort secret wipe
- Prefer NIP-44 over NIP-04 for new DMs
- Prefer `Nip07Signer` / remote signers over shipping secret keys in web apps
- Layering: `signer` never imports `relay`; NIP-46 takes an injected `Nip46Transport` (`Pool`)

## Development

```bash
vp install
bun test tests
vp run build
vp check

# optional live-relay smoke (requires network + optional peer `ws` on Node):
# NOSTR_LIVE_RELAY=wss://relay.damus.io bun test tests/live-relay.test.ts
```

## License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">

A **[QuantX](https://qntx.fun)** open-source project.

<a href="https://qntx.fun"><img alt="QuantX" width="369" src="https://raw.githubusercontent.com/qntx/.github/main/profile/qntx.svg" /></a>

Code is law. We write both.

</div>
