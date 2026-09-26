/**
 * Hermes smoke test (N12): bundled to a single classic script and run on the
 * Hermes CLI that RN 0.86 ships (hermes-v250829098.0.17). Hard asserts only;
 * prints `HERMES_SMOKE_OK` after every check — including async ones — settled.
 *
 * The OK line is the pass contract: Hermes exits 0 even for unhandled async
 * errors (and `quit()` inside a promise callback does not set the exit code),
 * so runners must assert the marker appears in stdout.
 */
import { hermesGlobalsInstalled } from "./globals.ts";
import {
  EventBuilder,
  Keys,
  KeysSigner,
  Kind,
  MemoryEventStore,
  ReactiveEventStore,
  bytesToHex,
  finalizeEvent,
  getEventHash,
  hexToBytes,
  matchFilter,
  nip19Decode,
  normalizeURL,
  noteEncode,
  npubEncode,
  nsecEncode,
  serializeEvent,
  verifyEvent,
  type Event,
} from "../../src/index.ts";
import {
  decrypt as nip44Decrypt,
  decryptFromPubkey,
  encrypt as nip44Encrypt,
  encryptToPubkey,
  getConversationKey,
} from "../../src/nips/nip44.ts";
import * as nip49 from "../../src/nips/nip49.ts";
import { createRumor, unwrap, wrap } from "../../src/nips/nip59.ts";

declare function print(msg: string): void;
declare function quit(code: number): void;

function assert(cond: boolean, name: string): void {
  if (!cond) throw new Error(`smoke: ${name}`);
}
function eq<T>(got: T, want: T, name: string): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`smoke: ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
}

const SK = "0000000000000000000000000000000000000000000000000000000000000101";
const SK2 = "0000000000000000000000000000000000000000000000000000000000000b0b";

// Fixed vectors.
const UNSIGNED = {
  kind: 1,
  tags: [["t", "smoke"]],
  content: "hermes",
  created_at: 1_700_000_000,
  pubkey: "90a80db6eb294b9eab0b4e8ddfa3efe7263458ce2d07566df4e6c58868feef23",
};
const EXPECTED_SER =
  '[0,"90a80db6eb294b9eab0b4e8ddfa3efe7263458ce2d07566df4e6c58868feef23",1700000000,1,[["t","smoke"]],"hermes"]';
const EXPECTED_ID = "ca9b7b32e94eb1fa671703b2480f48f217faec663ba5b43d3b1a37cda7ae3458";

// tests/fixtures/nip44.vectors.json v2.valid.encrypt_decrypt[0].
const NIP44_VECTOR = {
  sec1: "0000000000000000000000000000000000000000000000000000000000000001",
  pub2: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
  conversation_key: "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d",
  nonce: "0000000000000000000000000000000000000000000000000000000000000001",
  plaintext: "a",
  payload:
    "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb",
};

async function main(): Promise<void> {
  assert(hermesGlobalsInstalled, "globals module evaluated");

  // Keys + signing.
  const generated = Keys.generate();
  assert(generated.publicKey.length === 64, "Keys.generate pubkey");
  const keys = Keys.fromSecretKey(SK);
  eq(keys.publicKey, UNSIGNED.pubkey, "getPublicKey");

  // Serialization + hashing against a fixed vector.
  eq(serializeEvent(UNSIGNED), EXPECTED_SER, "serializeEvent");
  eq(getEventHash(UNSIGNED), EXPECTED_ID, "getEventHash");
  const signed = finalizeEvent(UNSIGNED, SK);
  eq(signed.id, EXPECTED_ID, "finalizeEvent id");
  // schnorr aux_rand makes the signature value itself non-deterministic.
  assert(signed.sig.length === 128, "finalizeEvent sig length");
  assert(verifyEvent(signed), "verifyEvent signed");

  const bad: Event = { ...signed, content: "tampered" };
  assert(!verifyEvent(bad), "verifyEvent rejects tampered");

  // EventBuilder path.
  const built = new EventBuilder(1, "built").createdAt(1_700_000_001).signWithKeys(keys);
  assert(verifyEvent(built), "verifyEvent built");

  // NIP-44 official vector.
  const ck = getConversationKey(hexToBytes(NIP44_VECTOR.sec1), NIP44_VECTOR.pub2);
  eq(bytesToHex(ck), NIP44_VECTOR.conversation_key, "nip44 conversation key");
  const payload = nip44Encrypt(NIP44_VECTOR.plaintext, ck, hexToBytes(NIP44_VECTOR.nonce));
  eq(payload, NIP44_VECTOR.payload, "nip44 encrypt vector");
  eq(nip44Decrypt(NIP44_VECTOR.payload, ck), NIP44_VECTOR.plaintext, "nip44 decrypt vector");

  // NIP-44 round trip with random nonce.
  const ct = encryptToPubkey("hello hermes", hexToBytes(SK2), keys.publicKey);
  eq(
    decryptFromPubkey(ct, keys.secretKey.bytes, Keys.fromSecretKey(SK2).publicKey),
    "hello hermes",
    "nip44 round trip",
  );

  // NIP-49 round trip, logn 4.
  const ncryptsec = nip49.encrypt(keys.secretKey.bytes, "test-pass", 4);
  assert(ncryptsec.startsWith("ncryptsec1"), "nip49 prefix");
  eq(bytesToHex(nip49.decrypt(ncryptsec, "test-pass")), SK, "nip49 round trip");

  // NIP-19 round trips.
  const nsec = nsecEncode(keys.secretKey.bytes);
  const decodedNsec = nip19Decode(nsec);
  assert(decodedNsec.type === "nsec", "nsec type");
  eq(bytesToHex(decodedNsec.data as Uint8Array), SK, "nsec round trip");
  const npub = npubEncode(keys.publicKey);
  eq(nip19Decode(npub), { type: "npub", data: keys.publicKey }, "npub round trip");
  const note = noteEncode(signed.id);
  eq(nip19Decode(note), { type: "note", data: signed.id }, "note round trip");

  // matchFilter.
  assert(
    matchFilter({ kinds: [1], authors: [keys.publicKey] }, signed) &&
      !matchFilter({ kinds: [2] }, signed) &&
      matchFilter({ "#t": ["smoke"] }, signed),
    "matchFilter",
  );

  // normalizeURL vectors (WHATWG URL path: host lowercase, scheme rewrite,
  // default port drop, duplicate slash collapse, sorted query, fragment drop,
  // trailing "/" on the root path).
  eq(normalizeURL("Relay.EXAMPLE"), "wss://relay.example/", "normalizeURL bare host");
  eq(
    normalizeURL("https://Relay.EXAMPLE:443//a//b?z=1&y=2#frag"),
    "wss://relay.example/a/b?y=2&z=1",
    "normalizeURL full",
  );
  eq(normalizeURL("http://relay.example:80/x/"), "ws://relay.example/x", "normalizeURL ws");

  // ReactiveEventStore: add (with a relay URL → normalizeURL + seenOn), query,
  // watch notification delivered on a microtask.
  const index = new ReactiveEventStore();
  const watch = index.watchQuery([{ kinds: [1] }]);
  let notified = 0;
  watch.subscribe(() => {
    notified++;
  });
  watch.getSnapshot();
  eq(index.add(signed, "wss://relay.example"), "accepted", "index.add");
  eq(index.seenOn(signed.id), ["wss://relay.example/"], "seenOn normalized");
  // A differently-spelled URL for the same relay dedupes after normalization.
  eq(index.add(signed, "wss://Relay.EXAMPLE:443"), "duplicate", "index.add duplicate");
  eq(index.seenOn(signed.id), ["wss://relay.example/"], "seenOn deduped");
  assert(index.query([{ kinds: [1] }]).length === 1, "index.query");
  await Promise.resolve();
  assert(notified >= 1, "watch notified on microtask");

  // MemoryEventStore async path.
  const mem = new MemoryEventStore();
  eq(await mem.put(built), "accepted", "mem.put");
  eq(await mem.put(built), "duplicate", "mem.put duplicate");
  eq((await mem.query([{ ids: [built.id] }]))[0]?.id, built.id, "mem.query");
  eq(await mem.count([{ kinds: [1] }]), 1, "mem.count");

  // NIP-59 gift wrap round trip via KeysSigner (async, NIP-44 under the hood).
  const alice = new KeysSigner(SK);
  const bobKeys = Keys.fromSecretKey(SK2);
  const rumor = createRumor(keys.publicKey, {
    kind: Kind.PrivateDirectMessage,
    content: "secret hello",
    tags: [["p", bobKeys.publicKey]],
    created_at: 1_700_000_000,
  });
  const gift = await wrap(alice, bobKeys.publicKey, rumor);
  assert(gift.kind === Kind.GiftWrap, "nip59 wrap kind");
  assert(verifyEvent(gift), "nip59 gift signed");
  const inner = await unwrap(new KeysSigner(SK2), gift);
  eq(inner.content, "secret hello", "nip59 unwrap content");
  eq(inner.pubkey, keys.publicKey, "nip59 unwrap pubkey");
}

main().then(
  () => {
    print("HERMES_SMOKE_OK");
  },
  (err: unknown) => {
    print(`HERMES_SMOKE_FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    quit(1);
  },
);
