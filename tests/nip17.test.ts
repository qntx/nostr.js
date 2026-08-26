import { describe, expect, test } from "vite-plus/test";
import { Kind, Keys, KeysSigner, normalizeURL, type Tag } from "../src/index.ts";
import {
  Nip17Error,
  buildChatMessageRumor,
  dmRelayListToTags,
  normalizeRecipients,
  requireDmRelays,
  wrapDirectMessage,
} from "../src/nips/nip17.ts";
import { unwrap, type SealOptions, type WrapOptions } from "../src/nips/nip59.ts";

const ALICE_SK = "000000000000000000000000000000000000000000000000000000000000a1ce";
const BOB_SK = "00000000000000000000000000000000000000000000000000000000000000b0";
const CAROL_SK = "0000000000000000000000000000000000000000000000000000000000000ca8";

describe("nip17 chat helpers", () => {
  test("buildChatMessageRumor writes p tags, subject, and unmarked reply e-tag", () => {
    const alice = Keys.fromSecretKey(ALICE_SK);
    const bob = Keys.fromSecretKey(BOB_SK);
    const replyId = "aa".repeat(32);
    const rumor = buildChatMessageRumor(
      alice.publicKey,
      [{ pubkey: bob.publicKey, relayHint: "wss://hint.example" }],
      "hola",
      { subject: "party", replyTo: { id: replyId }, created_at: 42 },
    );
    expect(rumor.kind).toBe(Kind.PrivateDirectMessage);
    expect(rumor.content).toBe("hola");
    expect(rumor.created_at).toBe(42);
    expect(rumor.tags).toEqual([
      ["p", bob.publicKey, "wss://hint.example"],
      ["e", replyId, ""],
      ["subject", "party"],
    ]);
  });

  test("empty recipients throw Nip17Error", () => {
    const alice = Keys.fromSecretKey(ALICE_SK);
    expect(() => buildChatMessageRumor(alice.publicKey, [], "x")).toThrow(Nip17Error);
    expect(() => buildChatMessageRumor(alice.publicKey, [], "x")).toThrow(/must not be empty/);
  });

  test("normalizeRecipients lowercases, preserves order, and dedups", () => {
    const bob = Keys.fromSecretKey(BOB_SK);
    const carol = Keys.fromSecretKey(CAROL_SK);
    const list = normalizeRecipients([
      bob.publicKey.toUpperCase(),
      { pubkey: carol.publicKey, relayHint: "wss://c.example" },
      bob.publicKey,
    ]);
    expect(list).toEqual([
      { pubkey: bob.publicKey, relayHint: undefined },
      { pubkey: carol.publicKey, relayHint: "wss://c.example" },
    ]);
  });

  test("wrapDirectMessage produces 1+N wraps and each party decrypts only theirs", async () => {
    const alice = new KeysSigner(ALICE_SK);
    const bob = new KeysSigner(BOB_SK);
    const carol = new KeysSigner(CAROL_SK);
    const alicePk = await alice.getPublicKey();
    const bobPk = await bob.getPublicKey();
    const carolPk = await carol.getPublicKey();
    const recipients = normalizeRecipients([bobPk, carolPk]);
    const rumor = buildChatMessageRumor(alicePk, recipients, "group");
    const wraps = await wrapDirectMessage(alice, recipients, rumor);
    expect(wraps.map((w) => w.recipient)).toEqual([alicePk, bobPk, carolPk]);

    const self = await unwrap(alice, wraps[0]!.wrap);
    expect(self.content).toBe("group");
    expect(self.id).toBe(rumor.id);

    const toBob = await unwrap(bob, wraps[1]!.wrap);
    expect(toBob.content).toBe("group");
    await expect(unwrap(bob, wraps[2]!.wrap)).rejects.toThrow(/failed to decrypt/);

    const toCarol = await unwrap(carol, wraps[2]!.wrap);
    expect(toCarol.content).toBe("group");
  });

  test("wrapDirectMessage count is N when sender is already a recipient", async () => {
    const alice = new KeysSigner(ALICE_SK);
    const bob = new KeysSigner(BOB_SK);
    const alicePk = await alice.getPublicKey();
    const bobPk = await bob.getPublicKey();
    const recipients = normalizeRecipients([alicePk, bobPk]);
    const rumor = buildChatMessageRumor(alicePk, recipients, "self listed");
    const wraps = await wrapDirectMessage(alice, recipients, rumor);
    expect(wraps).toHaveLength(2);
    expect(wraps.map((w) => w.recipient)).toEqual([alicePk, bobPk]);
  });

  test("wrapDirectMessage does not take extraTags or encryptTo", async () => {
    const alice = new KeysSigner(ALICE_SK);
    const bob = new KeysSigner(BOB_SK);
    const alicePk = await alice.getPublicKey();
    const bobPk = await bob.getPublicKey();
    const recipients = normalizeRecipients([bobPk]);
    const rumor = buildChatMessageRumor(alicePk, recipients, "x");

    type Opts = NonNullable<Parameters<typeof wrapDirectMessage>[3]>;
    const noExtraTags: "extraTags" extends keyof Opts ? never : true = true;
    const noEncryptTo: "encryptTo" extends keyof Opts ? never : true = true;
    const wrapKeepsExtraTags: "extraTags" extends keyof WrapOptions ? true : never = true;
    const wrapDropsEncryptTo: "encryptTo" extends keyof WrapOptions ? never : true = true;
    const sealDropsExtraTags: "extraTags" extends keyof SealOptions ? never : true = true;
    const sealDropsEncryptTo: "encryptTo" extends keyof SealOptions ? never : true = true;
    expect(noExtraTags).toBe(true);
    expect(noEncryptTo).toBe(true);
    expect(wrapKeepsExtraTags).toBe(true);
    expect(wrapDropsEncryptTo).toBe(true);
    expect(sealDropsExtraTags).toBe(true);
    expect(sealDropsEncryptTo).toBe(true);

    const wraps = await wrapDirectMessage(alice, recipients, rumor, {
      extraTags: [["n", "nope"]],
      encryptTo: alicePk,
      randomize: "wrap",
    } as never);
    expect(wraps.map((w) => w.wrap.tags)).toEqual([[["p", alicePk]], [["p", bobPk]]]);
    const bobWrap = wraps[1]!.wrap;
    const sealJson = await bob.nip44Decrypt!(bobWrap.pubkey, bobWrap.content);
    const seal = JSON.parse(sealJson) as { tags: unknown; created_at: number };
    expect(seal.tags).toEqual([]);
    expect(seal.created_at).toBe(rumor.created_at);
    const toBob = await unwrap(bob, bobWrap);
    expect(toBob.content).toBe("x");
  });

  test("dmRelayListToTags emits relay tags without assertion", () => {
    const url = "wss://inbox.example";
    const tags: Tag[] = dmRelayListToTags([url, `${url}/`]);
    expect(tags).toEqual([["relay", normalizeURL(url)]]);
  });

  test("requireDmRelays throws on empty list", () => {
    const pk = Keys.fromSecretKey(ALICE_SK).publicKey;
    expect(() => requireDmRelays(pk, [])).toThrow(Nip17Error);
    expect(() => requireDmRelays(pk, [])).toThrow(/not ready/);
  });
});
