import { describe, expect, test } from "vite-plus/test";
import {
  Kind,
  Keys,
  KeysSigner,
  TWO_DAYS_SECS,
  createGiftWrap,
  createRumor,
  createSeal,
  eventToJson,
  finalizeEvent,
  isGiftWrapKind,
  randomPastTimestamp,
  unwrapGift,
  wrapGift,
} from "../src/index.ts";
import { encryptToPubkey } from "../src/nips/nip44.ts";
import { verifyEvent } from "../src/core/key.ts";

const ALICE_SK = "000000000000000000000000000000000000000000000000000000000000a1ce";
const BOB_SK = "00000000000000000000000000000000000000000000000000000000000000b0";
const MALLORY_SK = "0000000000000000000000000000000000000000000000000000000000000bad";

function pair() {
  const alice = new KeysSigner(ALICE_SK);
  const bob = new KeysSigner(BOB_SK);
  return {
    alice,
    bob,
    aliceKeys: Keys.fromSecretKey(ALICE_SK),
    bobKeys: Keys.fromSecretKey(BOB_SK),
  };
}

describe("nip59", () => {
  test("createRumor sets pubkey, id, and has no sig", () => {
    const { aliceKeys } = pair();
    const rumor = createRumor(aliceKeys.publicKey, {
      kind: Kind.PrivateDirectMessage,
      content: "hi",
      created_at: 1_700_000_000,
    });
    expect(rumor.pubkey).toBe(aliceKeys.publicKey);
    expect(rumor.id).toHaveLength(64);
    expect(rumor.kind).toBe(Kind.PrivateDirectMessage);
    expect("sig" in rumor).toBe(false);
  });

  test("wrap / unwrap round-trip", async () => {
    const { alice, bob, aliceKeys, bobKeys } = pair();
    const rumor = createRumor(aliceKeys.publicKey, {
      kind: Kind.PrivateDirectMessage,
      content: "secret hello",
      tags: [["p", bobKeys.publicKey]],
      created_at: 1_700_000_000,
    });
    const wrap = await wrapGift(alice, bobKeys.publicKey, rumor);
    expect(wrap.kind).toBe(Kind.GiftWrap);
    expect(wrap.pubkey).not.toBe(aliceKeys.publicKey);
    expect(wrap.pubkey).not.toBe(bobKeys.publicKey);
    expect(verifyEvent(wrap)).toBe(true);

    const inner = await unwrapGift(bob, wrap);
    expect(inner.content).toBe("secret hello");
    expect(inner.kind).toBe(Kind.PrivateDirectMessage);
    expect(inner.created_at).toBe(1_700_000_000);
    expect(inner.pubkey).toBe(aliceKeys.publicKey);
    expect(inner.tags).toEqual([["p", bobKeys.publicKey]]);
    expect(inner.id).toBe(rumor.id);
  });

  test("injected timestamps appear on seal and wrap", async () => {
    const { alice, bob, aliceKeys, bobKeys } = pair();
    const rumor = createRumor(aliceKeys.publicKey, {
      kind: 1,
      content: "timed",
      created_at: 1_700_000_000,
    });
    const timestamps = { seal: 1_699_900_000, wrap: 1_699_800_000 };
    const wrap = await wrapGift(alice, bobKeys.publicKey, rumor, { timestamps });
    expect(wrap.created_at).toBe(timestamps.wrap);

    const sealJson = await bob.nip44Decrypt!(wrap.pubkey, wrap.content);
    const seal = JSON.parse(sealJson) as { created_at: number; kind: number };
    expect(seal.kind).toBe(Kind.Seal);
    expect(seal.created_at).toBe(timestamps.seal);
  });

  test("randomPastTimestamp is deterministic with stub rng", () => {
    expect(randomPastTimestamp({ now: 1000, randomInt: () => 0 })).toBe(1000);
    expect(randomPastTimestamp({ now: 1000, randomInt: () => TWO_DAYS_SECS - 1 })).toBe(
      1000 - (TWO_DAYS_SECS - 1),
    );
  });

  test("unwrap of a non-gift-wrap throws", async () => {
    const { bob, aliceKeys } = pair();
    const note = finalizeEvent(
      { kind: Kind.TextNote, content: "nope", tags: [], created_at: 1 },
      aliceKeys.secretKey,
    );
    await expect(unwrapGift(bob, note)).rejects.toThrow(/expected gift wrap/);
  });

  test("wrong recipient cannot unwrap", async () => {
    const { alice, aliceKeys, bobKeys } = pair();
    const mallory = new KeysSigner(MALLORY_SK);
    const rumor = createRumor(aliceKeys.publicKey, { kind: 14, content: "x" });
    const wrap = await wrapGift(alice, bobKeys.publicKey, rumor);
    await expect(unwrapGift(mallory, wrap)).rejects.toThrow(/failed to decrypt/);
  });

  test("Mallory cannot impersonate Alice by rewriting rumor pubkey", async () => {
    const { bob, aliceKeys, bobKeys } = pair();
    const mallory = new KeysSigner(MALLORY_SK);
    const forged = createRumor(aliceKeys.publicKey, { kind: 14, content: "i am alice" });
    const wrap = await wrapGift(mallory, bobKeys.publicKey, forged);
    await expect(unwrapGift(bob, wrap)).rejects.toThrow(/seal pubkey does not match rumor pubkey/);
  });

  test("tampered seal signature is rejected", async () => {
    const { alice, bob, aliceKeys, bobKeys } = pair();
    const rumor = createRumor(aliceKeys.publicKey, { kind: 14, content: "x" });
    const seal = await createSeal(alice, bobKeys.publicKey, rumor);
    const badSeal = { ...seal, sig: "00".repeat(64) };
    const wrap = createGiftWrap(badSeal, bobKeys.publicKey);
    await expect(unwrapGift(bob, wrap)).rejects.toThrow(/seal signature/);
  });

  test("rumor carrying a sig is rejected", async () => {
    const { alice, bob, aliceKeys, bobKeys } = pair();
    const rumor = createRumor(aliceKeys.publicKey, { kind: 14, content: "x" });
    const signed = { ...rumor, sig: "11".repeat(64) };
    const content = await alice.nip44Encrypt!(bobKeys.publicKey, JSON.stringify(signed));
    const seal = await alice.signEvent({
      kind: Kind.Seal,
      content,
      created_at: 1,
      tags: [],
      pubkey: aliceKeys.publicKey,
    });
    const wrap = createGiftWrap(seal, bobKeys.publicKey);
    await expect(unwrapGift(bob, wrap)).rejects.toThrow(/rumor must be unsigned/);
  });

  test("createGiftWrap uses an ephemeral pubkey and kind 1059", () => {
    const { aliceKeys, bobKeys } = pair();
    const seal = finalizeEvent(
      { kind: Kind.Seal, content: "cipher", tags: [], created_at: 1 },
      aliceKeys.secretKey,
    );
    const wrap = createGiftWrap(seal, bobKeys.publicKey);
    expect(wrap.kind).toBe(Kind.GiftWrap);
    expect(isGiftWrapKind(wrap.kind)).toBe(true);
    expect(wrap.pubkey).not.toBe(aliceKeys.publicKey);
    expect(wrap.pubkey).not.toBe(bobKeys.publicKey);
  });

  test("unwrap accepts kind 21059", async () => {
    const { alice, bob, aliceKeys, bobKeys } = pair();
    const rumor = createRumor(aliceKeys.publicKey, { kind: 14, content: "ephemeral" });
    const seal = await createSeal(alice, bobKeys.publicKey, rumor);
    const ephemeral = Keys.generate();
    const wrap = finalizeEvent(
      {
        kind: Kind.GiftWrapEphemeral,
        content: encryptToPubkey(eventToJson(seal), ephemeral.secretKey.bytes, bobKeys.publicKey),
        created_at: 1,
        tags: [["p", bobKeys.publicKey]],
      },
      ephemeral.secretKey,
    );
    const inner = await unwrapGift(bob, wrap);
    expect(inner.content).toBe("ephemeral");
  });

  test("unwrap NIP-59 spec example wrap", async () => {
    const recipient = new KeysSigner(
      "e108399bd8424357a710b606ae0c13166d853d327e47a6e5e038197346bdbf45",
    );
    const wrap = {
      content:
        "AhC3Qj/QsKJFWuf6xroiYip+2yK95qPwJjVvFujhzSguJWb/6TlPpBW0CGFwfufCs2Zyb0JeuLmZhNlnqecAAalC4ZCugB+I9ViA5pxLyFfQjs1lcE6KdX3euCHBLAnE9GL/+IzdV9vZnfJH6atVjvBkNPNzxU+OLCHO/DAPmzmMVx0SR63frRTCz6Cuth40D+VzluKu1/Fg2Q1LSst65DE7o2efTtZ4Z9j15rQAOZfE9jwMCQZt27rBBK3yVwqVEriFpg2mHXc1DDwHhDADO8eiyOTWF1ghDds/DxhMcjkIi/o+FS3gG1dG7gJHu3KkGK5UXpmgyFKt+421m5o++RMD/BylS3iazS1S93IzTLeGfMCk+7IKxuSCO06k1+DaasJJe8RE4/rmismUvwrHu/HDutZWkvOAhd4z4khZo7bJLtiCzZCZ74lZcjOB4CYtuAX2ZGpc4I1iOKkvwTuQy9BWYpkzGg3ZoSWRD6ty7U+KN+fTTmIS4CelhBTT15QVqD02JxfLF7nA6sg3UlYgtiGw61oH68lSbx16P3vwSeQQpEB5JbhofW7t9TLZIbIW/ODnI4hpwj8didtk7IMBI3Ra3uUP7ya6vptkd9TwQkd/7cOFaSJmU+BIsLpOXbirJACMn+URoDXhuEtiO6xirNtrPN8jYqpwvMUm5lMMVzGT3kMMVNBqgbj8Ln8VmqouK0DR+gRyNb8fHT0BFPwsHxDskFk5yhe5c/2VUUoKCGe0kfCcX/EsHbJLUUtlHXmTqaOJpmQnW1tZ/siPwKRl6oEsIJWTUYxPQmrM2fUpYZCuAo/29lTLHiHMlTbarFOd6J/ybIbICy2gRRH/LFSryty3Cnf6aae+A9uizFBUdCwTwffc3vCBae802+R92OL78bbqHKPbSZOXNC+6ybqziezwG+OPWHx1Qk39RYaF0aFsM4uZWrFic97WwVrH5i+/Nsf/OtwWiuH0gV/SqvN1hnkxCTF/+XNn/laWKmS3e7wFzBsG8+qwqwmO9aVbDVMhOmeUXRMkxcj4QreQkHxLkCx97euZpC7xhvYnCHarHTDeD6nVK+xzbPNtzeGzNpYoiMqxZ9bBJwMaHnEoI944Vxoodf51cMIIwpTmmRvAzI1QgrfnOLOUS7uUjQ/IZ1Qa3lY08Nqm9MAGxZ2Ou6R0/Z5z30ha/Q71q6meAs3uHQcpSuRaQeV29IASmye2A2Nif+lmbhV7w8hjFYoaLCRsdchiVyNjOEM4VmxUhX4VEvw6KoCAZ/XvO2eBF/SyNU3Of4SO",
      kind: 1059,
      created_at: 1703021488,
      pubkey: "18b1a75918f1f2c90c23da616bce317d36e348bcf5f7ba55e75949319210c87c",
      id: "5c005f3ccf01950aa8d131203248544fb1e41a0d698e846bd419cec3890903ac",
      sig: "35fabdae4634eb630880a1896a886e40fd6ea8a60958e30b89b33a93e6235df750097b04f9e13053764251b8bc5dd7e8e0794a3426a90b6bcc7e5ff660f54259",
      tags: [["p", "166bf3765ebd1fc55decfe395beff2ea3b2a4e0a8946e7eb578512b555737c99"]] as const,
    };
    const rumor = await unwrapGift(recipient, wrap);
    expect(rumor.content).toBe("Are you going to the party tonight?");
    expect(rumor.kind).toBe(1);
    expect(rumor.pubkey).toBe("611df01bfcf85c26ae65453b772d8f1dfd25c264621c0277e1fc1518686faef9");
  });
});
