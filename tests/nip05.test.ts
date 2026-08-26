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
import { queryNip05Document } from "../src/nips/nip05.ts";

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

  test("parseNip05Document nip46 appendix shape; ignores hex-pubkey maps", () => {
    const spec = parseNip05Document({
      names: { bob: PK },
      nip46: {
        relays: ["wss://spec.example", ""],
        nostrconnect_url: "nostrconnect://abc",
      },
    });
    expect(spec.nip46).toEqual({
      relays: ["wss://spec.example"],
      nostrconnectUrl: "nostrconnect://abc",
    });
    expect("relaysByPubkey" in (spec.nip46 ?? {})).toBe(false);

    const hexOnly = parseNip05Document({
      names: { bob: PK },
      nip46: { [PK.toUpperCase()]: ["wss://bunker.example"] },
    });
    expect(hexOnly.nip46).toBeUndefined();

    const mixed = parseNip05Document({
      names: { bob: PK },
      relays: { [PK]: ["wss://profile.example"] },
      nip46: {
        relays: ["wss://spec.example"],
        nostrconnect_url: "nostrconnect://abc",
        [PK]: ["wss://map.example"],
      },
    });
    expect(mixed.nip46).toEqual({
      relays: ["wss://spec.example"],
      nostrconnectUrl: "nostrconnect://abc",
    });
    expect("relaysByPubkey" in (mixed.nip46 ?? {})).toBe(false);
    expect(lookupFromDocument(mixed, { local: "bob", domain: "example.com" })).toEqual({
      pubkey: PK,
      relays: ["wss://profile.example"],
    });
  });

  test("parseNip05Document omits empty nip46", () => {
    const ignored = parseNip05Document({
      names: { bob: PK },
      nip46: { ignored: ["wss://x"] },
    });
    expect(ignored.nip46).toBeUndefined();

    const emptyRelays = parseNip05Document({
      names: { bob: PK },
      nip46: { relays: [] },
    });
    expect(emptyRelays.nip46).toEqual({ relays: [] });

    const urlOnly = parseNip05Document({
      names: { bob: PK },
      nip46: { nostrconnect_url: "nostrconnect://abc" },
    });
    expect(urlOnly.nip46).toEqual({ nostrconnectUrl: "nostrconnect://abc" });

    const emptyUrl = parseNip05Document({
      names: { bob: PK },
      nip46: { nostrconnect_url: "" },
    });
    expect(emptyUrl.nip46).toBeUndefined();

    const notObject = parseNip05Document({
      names: { bob: PK },
      nip46: ["wss://x"],
    });
    expect(notObject.nip46).toBeUndefined();

    const badUrlType = parseNip05Document({
      names: { bob: PK },
      nip46: { nostrconnect_url: 1 },
    });
    expect(badUrlType.nip46).toBeUndefined();
  });
});

describe("nip05 query", () => {
  function jsonResponse(status: number, body: unknown): Awaited<ReturnType<Nip05Fetch>> {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  }

  function mockFetch(map: Record<string, { status: number; body: unknown }>): Nip05Fetch {
    return async (url, init) => {
      expect((init as { redirect?: string } | undefined)?.redirect).toBe("manual");
      const entry = map[url];
      if (!entry) return jsonResponse(404, {});
      return jsonResponse(entry.status, entry.body);
    };
  }

  function abortError(): Error {
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
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

  test("aborted signal throws AbortError, not null", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = abortError();
    const fetchImpl: Nip05Fetch = async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      expect(init?.signal?.aborted).toBe(true);
      throw aborted;
    };
    await expect(
      queryNip05Document("bob@example.com", { fetch: fetchImpl, signal: controller.signal }),
    ).rejects.toBe(aborted);
  });

  test("network and parse failures return null, not Nip05Error", async () => {
    const net: Nip05Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await queryNip05Document("bob@example.com", { fetch: net })).toBeNull();
    expect(await queryProfile("bob@example.com", { fetch: net })).toBeNull();

    const badDoc: Nip05Fetch = async () => jsonResponse(200, { names: "nope" });
    expect(await queryNip05Document("bob@example.com", { fetch: badDoc })).toBeNull();
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
