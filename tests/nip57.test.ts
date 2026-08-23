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
    const event = new EventBuilder(30023, "article").tag(["d", "hello"]).signWithKeys(keys);
    const zr = makeZapRequest({ event, amount: 21, relays: ["wss://r.example"] });
    expect(zr.tags).toContainEqual(["a", `30023:${event.pubkey}:hello`]);
    expect(zr.tags).toContainEqual(["e", event.id]);
    expect(zr.tags).toContainEqual(["k", "30023"]);
  });

  test("addressable event without d throws", () => {
    const event = new EventBuilder(30023, "article").signWithKeys(keys);
    expect(() => makeZapRequest({ event, amount: 21, relays: ["wss://r.example"] })).toThrow(
      EventValidationError,
    );
    expect(() => makeZapRequest({ event, amount: 21, relays: ["wss://r.example"] })).toThrow(
      /d tag not found or is empty/,
    );
  });

  test("addressable event with empty d throws", () => {
    const event = new EventBuilder(30023, "article").tag(["d", ""]).signWithKeys(keys);
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

const APPENDIX_E_PREIMAGE = "5d006d2cf1e73c7148e7519a4c68adc81642ce0e25a432b2434c99f97344c15f";
const LNURL =
  "lnurl1dp68gurn8ghj7um5v93kketj9ehx2amn9uh8wetvdskkkmn0wahz7mrww4excup0dajx2mrv92x9xp";

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
  // BOLT11 data part ends with 104 5-bit words of secp256k1 signature.
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32.encode(hrp, words, false);
}

function signedZapRequest(opts?: { amount?: number; lnurl?: string; extraTags?: Tag[] }): {
  request: Event;
  json: string;
} {
  const payer = Keys.generate();
  const builder = new EventBuilder(Kind.ZapRequest, "")
    .tag(["p", keys.publicKey])
    .tag(["relays", "wss://r.example"]);
  if (opts?.amount !== undefined) builder.tag(["amount", String(opts.amount)]);
  if (opts?.lnurl !== undefined) builder.tag(["lnurl", opts.lnurl]);
  if (opts?.extraTags) builder.tags(opts.extraTags);
  const request = builder.signWithKeys(payer);
  return { request, json: JSON.stringify(request) };
}

function signedReceipt(provider: Keys, tags: Tag[]): Event {
  return new EventBuilder(Kind.Zap, "").tags(tags).signWithKeys(provider);
}

function receiptFor(
  provider: Keys,
  request: Event,
  json: string,
  extra?: { invoice?: string; preimage?: string; extraTags?: Tag[] },
): Event {
  const paymentHash = sha256(hexToBytes(APPENDIX_E_PREIMAGE));
  const invoice =
    extra?.invoice ??
    encodeBolt11("lnbc10u", {
      paymentHash,
      descriptionHash: sha256(utf8Encoder.encode(json)),
    });
  const tags: Tag[] = [
    ["p", request.tags.find((t) => t[0] === "p")![1]!],
    ["bolt11", invoice],
    ["description", json],
  ];
  if (extra?.preimage !== undefined) tags.push(["preimage", extra.preimage]);
  else tags.push(["preimage", APPENDIX_E_PREIMAGE]);
  if (extra?.extraTags) tags.push(...extra.extraTags);
  return signedReceipt(provider, tags);
}

describe("parseBolt11", () => {
  test("Appendix E invoice: 1_000_000 msat and payment hash (full string, not a 90-char stub)", () => {
    expect(APPENDIX_E_INVOICE.length).toBeGreaterThan(90);
    const fields = parseBolt11(APPENDIX_E_INVOICE);
    expect(fields?.amountMsats).toBe(1_000_000);
    expect(fields?.descriptionHash?.length).toBe(32);
    expect(fields?.paymentHash).toEqual(sha256(hexToBytes(APPENDIX_E_PREIMAGE)));
  });

  test("descriptionHash is sha256 of the description TAG STRING", () => {
    const tagHash = sha256(utf8Encoder.encode(APPENDIX_E_DESCRIPTION));
    const paymentHash = sha256(hexToBytes(APPENDIX_E_PREIMAGE));
    const invoice = encodeBolt11("lnbc10u", { paymentHash, descriptionHash: tagHash });
    const fields = parseBolt11(invoice);
    expect(fields?.descriptionHash).toEqual(tagHash);
    expect(fields?.amountMsats).toBe(1_000_000);
    expect(fields?.paymentHash).toEqual(paymentHash);
  });

  test("truncated bech32 returns undefined", () => {
    expect(parseBolt11(APPENDIX_E_INVOICE.slice(0, 90))).toBeUndefined();
    expect(parseBolt11("lnbc10u1")).toBeUndefined();
  });

  test("checksum-valid stub without payment hash returns undefined", () => {
    const stub = encodeBolt11("lnbc10u", {});
    expect(stub.length).toBeGreaterThan(8);
    expect(parseBolt11(stub)).toBeUndefined();
    expect(parseBolt11(bech32.encode("lnbc", [0, 0, 0, 0, 0, 0, 0], false))).toBeUndefined();
  });

  test("never throws", () => {
    expect(() => parseBolt11("")).not.toThrow();
    expect(() => parseBolt11("not-an-invoice")).not.toThrow();
    expect(parseBolt11("")).toBeUndefined();
  });
});

describe("parseZapRequestFromReceipt", () => {
  test("signed kind 9734 description round-trips", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 1_000_000 });
    const parsed = parseZapRequestFromReceipt(receiptFor(provider, request, json));
    expect(parsed?.kind).toBe(Kind.ZapRequest);
    expect(parsed?.kind).toBe(9734);
    expect(parsed?.id).toBe(request.id);
    expect(parsed?.sig).toBe(request.sig);
  });

  test("official Appendix E description fails verifyEvent", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest();
    const receipt = receiptFor(provider, request, json, { invoice: APPENDIX_E_INVOICE });
    const forged: Event = {
      ...receipt,
      tags: receipt.tags.map((t) =>
        t[0] === "description" ? ["description", APPENDIX_E_DESCRIPTION] : t,
      ),
    };
    expect(parseZapRequestFromReceipt(forged)).toBeUndefined();
  });
});

describe("validateZapReceipt", () => {
  test("matching nostrPubkey is valid", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 1_000_000 });
    const receipt = receiptFor(provider, request, json);
    const result = validateZapReceipt(receipt, { nostrPubkey: provider.publicKey });
    expect(result.valid).toBe(true);
    expect(result.request?.kind).toBe(9734);
    expect(result.request?.id).toBe(request.id);
    expect(result.amountMsats).toBe(1_000_000);
  });

  test("wrong nostrPubkey is invalid and does not throw", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 1_000_000 });
    const receipt = receiptFor(provider, request, json);
    expect(() => validateZapReceipt(receipt, { nostrPubkey: keys.publicKey })).not.toThrow();
    const result = validateZapReceipt(receipt, { nostrPubkey: keys.publicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("pubkey mismatch");
  });

  test("amount mismatch", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 21 });
    const receipt = receiptFor(provider, request, json);
    const result = validateZapReceipt(receipt, { nostrPubkey: provider.publicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("amount mismatch");
  });

  test("description hash mismatch uses official Appendix E invoice", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 1_000_000 });
    const receipt = receiptFor(provider, request, json, { invoice: APPENDIX_E_INVOICE });
    const result = validateZapReceipt(receipt, { nostrPubkey: provider.publicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("description hash mismatch");
  });

  test("bad preimage", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 1_000_000 });
    const receipt = receiptFor(provider, request, json, { preimage: "00".repeat(32) });
    const result = validateZapReceipt(receipt, { nostrPubkey: provider.publicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("preimage mismatch");
  });

  test("truncated bech32", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 1_000_000 });
    const receipt = receiptFor(provider, request, json, {
      invoice: APPENDIX_E_INVOICE.slice(0, 90),
    });
    const result = validateZapReceipt(receipt, { nostrPubkey: provider.publicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid bolt11");
  });

  test("lnurl mismatch", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 1_000_000, lnurl: LNURL });
    const receipt = receiptFor(provider, request, json);
    const result = validateZapReceipt(receipt, {
      nostrPubkey: provider.publicKey,
      lnurl: "other",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("lnurl mismatch");
  });

  test("checksum-valid stub without p/h is invalid bolt11", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 1_000_000 });
    const stub = encodeBolt11("lnbc10u", {});
    const receipt = receiptFor(provider, request, json, { invoice: stub });
    const result = validateZapReceipt(receipt, { nostrPubkey: provider.publicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid bolt11");
  });

  test("9734 with two p tags or missing relays is invalid", () => {
    const provider = Keys.generate();
    const twoP = signedZapRequest({
      amount: 1_000_000,
      extraTags: [["p", keys.publicKey]],
    });
    const twoPResult = validateZapReceipt(receiptFor(provider, twoP.request, twoP.json), {
      nostrPubkey: provider.publicKey,
    });
    expect(twoPResult.valid).toBe(false);
    expect(twoPResult.reason).toBe("invalid p count");

    const twoE = signedZapRequest({
      amount: 1_000_000,
      extraTags: [
        ["e", "11".repeat(32)],
        ["e", "22".repeat(32)],
      ],
    });
    const twoEResult = validateZapReceipt(receiptFor(provider, twoE.request, twoE.json), {
      nostrPubkey: provider.publicKey,
    });
    expect(twoEResult.valid).toBe(false);
    expect(twoEResult.reason).toBe("too many e tags");

    const payer = Keys.generate();
    const noRelays = new EventBuilder(Kind.ZapRequest, "")
      .tag(["p", keys.publicKey])
      .tag(["amount", "1000000"])
      .signWithKeys(payer);
    const noRelaysJson = JSON.stringify(noRelays);
    const noRelaysResult = validateZapReceipt(receiptFor(provider, noRelays, noRelaysJson), {
      nostrPubkey: provider.publicKey,
    });
    expect(noRelaysResult.valid).toBe(false);
    expect(noRelaysResult.reason).toBe("missing relays");
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
      validateZapReceipt(garbage as Event, { nostrPubkey: keys.publicKey }),
    ).not.toThrow();
    expect(validateZapReceipt(garbage as Event, { nostrPubkey: keys.publicKey }).valid).toBe(false);
    expect(validateZapReceipt(garbage as Event, { nostrPubkey: keys.publicKey }).reason).toBe(
      "invalid receipt",
    );
  });

  test("D.7: a must be a valid event coordinate", () => {
    const provider = Keys.generate();
    const coord = `30023:${keys.publicKey}:hello`;
    const valid = signedZapRequest({ amount: 1_000_000, extraTags: [["a", coord]] });
    const validResult = validateZapReceipt(
      receiptFor(provider, valid.request, valid.json, { extraTags: [["a", coord]] }),
      { nostrPubkey: provider.publicKey },
    );
    expect(validResult.valid).toBe(true);

    const replaceable = `0:${keys.publicKey}:`;
    const replaceableReq = signedZapRequest({
      amount: 1_000_000,
      extraTags: [["a", replaceable]],
    });
    expect(
      validateZapReceipt(
        receiptFor(provider, replaceableReq.request, replaceableReq.json, {
          extraTags: [["a", replaceable]],
        }),
        { nostrPubkey: provider.publicKey },
      ).valid,
    ).toBe(true);

    const nested = `30023:${keys.publicKey}:hello:world`;
    const nestedReq = signedZapRequest({ amount: 1_000_000, extraTags: [["a", nested]] });
    expect(
      validateZapReceipt(
        receiptFor(provider, nestedReq.request, nestedReq.json, { extraTags: [["a", nested]] }),
        { nostrPubkey: provider.publicKey },
      ).valid,
    ).toBe(true);

    const invalids: Tag[][] = [
      [["a", "not-a-coordinate"]],
      [["a", ""]],
      [["a"]],
      [["a", "0:short:"]],
      [["a", `30023:${keys.publicKey}`]],
      [
        ["a", coord],
        ["a", "nope"],
      ],
    ];
    for (const extraTags of invalids) {
      const { request, json } = signedZapRequest({ amount: 1_000_000, extraTags });
      const receipt = receiptFor(provider, request, json);
      expect(() => validateZapReceipt(receipt, { nostrPubkey: provider.publicKey })).not.toThrow();
      const result = validateZapReceipt(receipt, { nostrPubkey: provider.publicKey });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid a");
    }
  });

  test("D.8: request P is 0 or 1 and equals receipt pubkey", () => {
    const provider = Keys.generate();
    const none = signedZapRequest({ amount: 1_000_000 });
    expect(
      validateZapReceipt(receiptFor(provider, none.request, none.json), {
        nostrPubkey: provider.publicKey,
      }).valid,
    ).toBe(true);

    const matching = signedZapRequest({
      amount: 1_000_000,
      extraTags: [["P", provider.publicKey]],
    });
    expect(
      validateZapReceipt(receiptFor(provider, matching.request, matching.json), {
        nostrPubkey: provider.publicKey,
      }).valid,
    ).toBe(true);

    const mixedCase = signedZapRequest({
      amount: 1_000_000,
      extraTags: [["P", provider.publicKey.toUpperCase()]],
    });
    expect(
      validateZapReceipt(receiptFor(provider, mixedCase.request, mixedCase.json), {
        nostrPubkey: provider.publicKey,
      }).valid,
    ).toBe(true);

    const wrong = signedZapRequest({
      amount: 1_000_000,
      extraTags: [["P", keys.publicKey]],
    });
    const wrongReceipt = receiptFor(provider, wrong.request, wrong.json);
    expect(() =>
      validateZapReceipt(wrongReceipt, { nostrPubkey: provider.publicKey }),
    ).not.toThrow();
    const wrongResult = validateZapReceipt(wrongReceipt, { nostrPubkey: provider.publicKey });
    expect(wrongResult.valid).toBe(false);
    expect(wrongResult.reason).toBe("request P mismatch");

    const emptyValue = signedZapRequest({ amount: 1_000_000, extraTags: [["P", ""]] });
    expect(
      validateZapReceipt(receiptFor(provider, emptyValue.request, emptyValue.json), {
        nostrPubkey: provider.publicKey,
      }).reason,
    ).toBe("request P mismatch");

    const nameless = signedZapRequest({ amount: 1_000_000, extraTags: [["P"]] });
    expect(
      validateZapReceipt(receiptFor(provider, nameless.request, nameless.json), {
        nostrPubkey: provider.publicKey,
      }).reason,
    ).toBe("request P mismatch");

    const twoP = signedZapRequest({
      amount: 1_000_000,
      extraTags: [
        ["P", provider.publicKey],
        ["P", provider.publicKey],
      ],
    });
    const twoPReceipt = receiptFor(provider, twoP.request, twoP.json);
    expect(() =>
      validateZapReceipt(twoPReceipt, { nostrPubkey: provider.publicKey }),
    ).not.toThrow();
    const twoPResult = validateZapReceipt(twoPReceipt, { nostrPubkey: provider.publicKey });
    expect(twoPResult.valid).toBe(false);
    expect(twoPResult.reason).toBe("too many P tags");
  });

  test("E: receipt copies request p, e, and a", () => {
    const provider = Keys.generate();
    const eventId = "11".repeat(32);
    const coord = `30023:${keys.publicKey}:hello`;
    const copied = signedZapRequest({
      amount: 1_000_000,
      extraTags: [
        ["e", eventId],
        ["a", coord],
      ],
    });
    expect(
      validateZapReceipt(
        receiptFor(provider, copied.request, copied.json, {
          extraTags: [
            ["e", eventId],
            ["a", coord],
          ],
        }),
        { nostrPubkey: provider.publicKey },
      ).valid,
    ).toBe(true);

    const aWithHint = signedZapRequest({ amount: 1_000_000, extraTags: [["a", coord]] });
    expect(
      validateZapReceipt(
        receiptFor(provider, aWithHint.request, aWithHint.json, {
          extraTags: [["a", coord, "wss://r.example"]],
        }),
        { nostrPubkey: provider.publicKey },
      ).valid,
    ).toBe(true);

    const missingP = signedZapRequest({ amount: 1_000_000 });
    const missingPBase = receiptFor(provider, missingP.request, missingP.json);
    const missingPReceipt = signedReceipt(
      provider,
      missingPBase.tags.filter((t) => t[0] !== "p"),
    );
    expect(() =>
      validateZapReceipt(missingPReceipt, { nostrPubkey: provider.publicKey }),
    ).not.toThrow();
    const missingPResult = validateZapReceipt(missingPReceipt, {
      nostrPubkey: provider.publicKey,
    });
    expect(missingPResult.valid).toBe(false);
    expect(missingPResult.reason).toBe("missing p");

    const wrongP = signedZapRequest({ amount: 1_000_000 });
    const wrongPBase = receiptFor(provider, wrongP.request, wrongP.json);
    const wrongPReceipt = signedReceipt(
      provider,
      wrongPBase.tags.map((t) => (t[0] === "p" ? (["p", provider.publicKey] as Tag) : t)),
    );
    expect(validateZapReceipt(wrongPReceipt, { nostrPubkey: provider.publicKey }).reason).toBe(
      "missing p",
    );

    const withE = signedZapRequest({ amount: 1_000_000, extraTags: [["e", eventId]] });
    const missingE = receiptFor(provider, withE.request, withE.json);
    expect(() => validateZapReceipt(missingE, { nostrPubkey: provider.publicKey })).not.toThrow();
    const missingEResult = validateZapReceipt(missingE, { nostrPubkey: provider.publicKey });
    expect(missingEResult.valid).toBe(false);
    expect(missingEResult.reason).toBe("missing e");

    const wrongE = receiptFor(provider, withE.request, withE.json, {
      extraTags: [["e", "22".repeat(32)]],
    });
    expect(validateZapReceipt(wrongE, { nostrPubkey: provider.publicKey }).reason).toBe(
      "missing e",
    );

    const withA = signedZapRequest({ amount: 1_000_000, extraTags: [["a", coord]] });
    const missingA = receiptFor(provider, withA.request, withA.json);
    expect(() => validateZapReceipt(missingA, { nostrPubkey: provider.publicKey })).not.toThrow();
    const missingAResult = validateZapReceipt(missingA, { nostrPubkey: provider.publicKey });
    expect(missingAResult.valid).toBe(false);
    expect(missingAResult.reason).toBe("missing a");

    const wrongA = receiptFor(provider, withA.request, withA.json, {
      extraTags: [["a", `30023:${keys.publicKey}:other`]],
    });
    expect(validateZapReceipt(wrongA, { nostrPubkey: provider.publicKey }).reason).toBe(
      "missing a",
    );

    const twoA = signedZapRequest({
      amount: 1_000_000,
      extraTags: [
        ["a", coord],
        ["a", `0:${keys.publicKey}:`],
      ],
    });
    const twoAPartial = receiptFor(provider, twoA.request, twoA.json, {
      extraTags: [["a", coord]],
    });
    expect(validateZapReceipt(twoAPartial, { nostrPubkey: provider.publicKey }).reason).toBe(
      "missing a",
    );
  });

  test("E: receipt P is the zap sender, not request tag P", () => {
    const provider = Keys.generate();
    const { request, json } = signedZapRequest({ amount: 1_000_000 });
    const appendixE = receiptFor(provider, request, json, {
      extraTags: [["P", request.pubkey]],
    });
    const appendixEResult = validateZapReceipt(appendixE, { nostrPubkey: provider.publicKey });
    expect(appendixEResult.valid).toBe(true);

    const mixedCase = receiptFor(provider, request, json, {
      extraTags: [["P", request.pubkey.toUpperCase()]],
    });
    expect(validateZapReceipt(mixedCase, { nostrPubkey: provider.publicKey }).valid).toBe(true);

    const both = signedZapRequest({
      amount: 1_000_000,
      extraTags: [["P", provider.publicKey]],
    });
    expect(
      validateZapReceipt(
        receiptFor(provider, both.request, both.json, { extraTags: [["P", both.request.pubkey]] }),
        { nostrPubkey: provider.publicKey },
      ).valid,
    ).toBe(true);

    const copiedRequestP = signedZapRequest({
      amount: 1_000_000,
      extraTags: [["P", provider.publicKey]],
    });
    const copiedReceipt = receiptFor(provider, copiedRequestP.request, copiedRequestP.json, {
      extraTags: [["P", provider.publicKey]],
    });
    expect(() =>
      validateZapReceipt(copiedReceipt, { nostrPubkey: provider.publicKey }),
    ).not.toThrow();
    const copiedResult = validateZapReceipt(copiedReceipt, { nostrPubkey: provider.publicKey });
    expect(copiedResult.valid).toBe(false);
    expect(copiedResult.reason).toBe("receipt P mismatch");

    const wrongSender = receiptFor(provider, request, json, {
      extraTags: [["P", keys.publicKey]],
    });
    expect(validateZapReceipt(wrongSender, { nostrPubkey: provider.publicKey }).reason).toBe(
      "receipt P mismatch",
    );

    const emptyP = receiptFor(provider, request, json, { extraTags: [["P", ""]] });
    expect(validateZapReceipt(emptyP, { nostrPubkey: provider.publicKey }).reason).toBe(
      "receipt P mismatch",
    );

    const namelessP = receiptFor(provider, request, json, { extraTags: [["P"]] });
    expect(validateZapReceipt(namelessP, { nostrPubkey: provider.publicKey }).reason).toBe(
      "receipt P mismatch",
    );
  });
});
