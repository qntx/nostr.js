<!-- markdownlint-disable MD033 MD041 -->

# nostr.js

Layered TypeScript Nostr library: events, keys, filters, signers, relays, storage, gossip, and a `Client` facade in one ESM package.

See [docs/](docs/).

## Testing

`@qntx/nostr/testing` ships a transport-agnostic fake relay (NIP-01 EVENT/REQ/COUNT plus NIP-42 auth, NIP-50 `search`, and NIP-77 `NEG-*`) for in-process tests and for serving over a real `ws` socket:

```ts
import { createFakeRelayNetwork } from "@qntx/nostr/testing";

const net = createFakeRelayNetwork();
const relay = net.relay("wss://a.example", { latencyMs: 5 });
relay.seed([event]);
// pass net.websocketImplementation to Client/Pool/Relay or useWebSocketImplementation
relay.inject(liveEvent); // stored + delivered to matching live subscriptions
relay.disconnect(); // drop every socket of this relay
relay.closeSubscriptions("lab: done");
```

`serveFakeRelay({ port: 0 })` serves the same relay core over a real WebSocket server (dynamic `import("ws")`; `ws` is an optional peer). `eventStoreConformanceCases` is a framework-agnostic suite to assert `EventStore` semantics (registered in this repo for `MemoryEventStore` and `IndexedDbEventStore`). `createFakeNip46Signer` answers NIP-46 remote-signing RPCs inside the fake network.

## License

Licensed under the MIT License ([LICENSE](LICENSE) or <https://opensource.org/licenses/MIT>).

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this project shall be licensed as above, without any additional terms or conditions.

---

<div align="center">

A **[QuantX](https://qntx.org)** open-source project.

<a href="https://qntx.org"><img alt="QuantX" width="369" src="https://raw.githubusercontent.com/qntx/.github/main/profile/qntx.svg" /></a>

Code is law. We write both.

</div>
