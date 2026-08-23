# Protocol alignment

Checked against this branch HEAD and `3rdparty/nips`. Implemented surface only. Official NIPs are not a checklist.

## Aligned

| NIP | Notes |
| --- | --- |
| 01 events/messages/kinds/filters | Canonical array serialization; REQ/EVENT/CLOSE/OK/EOSE/CLOSED/NOTICE; sub id ≤ 64. Regular `1`, `2`, `4..44`, `1000..9999`. Kind integer `0..65535`. `matchFilter` is boolean; `limit` is relay-side |
| 02 contacts | Kind 3 `p` tags (`EventBuilder.contacts`) |
| 04 | Crypto matches; module kept; spec unrecommended |
| 05 | Well-known lookup, `redirect: "manual"`. Appendix `{relays, nostrconnect_url}` parse only — not a bunker login |
| 07 | `window.nostr` provider |
| 09 | Builder emits `e`/`a`/`k`. Stores apply `e` and `a` with pubkey check |
| 10 | Preferred `root`/`reply`. Unmarked/`""` positional. Unknown markers including `mention` → `mentions[]` only. NIP-01 hex32 at e-tag index 3 is author, stays positional |
| 11 | Fetch with `Accept: application/nostr+json`, `redirect: "manual"`. Types omit invented `tags` / `max_filters` |
| 13 | `getPow`, async `minePow`; does not sign |
| 17 | Kind 14 + 10050; unmarked reply `e`; no kind 15 |
| 18 | Kind 6 `repost` requires `relayHint` through `normalizeURL`; kind 16 `genericRepost` same factory rule |
| 19 | npub/nsec/note/nprofile/nevent/naddr; `nrelay` omitted (deprecated) |
| 21 | `nostr:` URIs; **nsec excluded** |
| 25 | `reaction(Event)`: `e` four-tuple, `p`, `k`; `a` only if `isAddressableKind` |
| 27 | Content mentions are `nostr:` NIP-21; `nsec` skipped |
| 42 | AUTH kind 22242 |
| 44 | v2 only |
| 45 | COUNT; relay `CLOSED` on the COUNT id fails the waiter |
| 46 | `bunker://` and pointer only; NIP-05 login removed; `connect` → `get_public_key` |
| 49 | `ncryptsec`, scrypt + xchacha20poly1305 |
| 50 | `Filter.search` is relay-side; local `matchFilter` / query ignore it |
| 51 | Public tags only |
| 57 | `makeZapRequest` Appendix A. `validateZapReceipt` F + D 1,3–5,7,8 + E bolt11/description/preimage + copy `p`/`e`/`a` + receipt `P` = `request.pubkey` (sender). D.6 LNURL HTTP out. Never throws |
| 59 | Empty seal tags; wrap `extraTags` kept; `encryptTo` gone; 21059 unwrap-only |
| 65 | Kind 10002 `r` tags |
| 70 | Honored on `repost` / `genericRepost` (empty content) |
| 77 | 4-element `NEG-OPEN` only; 5-element rejected. `itemCompare` lives in core, not re-exported from nip77 |
| 96 | Unrecommended-kept; well-known + upload |
| 98 | Kind 27235, standard base64 |
| B7 / Blossom | Kind 10063 + BUD HTTP; Authorization is **base64url** |

## Partial / out of library

| NIP | Remainder |
| --- | --- |
| 14 | Kind-1 `subject`: no dedicated API (non-goal) |
| 17 | Kind 15 file-message rumors: not implemented |
| 51 | Encrypted `.content`: caller’s job |
| 57 | D.6 LNURL HTTP: out |
| 59 | Kind 21059 emit: unwrap-only (no kind param on `createGiftWrap`) |
| 96 | Unrecommended |

## Policy

- Do not add nostr-tools name shims.
- Dual-key gift wrap (kinds 10044/4454/4455) is **not** in `Kind` and is **not** a NIP-59 option (`encryptTo` / seal `extraTags` deleted). It stays out of this library.
- Official NIPs are not a checklist; unimplemented NIPs stay unimplemented.
