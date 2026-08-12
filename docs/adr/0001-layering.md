# ADR-0001: Layering and package shape

## Status

Accepted

## Context

`@qntx/nostr` must provide a Nostr TypeScript SDK with better structure than
flat `nostr-tools`, without gadgets-style globals, and with a mental model
aligned to the QuantX Rust SDK `nula`.

## Decision

1. Single npm package `@qntx/nostr` with layered **subpath exports**.
2. Internal modules mirror nula layers: `core` → `signer`/`nips` → `relay` →
   `storage`/`gossip`/`loaders` → `client`.
3. `core` has zero network and zero storage I/O.
4. Algorithms and test vectors may follow `nostr-tools`; runtime does not
   depend on it.
5. Client helpers inspired by `nostr-gadgets` are instance-scoped, never global.
6. Events stay JSON-friendly plain objects; verification cache uses `WeakSet`.

## Consequences

- Grow by phase: core first, then relay, then client facade.
- Root export re-exports the stable surface; heavy NIPs use `@qntx/nostr/nips/*`.
- Multi-package monorepo is deferred until a subpath split is forced by
  dependency or size constraints.
