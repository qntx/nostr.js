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
        tags: ["bitcoin", "nsfw"],
        supported_nips: [1, 11, "nope", 11.5, -1],
        terms_of_service: "https://example.com/tos",
        limitation: {
          auth_required: true,
          extra: 1,
          max_limit: 500,
          max_filters: 10,
          min_pow_difficulty: 2.5,
          default_limit: 50,
          max_subid_length: 64,
        },
        fees: { admission: [] },
      }),
    });

    const info = await fetchRelayInformation("wss://relay.example.com", { fetch: fetchImpl });
    expect(info).toEqual({
      name: "relay",
      terms_of_service: "https://example.com/tos",
      supported_nips: [1, 11],
      limitation: {
        auth_required: true,
        max_limit: 500,
        default_limit: 50,
        max_subid_length: 64,
      },
    });
    expect("unknown_field" in info).toBe(false);
    expect("fees" in info).toBe(false);
    expect("tags" in info).toBe(false);
    expect("description" in info).toBe(false);
    expect(info.limitation && "max_filters" in info.limitation).toBe(false);
  });

  test("limitation omitted when only unknown keys are present", async () => {
    const fetchImpl: Nip11Fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: "relay",
        tags: ["bitcoin"],
        limitation: { max_filters: 10, extra: true },
      }),
    });

    const info = await fetchRelayInformation("wss://relay.example.com", { fetch: fetchImpl });
    expect(info).toEqual({ name: "relay" });
    expect("limitation" in info).toBe(false);
    expect("tags" in info).toBe(false);
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
