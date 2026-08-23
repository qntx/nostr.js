import { describe, expect, test } from "vite-plus/test";
import {
  Nip11Error,
  fetchRelayInformation,
  relayInfoHttpUrl,
  type Nip11Fetch,
} from "../src/index.ts";

describe("relayInfoHttpUrl", () => {
  test("rewrites websocket schemes", () => {
    expect(relayInfoHttpUrl("wss://relay.example.com")).toBe("https://relay.example.com/");
    expect(relayInfoHttpUrl("ws://relay.example.com")).toBe("http://relay.example.com/");
    expect(relayInfoHttpUrl("wss://relay.example.com/nostr")).toBe(
      "https://relay.example.com/nostr",
    );
    expect(relayInfoHttpUrl("ws://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(relayInfoHttpUrl("wss://relay.example.com:443")).toBe("https://relay.example.com/");
  });

  test("leaves http(s) schemes unchanged", () => {
    expect(relayInfoHttpUrl("https://relay.example.com/")).toBe("https://relay.example.com/");
    expect(relayInfoHttpUrl("http://relay.example.com/")).toBe("http://relay.example.com/");
  });

  test("rejects invalid urls", () => {
    expect(() => relayInfoHttpUrl("not a url")).toThrow(Nip11Error);
    expect(() => relayInfoHttpUrl("ftp://relay.example.com")).toThrow(
      /unsupported relay URL scheme/,
    );
  });
});

describe("fetchRelayInformation", () => {
  test("GETs the rewritten URL with Accept and redirect: manual", async () => {
    let seenUrl: string | undefined;
    let seenInit: Parameters<Nip11Fetch>[1];
    const fetchImpl: Nip11Fetch = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return { ok: true, status: 200, json: async () => ({ name: "Example" }) };
    };

    const info = await fetchRelayInformation("wss://relay.example.com", { fetch: fetchImpl });
    expect(seenUrl).toBe("https://relay.example.com/");
    expect(seenInit?.headers?.Accept).toBe("application/nostr+json");
    expect(seenInit?.redirect).toBe("manual");
    expect(info).toEqual({ name: "Example" });
  });

  test("404 throws Nip11Error", async () => {
    const fetchImpl: Nip11Fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ name: "missing" }),
    });
    await expect(
      fetchRelayInformation("wss://relay.example.com", { fetch: fetchImpl }),
    ).rejects.toThrow(Nip11Error);
    await expect(
      fetchRelayInformation("wss://relay.example.com", { fetch: fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });

  test("3xx throws Nip11Error", async () => {
    const fetchImpl: Nip11Fetch = async () => ({
      ok: false,
      status: 302,
      json: async () => ({ name: "redir" }),
    });
    await expect(
      fetchRelayInformation("wss://relay.example.com", { fetch: fetchImpl }),
    ).rejects.toThrow(/HTTP 302/);
  });

  test("extra fields ignored and missing fields omitted", async () => {
    const fetchImpl: Nip11Fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: "relay",
        unknown_field: "drop-me",
        supported_nips: [1, 11, "nope", 11.5, -1],
        limitation: { auth_required: true, extra: 1, max_limit: 500, min_pow_difficulty: 2.5 },
        fees: { admission: [] },
      }),
    });

    const info = await fetchRelayInformation("wss://relay.example.com", { fetch: fetchImpl });
    expect(info).toEqual({
      name: "relay",
      supported_nips: [1, 11],
      limitation: { auth_required: true, max_limit: 500 },
    });
    expect("unknown_field" in info).toBe(false);
    expect("fees" in info).toBe(false);
    expect("description" in info).toBe(false);
  });

  test("non-object JSON throws", async () => {
    const fetchImpl: Nip11Fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ["not", "an", "object"],
    });
    await expect(
      fetchRelayInformation("wss://relay.example.com", { fetch: fetchImpl }),
    ).rejects.toThrow(/must be a JSON object/);
  });
});
