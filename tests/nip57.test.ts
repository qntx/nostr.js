import { describe, expect, test } from "vite-plus/test";
import { EventBuilder, EventValidationError, Keys, Kind, makeZapRequest } from "../src/index.ts";

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
