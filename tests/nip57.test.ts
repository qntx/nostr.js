import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import { describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  EventValidationError,
  Keys,
  Kind,
  hexToBytes,
  makeZapRequest,
  parseBolt11,
  parseZapRequestFromReceipt,
  utf8Encoder,
  validateZapReceipt,
  type Event,
  type Tag,
} from "../src/index.ts";

const keys = Keys.generate();
const relays = ["wss://a.example", "wss://b.example"] as const;

describe("makeZapRequest", () => {
  test("profile zap: kind, p, amount, comment, no e/k/a", () => {
    const before = Math.floor(Date.now() / 1000);
    const zr = makeZapRequest({
      pubkey: keys.publicKey,
      amount: 21000,
      relays,
      comment: "Zap!",
    });
    const after = Math.floor(Date.now() / 1000);

    expect(zr.kind).toBe(Kind.ZapRequest);
    expect(zr.kind).toBe(9734);
    expect(zr.content).toBe("Zap!");
    expect(zr.created_at).toBeGreaterThanOrEqual(before);
    expect(zr.created_at).toBeLessThanOrEqual(after);
    expect(zr.tags).toEqual([
      ["p", keys.publicKey],
      ["amount", "21000"],
      ["relays", "wss://a.example", "wss://b.example"],
    ]);
    expect(zr.tags.some((t) => t[0] === "e")).toBe(false);
    expect(zr.tags.some((t) => t[0] === "k")).toBe(false);
    expect(zr.tags.some((t) => t[0] === "a")).toBe(false);
    expect(zr.tags.some((t) => t[0] === "lnurl")).toBe(false);
  });

  test("profile zap omits comment as empty content", () => {
    const zr = makeZapRequest({
      pubkey: keys.publicKey,
      amount: 1,
      relays: ["wss://r.example"],
    });
    expect(zr.content).toBe("");
  });

  test("relays is a single tag with one or more URLs", () => {
    const zr = makeZapRequest({
      pubkey: keys.publicKey,
      amount: 1000,
      relays,
    });
    const relayTags = zr.tags.filter((t) => t[0] === "relays");
    expect(relayTags).toHaveLength(1);
    expect(relayTags[0]).toEqual(["relays", "wss://a.example", "wss://b.example"]);
    expect(typeof relayTags[0]![1]).toBe("string");
  });

  test("empty relays throws", () => {
    expect(() => makeZapRequest({ pubkey: keys.publicKey, amount: 1, relays: [] })).toThrow(
      EventValidationError,
    );
    expect(() => makeZapRequest({ pubkey: keys.publicKey, amount: 1, relays: [] })).toThrow(
      /relays tag requires one or more URLs/,
    );
  });

  test("event zap: e, k, p from event.pubkey; no a on kind 1", () => {
    const event = EventBuilder.textNote("hi").signWithKeys(keys);
    const zr = makeZapRequest({
      event,
      amount: 1000,
      relays: ["wss://r.example"],
    });

    expect(zr.kind).toBe(Kind.ZapRequest);
    expect(zr.content).toBe("");
    expect(zr.tags).toEqual([
      ["p", event.pubkey],
      ["amount", "1000"],
      ["relays", "wss://r.example"],
      ["e", event.id],
      ["k", "1"],
    ]);
  });

  test("replaceable event adds a tag kind:pubkey:", () => {
    const event = EventBuilder.metadata({ name: "alice" }).signWithKeys(keys);
    const zr = makeZapRequest({ event, amount: 21, relays: ["wss://r.example"] });
    expect(zr.tags).toContainEqual(["a", `0:${event.pubkey}:`]);
    expect(zr.tags).toContainEqual(["e", event.id]);
    expect(zr.tags).toContainEqual(["k", "0"]);
  });

  test("addressable event adds a tag kind:pubkey:d", () => {
    const event = new EventBuilder(Kind.LongFormContent, "article")
      .tag(["d", "hello"])
      .signWithKeys(keys);
    const zr = makeZapRequest({ event, amount: 21, relays: ["wss://r.example"] });
    expect(zr.tags).toContainEqual(["a", `${Kind.LongFormContent}:${event.pubkey}:hello`]);
    expect(zr.tags).toContainEqual(["e", event.id]);
    expect(zr.tags).toContainEqual(["k", String(Kind.LongFormContent)]);
  });

  test("addressable event without d throws", () => {
    const event = new EventBuilder(Kind.LongFormContent, "article").signWithKeys(keys);
    expect(() => makeZapRequest({ event, amount: 21, relays: ["wss://r.example"] })).toThrow(
      EventValidationError,
    );
    expect(() => makeZapRequest({ event, amount: 21, relays: ["wss://r.example"] })).toThrow(
      /d tag not found or is empty/,
    );
  });

  test("addressable event with empty d throws", () => {
    const event = new EventBuilder(Kind.LongFormContent, "article")
      .tag(["d", ""])
      .signWithKeys(keys);
    expect(() => makeZapRequest({ event, amount: 21, relays: ["wss://r.example"] })).toThrow(
      EventValidationError,
    );
    expect(() => makeZapRequest({ event, amount: 21, relays: ["wss://r.example"] })).toThrow(
      /d tag not found or is empty/,
    );
  });

  test("optional lnurl tag", () => {
    const lnurl =
      "lnurl1dp68gurn8ghj7um5v93kketj9ehx2amn9uh8wetvdskkkmn0wahz7mrww4excup0dajx2mrv92x9xp";
    const zr = makeZapRequest({
      pubkey: keys.publicKey,
      amount: 21000,
      relays: ["wss://r.example"],
      lnurl,
    });
    expect(zr.tags).toContainEqual(["lnurl", lnurl]);
  });
});

// NIP-57 Appendix E (nips/57.md). Full invoice — not a 90-char stub.
const APPENDIX_E_INVOICE =
  "lnbc10u1p3unwfusp5t9r3yymhpfqculx78u027lxspgxcr2n2987mx2j55nnfs95nxnzqpp5jmrh92pfld78spqs78v9euf2385t83uvpwk9ldrlvf6ch7tpascqhp5zvkrmemgth3tufcvflmzjzfvjt023nazlhljz2n9hattj4f8jq8qxqyjw5qcqpjrzjqtc4fc44feggv7065fqe5m4ytjarg3repr5j9el35xhmtfexc42yczarjuqqfzqqqqqqqqlgqqqqqqgq9q9qxpqysgq079nkq507a5tw7xgttmj4u990j7wfggtrasah5gd4ywfr2pjcn29383tphp4t48gquelz9z78p4cq7ml3nrrphw5w6eckhjwmhezhnqpy6gyf0";

const APPENDIX_E_DESCRIPTION =
  '{"pubkey":"97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322","content":"","id":"d9cc14d50fcb8c27539aacf776882942c1a11ea4472f8cdec1dea82fab66279d","created_at":1674164539,"sig":"77127f636577e9029276be060332ea565deaf89ff215a494ccff16ae3f757065e2bc59b2e8c113dd407917a010b3abd36c8d7ad84c0e3ab7dab3a0b0caa9835d","kind":9734,"tags":[["e","3624762a1274dd9636e0c552b53086d70bc88c165bc4dc0f9e836a1eaf86c3b8"],["p","32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"],["relays","wss://relay.damus.io","wss://nostr-relay.wlvs.space","wss://nostr.fmt.wiz.biz","wss://relay.nostr.bg","wss://nostr.oxtr.dev","wss://nostr.v0l.io","wss://brb.io","wss://nostr.bitcoiner.social","ws://monad.jb55.com:8080","wss://relay.snort.social"]]}';

const APPENDIX_E_PUBKEY = "9630f464cca6a5147aa8a35f0bcdd3ce485324e732fd39e09233b1d848238f31";
const APPENDIX_E_PREIMAGE = "5d006d2cf1e73c7148e7519a4c68adc81642ce0e25a432b2434c99f97344c15f";
const DUMMY_SIG = "0".repeat(128);

function appendixEReceipt(overrides?: { tags?: Tag[]; pubkey?: string }): Event {
  return {
    id: "67b48a14fb66c60c8f9070bdeb37afdfcc3d08ad01989460448e4081eddda446",
    pubkey: overrides?.pubkey ?? APPENDIX_E_PUBKEY,
    created_at: 1674164545,
    kind: Kind.Zap,
    tags: overrides?.tags ?? [
      ["p", "32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"],
      ["P", "97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"],
      ["e", "3624762a1274dd9636e0c552b53086d70bc88c165bc4dc0f9e836a1eaf86c3b8"],
      ["k", "1"],
      ["bolt11", APPENDIX_E_INVOICE],
      ["description", APPENDIX_E_DESCRIPTION],
      ["preimage", APPENDIX_E_PREIMAGE],
    ],
    content: "",
    sig: DUMMY_SIG,
  };
}

function taggedField(type: number, data: Uint8Array): number[] {
  const dataWords = bech32.toWords(data);
  return [type, (dataWords.length >> 5) & 31, dataWords.length & 31, ...dataWords];
}

function encodeBolt11(
  hrp: string,
  fields: { paymentHash?: Uint8Array; descriptionHash?: Uint8Array },
): string {
  const words = [0, 0, 0, 0, 0, 0, 0];
  if (fields.paymentHash) words.push(...taggedField(1, fields.paymentHash));
  if (fields.descriptionHash) words.push(...taggedField(23, fields.descriptionHash));
  return bech32.encode(hrp, words, false);
}

function signedZapRequest(opts?: { amount?: number }): { request: Event; json: string } {
  const payer = Keys.generate();
  const builder = new EventBuilder(Kind.ZapRequest, "")
    .tag(["p", keys.publicKey])
    .tag(["relays", "wss://r.example"]);
  if (opts?.amount !== undefined) builder.tag(["amount", String(opts.amount)]);
  const request = builder.signWithKeys(payer);
  return { request, json: JSON.stringify(request) };
}

function signedReceipt(provider: Keys, tags: Tag[]): Event {
  return new EventBuilder(Kind.Zap, "").tags(tags).signWithKeys(provider);
}

describe("parseBolt11", () => {
  test("Appendix E invoice: 1_000_000 msat (full string, not a 90-char stub)", () => {
    expect(APPENDIX_E_INVOICE.length).toBeGreaterThan(90);
    const fields = parseBolt11(APPENDIX_E_INVOICE);
    expect(fields?.amountMsats).toBe(1_000_000);
    expect(fields?.descriptionHash?.length).toBe(32);
    expect(fields?.paymentHash).toEqual(sha256(hexToBytes(APPENDIX_E_PREIMAGE)));
  });

  test("descriptionHash is sha256 of the description TAG STRING", () => {
    const tagHash = sha256(utf8Encoder.encode(APPENDIX_E_DESCRIPTION));
    const invoice = encodeBolt11("lnbc10u", { descriptionHash: tagHash });
    expect(parseBolt11(invoice)?.descriptionHash).toEqual(tagHash);
    expect(parseBolt11(invoice)?.amountMsats).toBe(1_000_000);
  });

  test("truncated bech32 returns undefined", () => {
    expect(parseBolt11(APPENDIX_E_INVOICE.slice(0, 90))).toBeUndefined();
    expect(parseBolt11("lnbc10u1")).toBeUndefined();
  });

  test("never throws", () => {
    expect(() => parseBolt11("")).not.toThrow();
    expect(() => parseBolt11("not-an-invoice")).not.toThrow();
    expect(parseBolt11("")).toBeUndefined();
  });
});

describe("parseZapRequestFromReceipt", () => {
  test("Appendix E description is kind 9734", () => {
    const request = parseZapRequestFromReceipt(appendixEReceipt());
    expect(request?.kind).toBe(Kind.ZapRequest);
    expect(request?.kind).toBe(9734);
    expect(request?.id).toBe("d9cc14d50fcb8c27539aacf776882942c1a11ea4472f8cdec1dea82fab66279d");
  });
});

describe("validateZapReceipt", () => {
  test("Appendix E with matching nostrPubkey is valid", () => {
    // Official example invoice `h` does not equal sha256(description tag) (nips#1705);
    // commit to the tag string so the Appendix E request still validates.
    const invoice = encodeBolt11("lnbc10u", {
      paymentHash: sha256(hexToBytes(APPENDIX_E_PREIMAGE)),
      descriptionHash: sha256(utf8Encoder.encode(APPENDIX_E_DESCRIPTION)),
    });
    const receipt = appendixEReceipt({
      tags: [
        ["p", "32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245"],
        ["P", "97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322"],
        ["e", "3624762a1274dd9636e0c552b53086d70bc88c165bc4dc0f9e836a1eaf86c3b8"],
        ["k", "1"],
        ["bolt11", invoice],
        ["description", APPENDIX_E_DESCRIPTION],
        ["preimage", APPENDIX_E_PREIMAGE],
      ],
    });
    const result = validateZapReceipt(receipt, { nostrPubkey: APPENDIX_E_PUBKEY });
    expect(result.valid).toBe(true);
    expect(result.request?.kind).toBe(9734);
    expect(result.amountMsats).toBe(1_000_000);
  });

  test("wrong nostrPubkey is invalid and does not throw", () => {
    expect(() =>
      validateZapReceipt(appendixEReceipt(), { nostrPubkey: keys.publicKey }),
    ).not.toThrow();
    const result = validateZapReceipt(appendixEReceipt(), { nostrPubkey: keys.publicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test("amount mismatch, hash mismatch, bad preimage, truncated bech32 are invalid", () => {
    const provider = Keys.generate();
    const matching = signedZapRequest({ amount: 1_000_000 });
    const mismatchedAmount = signedZapRequest({ amount: 21 });
    const preimage = hexToBytes(APPENDIX_E_PREIMAGE);
    const paymentHash = sha256(preimage);

    const matchingInvoice = encodeBolt11("lnbc10u", {
      paymentHash,
      descriptionHash: sha256(utf8Encoder.encode(matching.json)),
    });
    const valid = signedReceipt(provider, [
      ["p", matching.request.tags.find((t) => t[0] === "p")![1]!],
      ["bolt11", matchingInvoice],
      ["description", matching.json],
      ["preimage", APPENDIX_E_PREIMAGE],
    ]);
    expect(validateZapReceipt(valid, { nostrPubkey: provider.publicKey }).valid).toBe(true);

    const amountMismatchInvoice = encodeBolt11("lnbc10u", {
      paymentHash,
      descriptionHash: sha256(utf8Encoder.encode(mismatchedAmount.json)),
    });
    const amountMismatch = signedReceipt(provider, [
      ["bolt11", amountMismatchInvoice],
      ["description", mismatchedAmount.json],
    ]);
    expect(validateZapReceipt(amountMismatch, { nostrPubkey: provider.publicKey }).valid).toBe(
      false,
    );

    const tweaked = matching.json.replace('"content":""', '"content":"x"');
    const hashMismatch = signedReceipt(provider, [
      ["bolt11", matchingInvoice],
      ["description", tweaked],
    ]);
    expect(validateZapReceipt(hashMismatch, { nostrPubkey: provider.publicKey }).valid).toBe(false);
    expect(validateZapReceipt(appendixEReceipt(), { nostrPubkey: APPENDIX_E_PUBKEY }).valid).toBe(
      false,
    );

    const badPreimage = signedReceipt(provider, [
      ["bolt11", matchingInvoice],
      ["description", matching.json],
      ["preimage", "00".repeat(32)],
    ]);
    expect(validateZapReceipt(badPreimage, { nostrPubkey: provider.publicKey }).valid).toBe(false);

    const truncated = signedReceipt(provider, [
      ["bolt11", APPENDIX_E_INVOICE.slice(0, 90)],
      ["description", matching.json],
    ]);
    expect(validateZapReceipt(truncated, { nostrPubkey: provider.publicKey }).valid).toBe(false);
  });

  test("never throws on garbage", () => {
    const garbage = {
      kind: 1,
      tags: [],
      content: "",
      created_at: 0,
      pubkey: "aa",
      id: "bb",
      sig: "cc",
    };
    expect(() =>
      validateZapReceipt(garbage as Event, { nostrPubkey: APPENDIX_E_PUBKEY }),
    ).not.toThrow();
    expect(validateZapReceipt(garbage as Event, { nostrPubkey: APPENDIX_E_PUBKEY }).valid).toBe(
      false,
    );
  });
});
