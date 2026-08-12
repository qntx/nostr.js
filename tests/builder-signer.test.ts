import { describe, expect, test } from "vite-plus/test";
import { EventBuilder, Keys, KeysSigner, Kind, verifyEvent } from "../src/index.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

describe("EventBuilder", () => {
  test("textNote signs with Keys", () => {
    const keys = Keys.fromSecretKey(SK);
    const event = EventBuilder.textNote("hello")
      .tag(["t", "nostr"])
      .createdAt(1_700_000_000)
      .signWithKeys(keys);

    expect(event.kind).toBe(Kind.TextNote);
    expect(event.content).toBe("hello");
    expect(event.tags).toEqual([["t", "nostr"]]);
    expect(event.created_at).toBe(1_700_000_000);
    expect(event.pubkey).toBe(keys.publicKey);
    expect(verifyEvent(event)).toBe(true);
  });

  test("metadata / deletion / reaction factories", () => {
    const keys = Keys.fromSecretKey(SK);
    const meta = EventBuilder.metadata({ name: "alice" }).signWithKeys(keys);
    expect(meta.kind).toBe(Kind.Metadata);
    expect(JSON.parse(meta.content).name).toBe("alice");

    const del = EventBuilder.deletion([meta.id], "spam").signWithKeys(keys);
    expect(del.kind).toBe(Kind.EventDeletion);
    expect(del.tags[0]).toEqual(["e", meta.id]);

    const react = EventBuilder.reaction(meta.id, "+", {
      author: meta.pubkey,
      kind: 0,
    }).signWithKeys(keys);
    expect(react.kind).toBe(Kind.Reaction);
    expect(react.content).toBe("+");
  });

  test("relayList markers", () => {
    const keys = Keys.fromSecretKey(SK);
    const event = EventBuilder.relayList([
      { url: "wss://a.example" },
      { url: "wss://b.example", read: true, write: false },
      { url: "wss://c.example", read: false, write: true },
    ]).signWithKeys(keys);
    expect(event.kind).toBe(Kind.RelayList);
    expect(event.tags).toEqual([
      ["r", "wss://a.example"],
      ["r", "wss://b.example", "read"],
      ["r", "wss://c.example", "write"],
    ]);
  });
});

describe("KeysSigner", () => {
  test("async sign path matches EventBuilder.sign", async () => {
    const signer = new KeysSigner(SK);
    const pk = await signer.getPublicKey();
    const event = await EventBuilder.textNote("via signer").createdAt(1).sign(signer);
    expect(event.pubkey).toBe(pk);
    expect(verifyEvent(event)).toBe(true);
  });

  test("rejects pubkey mismatch", async () => {
    const signer = new KeysSigner(SK);
    const other = Keys.generate();
    await expect(
      signer.signEvent({
        kind: 1,
        tags: [],
        content: "x",
        created_at: 1,
        pubkey: other.publicKey,
      }),
    ).rejects.toThrow(/pubkey/);
  });
});
