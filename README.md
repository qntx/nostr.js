# @qntx/nostr

`@qntx/nostr` is a layered TypeScript Nostr library: events, keys, filters, signers, relays, storage, gossip, and a `Client` facade in one ESM package with subpath exports. [nostr-tools](https://github.com/nbd-wtf/nostr-tools) is primitives without a client. [NDK](https://github.com/nostr-dev-kit/ndk) is an app kit (sessions, React/Svelte, NWC, Cashu, web of trust). This package is neither: instance-scoped, injected I/O, JSON-friendly plain `Event` objects, no product shell.

## Install

```bash
npm i @qntx/nostr
```

The package is unpublished. Version is `0.0.0` until a human publishes it. ESM only. Node `>=20.19.0`.

## Quick start

```ts
import { Client, EventBuilder, Keys, KeysSigner } from "@qntx/nostr";

const client = Client.builder()
  .signer(new KeysSigner(Keys.generate()))
  .relays(["wss://relay.example"])
  .build();

await client.connect();
await client.publish(EventBuilder.textNote("hello"));

const notes = await client.fetchEvents({ kinds: [1], limit: 20 });

const sub = client.subscribe(
  { kinds: [1] },
  {
    onevent(event) {
      // `event` is a plain object
    },
    oneose() {
      // every targeted relay EOSEd, failed, or closed before EOSE
    },
    eoseTimeoutMs: 4000,
  },
);
sub.close();
```

`oneose` waits for the slowest relay. Without `eoseTimeoutMs`, a connected silent relay can stall it. The timeout does not close the subscription.

## Node WebSocket

Browsers and runtimes with `globalThis.WebSocket` need no setup. On Node, install the optional peer and inject it:

```bash
npm i ws
```

```ts
import WebSocket from "ws";
import { useWebSocketImplementation } from "@qntx/nostr";

useWebSocketImplementation(WebSocket);
```

`useWebSocketImplementation` is process-wide. For one client, pass `.websocketImplementation(WebSocket)` on `Client.builder()` instead.

## Subpaths

Prefer a layer import when you do not need the facade.

| Import                | Surface                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `@qntx/nostr`         | Re-export of the layers below                                                |
| `@qntx/nostr/core`    | `Event`, `Kind`, `Filter`, `Keys`, `EventBuilder`, messages, `mergeCountHll` |
| `@qntx/nostr/signer`  | `KeysSigner`, `Nip07Signer`, `Nip46Signer`                                   |
| `@qntx/nostr/relay`   | `Relay`, `Pool`, `useWebSocketImplementation`                                |
| `@qntx/nostr/client`  | `Client`, `ClientBuilder`                                                    |
| `@qntx/nostr/storage` | `MemoryEventStore`, `IndexedDbEventStore`                                    |
| `@qntx/nostr/loaders` | `OutboxFeed`, `DataLoader`, list/profile/event loaders                       |
| `@qntx/nostr/gossip`  | `Gossip`                                                                     |
| `@qntx/nostr/nips/*`  | One module per NIP (table below)                                             |

There is no `@qntx/nostr/nips` barrel. Import `@qntx/nostr/nips/nip19`, `@qntx/nostr/nips/blossom`, and so on.

## I/O injection

Cross-layer I/O is passed in. Nothing in `core` or `nips` opens a socket.

**`verifyEvent`** is `(event: Event) => boolean`. `Relay` calls it **synchronously** on each EVENT frame. Default is core BIP-340 (`verifyEvent` in `@qntx/nostr/core`). A `Worker` is not a drop-in: `postMessage` cannot return `boolean` without an app-owned blocking bridge, or the app verifies before `observe` / `subscribe`. Do not pass an async function.

```ts
import { Client, verifyEvent, type Event } from "@qntx/nostr";

const client = Client.builder()
  .relays(["wss://relay.example"])
  .verifyEvent((event: Event) => verifyEvent(event))
  .enablePing(true)
  .pingIntervalMs(120_000)
  .build();
```

`enablePing` defaults to false (interval 29s, timeout 20s). Turn it on for long-lived processes.

**WebSocket** — `useWebSocketImplementation` or `ClientBuilder.websocketImplementation` / `Pool` `websocketImplementation`.

**`fetch`** — NIP-05, NIP-11, NIP-96, and Blossom take `{ fetch }`. Default is `globalThis.fetch`.

```ts
import { fetchRelayInformation, queryProfile } from "@qntx/nostr";

await queryProfile("alice@example.com", { fetch: myFetch });
await fetchRelayInformation("wss://relay.example", { fetch: myFetch });
```

**`Nip46Transport`** — `{ subscribe, publish, close }`. `Pool` satisfies it. `Nip46Signer` does not import `relay`.

**`Nip59Crypto`** — `{ getPublicKey, signEvent, nip44Encrypt, nip44Decrypt }`. `KeysSigner` satisfies it. `Client.sendPrivateMessage` requires NIP-44 on the signer.

## NIP modules

Implemented modules under `@qntx/nostr/nips/*`. Official NIPs are not a checklist; unimplemented NIPs stay unimplemented.

| NIP | Subpath        | Notes                                                                          |
| --- | -------------- | ------------------------------------------------------------------------------ |
| 04  | `nips/nip04`   | Unrecommended. Prefer NIP-44.                                                  |
| 05  | `nips/nip05`   | Well-known lookup. Appendix `nip46` is discovery metadata, not a bunker login. |
| 10  | `nips/nip10`   | Thread tags. Unknown `e` markers are mentions, not positional.                 |
| 11  | `nips/nip11`   | Relay information document.                                                    |
| 13  | `nips/nip13`   | Proof of work. Does not sign.                                                  |
| 17  | `nips/nip17`   | Kind 14 + 10050. No kind 15.                                                   |
| 19  | `nips/nip19`   | bech32. `nrelay` omitted.                                                      |
| 21  | `nips/nip21`   | `nostr:` URIs. `nsec` excluded.                                                |
| 27  | `nips/nip27`   | Content mentions.                                                              |
| 42  | `nips/nip42`   | AUTH.                                                                          |
| 44  | `nips/nip44`   | v2 only.                                                                       |
| 46  | `nips/nip46`   | `bunker://` / pointer. NIP-05 identifiers are not bunker pointers.             |
| 49  | `nips/nip49`   | `ncryptsec`.                                                                   |
| 51  | `nips/nip51`   | Public list tags.                                                              |
| 57  | `nips/nip57`   | Zap request + receipt validation. No LNURL HTTP.                               |
| 59  | `nips/nip59`   | Gift wrap. Empty seals.                                                        |
| 65  | `nips/nip65`   | Kind 10002 relay lists.                                                        |
| 77  | `nips/nip77`   | Negentropy algorithm.                                                          |
| 96  | `nips/nip96`   | Unrecommended. Prefer Blossom / NIP-B7.                                        |
| 98  | `nips/nip98`   | HTTP auth (standard base64).                                                   |
| B7  | `nips/blossom` | Kind 10063 + BUD HTTP. Authorization is base64url, not NIP-98.                 |

NIP-01 events/filters/messages, NIP-02 contacts, NIP-09 deletion, NIP-18/25 via `EventBuilder`, NIP-45 COUNT (`mergeCountHll`), and NIP-50 `Filter.search` live in `core` / `EventBuilder` / `relay`.

## Signers

```ts
import { Keys, KeysSigner, Nip07Signer, Nip46Signer, Pool } from "@qntx/nostr";

new KeysSigner(Keys.generate());
new Nip07Signer(); // window.nostr

const pool = new Pool();
const remote = await Nip46Signer.connect("bunker://...", { pool });

const reused = Nip46Signer.fromBunker(pointer, {
  pool,
  clientSecretKey, // required; same client identity as the original connect
});
```

`connect` sends the `connect` RPC. `fromBunker` resubscribes without a new handshake. Pass `Pool` as `pool` (or `createPool`). The signer does not close a shared `pool`.

## Storage

`Client` defaults to `MemoryEventStore`. For a browser, pass IndexedDB:

```ts
import { Client, IndexedDbEventStore } from "@qntx/nostr";

const storage = new IndexedDbEventStore({ dbName: "my-app" });
await storage.open();

const client = Client.builder().storage(storage).relays(["wss://relay.example"]).build();
```

Both stores apply replaceable / addressable / NIP-09 deletion on `put`. `query` / `count` / `negentropyItems` use the same `Filter` type as the wire.

NIP-50 `search` is relay-side. Local `matchFilter` and `EventStore.query` ignore it.

## Gossip and outbox

NIP-65 routing is explicit. `Client.hydrateGossip` loads kind 10002 and kind 10050 for the given pubkeys and does not background-fetch unknown authors on subscribe.

```ts
await client.hydrateGossip([pubkey]);

client.subscribe({ kinds: [1], authors: [pubkey] }, { gossip: true });
await client.publish(EventBuilder.textNote("hello"), { gossip: true });

const feed = client.outbox({ authors: [pubkey] });
const { close } = await feed.start();
close();
```

Gossip publish uses the author's outbox, tagged `p` inboxes, and up to five `e` / `a` tag relay hints. `OutboxFeed` groups authors by write relays and prefers already-connected candidates; it does not add a connected URL that is not already in the author's list.

## NIP-17 private messages

Kind 14 rumors wrapped as kind 1059. Delivery relays come only from the recipient's kind 10050 list. Missing 10050 throws. There is no fallback to kind 10002.

```ts
await client.setDmRelays(["wss://inbox.example"]);
await client.sendPrivateMessage(recipientPubkey, "hello");
```

`setDmRelays` publishes the sender's 10050. `sendPrivateMessage` hydrates gossip for sender and recipients, then publishes each wrap only to that recipient's 10050 relays.

## NIP-77 sync

```ts
const summary = await client.sync({ kinds: [1], authors: [pubkey] }, { direction: "both" });
```

One Negentropy session per relay, in parallel. Fulfilled summaries merge. Mixed success does not throw. If every relay rejects, the first rejection in URL order is thrown.

## Blossom

Upload with a kind 24242 auth event. Heal a dead blob URL with **that author's** kind 10063 list — not a global server list. There is no 10063 loader.

```ts
import { Kind, createUploadAuth, healBlobUrl, parseBlossomServerList, upload } from "@qntx/nostr";

const auth = await createUploadAuth((template) => client.signTemplate(template), file);
const descriptor = await upload("https://cdn.example", file, auth);

const lists = await client.fetchEvents({
  kinds: [Kind.BlossomServerList],
  authors: [author],
});
const servers = lists[0] ? parseBlossomServerList(lists[0]) : [];
const url = await healBlobUrl(brokenUrl, servers);
```

Treat kind 10063 like any other replaceable list (authenticate the author). Also: `blobExists` (HEAD only; 2xx true, 404 false, else throw), `getBlob` (GET + sha256), `uploadToServers`.

## License

This project is licensed under the [MIT License](LICENSE).

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this project shall be licensed as above, without any additional terms or conditions.
