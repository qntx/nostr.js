import { describe, expect, test } from "vite-plus/test";
import {
  NIP05_REGEX,
  isNip05,
  lookupFromDocument,
  parseNip05,
  parseNip05Document,
  queryProfile,
  verifyNip05,
  wellKnownUrl,
  type Nip05Fetch,
} from "../src/index.ts";

const PK = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const PK2 = "2c7cc62a697ea3a7826521f3fd34f0cb273693cbe5e9310f35449f43622a5cdc";

describe("nip05 parse", () => {
  test("NIP05_REGEX and isNip05", () => {
    expect(NIP05_REGEX.test("_@bob.com.br")).toBe(true);
    expect(NIP05_REGEX.test("bob@bob.com.br")).toBe(true);
    expect(NIP05_REGEX.test("bob.com.br")).toBe(true);
    expect(NIP05_REGEX.test("b&b@bob.com.br")).toBe(false);
    expect(isNip05("bob@bob.com.br")).toBe(true);
    expect(isNip05("b&b@bob.com.br")).toBe(false);
    expect(isNip05(null)).toBe(false);
  });

  test("parseNip05 forms", () => {
    expect(parseNip05("Bob@Example.COM")).toEqual({ local: "bob", domain: "example.com" });
    expect(parseNip05("_@example.com")).toEqual({ local: "_", domain: "example.com" });
    expect(parseNip05("example.com")).toEqual({ local: "_", domain: "example.com" });
    expect(() => parseNip05("not an id")).toThrow(/invalid NIP-05/);
  });

  test("wellKnownUrl", () => {
    expect(wellKnownUrl({ local: "bob", domain: "example.com" })).toBe(
      "https://example.com/.well-known/nostr.json?name=bob",
    );
    expect(wellKnownUrl({ local: "_", domain: "example.com" })).toBe(
      "https://example.com/.well-known/nostr.json?name=_",
    );
  });

  test("parseNip05Document and lookupFromDocument", () => {
    const doc = parseNip05Document({
      names: { Bob: PK.toUpperCase(), _: PK2 },
      relays: {
        [PK.toUpperCase()]: ["wss://a.example", "wss://b.example"],
      },
    });
    expect(doc.names.bob).toBe(PK);
    expect(lookupFromDocument(doc, { local: "bob", domain: "example.com" })).toEqual({
      pubkey: PK,
      relays: ["wss://a.example", "wss://b.example"],
    });
    expect(lookupFromDocument(doc, { local: "_", domain: "example.com" })).toEqual({
      pubkey: PK2,
    });
    expect(lookupFromDocument(doc, { local: "missing", domain: "example.com" })).toBeUndefined();
  });
});

describe("nip05 query", () => {
  function mockFetch(map: Record<string, { status: number; body: unknown }>): Nip05Fetch {
    return async (url) => {
      const entry = map[url];
      if (!entry) return { status: 404, json: async () => ({}) };
      return { status: entry.status, json: async () => entry.body };
    };
  }

  test("queryProfile resolves names and relays", async () => {
    const fetchImpl = mockFetch({
      "https://fiatjaf.com/.well-known/nostr.json?name=_": {
        status: 200,
        body: {
          names: { _: PK },
          relays: { [PK]: ["wss://pyramid.fiatjaf.com", "wss://nos.lol"] },
        },
      },
      "https://compile-error.net/.well-known/nostr.json?name=_": {
        status: 200,
        body: { names: { _: PK2 } },
      },
      "https://example.com/.well-known/nostr.json?name=alice": {
        status: 200,
        body: { names: { alice: PK } },
      },
    });

    const root = await queryProfile("fiatjaf.com", { fetch: fetchImpl });
    expect(root).toEqual({
      pubkey: PK,
      relays: ["wss://pyramid.fiatjaf.com", "wss://nos.lol"],
    });

    const bare = await queryProfile("_@fiatjaf.com", { fetch: fetchImpl });
    expect(bare?.pubkey).toBe(PK);

    const other = await queryProfile("compile-error.net", { fetch: fetchImpl });
    expect(other?.pubkey).toBe(PK2);

    const named = await queryProfile("alice@example.com", { fetch: fetchImpl });
    expect(named?.pubkey).toBe(PK);
  });

  test("queryProfile rejects non-200 and missing names", async () => {
    const fetchImpl = mockFetch({
      "https://redir.example/.well-known/nostr.json?name=_": {
        status: 302,
        body: { names: { _: PK } },
      },
      "https://empty.example/.well-known/nostr.json?name=bob": {
        status: 200,
        body: { names: {} },
      },
    });

    expect(await queryProfile("redir.example", { fetch: fetchImpl })).toBeNull();
    expect(await queryProfile("bob@empty.example", { fetch: fetchImpl })).toBeNull();
    expect(await queryProfile("%%%", { fetch: fetchImpl })).toBeNull();
  });

  test("verifyNip05", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/.well-known/nostr.json?name=bob": {
        status: 200,
        body: { names: { bob: PK } },
      },
    });

    expect(await verifyNip05(PK, "bob@example.com", { fetch: fetchImpl })).toBe(true);
    expect(await verifyNip05(PK2, "bob@example.com", { fetch: fetchImpl })).toBe(false);
    expect(await verifyNip05("zz", "bob@example.com", { fetch: fetchImpl })).toBe(false);
  });
});
