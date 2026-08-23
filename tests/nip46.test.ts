import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Nip46Signer,
  Pool,
  createNostrConnectURI,
  getPublicKey,
  parseBunkerInput,
  parseBunkerURL,
  parseNostrConnectURI,
  toBunkerURL,
  useWebSocketImplementation,
  verifyEvent,
} from "../src/index.ts";
import { armBunkerResponder, publishNostrConnectAck } from "./helpers/nip46-bunker.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const BUNKER_SK = "0000000000000000000000000000000000000000000000000000000000000001";
const CLIENT_SK = "0000000000000000000000000000000000000000000000000000000000000002";
const USER_SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

function testPool() {
  return new Pool({
    websocketImplementation: MockWebSocketCtor,
    enableReconnect: true,
  });
}

beforeEach(() => {
  MockWebSocket.reset();
  useWebSocketImplementation(MockWebSocketCtor);
});

afterEach(() => {
  MockWebSocket.reset();
});

describe("nip46 protocol", () => {
  test("bunker URL round-trip", () => {
    const pointer = {
      pubkey: getPublicKey(BUNKER_SK),
      relays: ["wss://relay.example", "wss://b.example"],
      secret: "s3cret",
    };
    const url = toBunkerURL(pointer);
    expect(url.startsWith("bunker://")).toBe(true);
    expect(parseBunkerURL(url)).toEqual({
      pubkey: pointer.pubkey,
      relays: pointer.relays,
      secret: "s3cret",
    });
  });

  test("nostrconnect URI round-trip", () => {
    const clientPubkey = getPublicKey(CLIENT_SK);
    const uri = createNostrConnectURI({
      clientPubkey,
      relays: ["wss://relay.example"],
      secret: "hello",
      name: "test",
      perms: ["sign_event"],
    });
    expect(uri.startsWith("nostrconnect://")).toBe(true);
    const parsed = parseNostrConnectURI(uri);
    expect(parsed.clientPubkey).toBe(clientPubkey);
    expect(parsed.secret).toBe("hello");
    expect(parsed.relays).toEqual(["wss://relay.example"]);
    expect(parsed.name).toBe("test");
    expect(parsed.perms).toEqual(["sign_event"]);
  });
});

describe("parseBunkerInput", () => {
  const bunkerPk = getPublicKey(BUNKER_SK);

  test("parses bunker:// without fetch", async () => {
    const url = toBunkerURL({
      pubkey: bunkerPk,
      relays: ["wss://bunker.example"],
      secret: "tok",
    });
    expect(await parseBunkerInput(url)).toEqual({
      pubkey: bunkerPk,
      relays: ["wss://bunker.example"],
      secret: "tok",
    });
  });

  test("pubkey-map nip46", async () => {
    const pointer = await parseBunkerInput("bunker@example.com", {
      fetch: async () => ({
        status: 200,
        json: async () => ({
          names: { bunker: bunkerPk },
          nip46: { [bunkerPk]: ["wss://map.example"] },
          relays: { [bunkerPk]: ["wss://profile.example"] },
        }),
      }),
    });
    expect(pointer).toEqual({
      pubkey: bunkerPk,
      relays: ["wss://map.example"],
      secret: null,
    });
  });

  test("spec nip46 relays and nostrconnect_url", async () => {
    const pointer = await parseBunkerInput("bunker@example.com", {
      fetch: async () => ({
        status: 200,
        json: async () => ({
          names: { bunker: bunkerPk },
          nip46: {
            relays: ["wss://spec.example"],
            nostrconnect_url: "nostrconnect://unused",
          },
        }),
      }),
    });
    expect(pointer).toEqual({
      pubkey: bunkerPk,
      relays: ["wss://spec.example"],
      secret: null,
    });
  });

  test("prefers pubkey map over spec relays; ignores profile relays", async () => {
    const otherPk = getPublicKey(USER_SK);
    const pointer = await parseBunkerInput("bunker@example.com", {
      fetch: async () => ({
        status: 200,
        json: async () => ({
          names: { bunker: bunkerPk },
          relays: { [bunkerPk]: ["wss://profile.example"] },
          nip46: {
            relays: ["wss://spec.example"],
            [bunkerPk]: ["wss://map.example"],
            [otherPk]: ["wss://other.example"],
          },
        }),
      }),
    });
    expect(pointer?.relays).toEqual(["wss://map.example"]);
  });

  test("missing nip46 returns null", async () => {
    expect(
      await parseBunkerInput("bunker@example.com", {
        fetch: async () => ({
          status: 200,
          json: async () => ({
            names: { bunker: bunkerPk },
            relays: { [bunkerPk]: ["wss://profile.example"] },
          }),
        }),
      }),
    ).toBeNull();
  });

  test("empty nip46 relay list returns null", async () => {
    expect(
      await parseBunkerInput("bunker@example.com", {
        fetch: async () => ({
          status: 200,
          json: async () => ({
            names: { bunker: bunkerPk },
            nip46: { relays: [] },
          }),
        }),
      }),
    ).toBeNull();
  });

  test("invalid identifier returns null", async () => {
    expect(await parseBunkerInput("not a bunker")).toBeNull();
  });
});

describe("Nip46Signer", () => {
  test("connect, getPublicKey, signEvent via mock bunker", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const url = toBunkerURL({
      pubkey: bunkerPk,
      relays: ["wss://bunker.example"],
      secret: "tok",
    });

    const stop = armBunkerResponder({
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
    });

    try {
      const signer = await Nip46Signer.connect(url, {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        timeoutMs: 3000,
      });

      expect(await signer.getPublicKey()).toBe(getPublicKey(USER_SK));

      const unsigned = EventBuilder.textNote("remote sign")
        .createdAt(100)
        .buildUnsigned(getPublicKey(USER_SK));
      const signed = await signer.signEvent(unsigned);
      expect(verifyEvent(signed)).toBe(true);
      expect(signed.content).toBe("remote sign");
      expect(signed.pubkey).toBe(getPublicKey(USER_SK));

      await signer.close();
    } finally {
      stop();
    }
  });

  test("connect requires pool or createPool", async () => {
    const url = toBunkerURL({
      pubkey: getPublicKey(BUNKER_SK),
      relays: ["wss://bunker.example"],
      secret: null,
    });
    await expect(Nip46Signer.connect(url, { clientSecretKey: CLIENT_SK })).rejects.toThrow(
      /pool or createPool/,
    );
  });

  test("onAuthUrl fired then request completes", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const url = toBunkerURL({
      pubkey: bunkerPk,
      relays: ["wss://bunker.example"],
      secret: "tok",
    });

    const authUrls: string[] = [];
    const stop = armBunkerResponder({
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      authUrl: "https://auth.example/approve",
      authUrlMethods: ["connect"],
    });

    try {
      const signer = await Nip46Signer.connect(url, {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        timeoutMs: 3000,
        onAuthUrl: (u) => authUrls.push(u),
      });
      expect(authUrls).toEqual(["https://auth.example/approve"]);
      expect(await signer.getPublicKey()).toBe(getPublicKey(USER_SK));
      await signer.close();
    } finally {
      stop();
    }
  });

  test("connect via NIP-05 identifier", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const stop = armBunkerResponder({
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
    });

    try {
      const signer = await Nip46Signer.connect("bunker@example.com", {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        timeoutMs: 3000,
        secret: "tok",
        fetch: async () => ({
          status: 200,
          json: async () => ({
            names: { bunker: bunkerPk },
            relays: { [bunkerPk]: ["wss://profile.example"] },
            nip46: { [bunkerPk]: ["wss://bunker.example"] },
          }),
        }),
      });

      expect(signer.bunker.pubkey).toBe(bunkerPk);
      expect(signer.bunker.relays).toEqual(["wss://bunker.example"]);
      expect(await signer.getPublicKey()).toBe(getPublicKey(USER_SK));
      await signer.close();
    } finally {
      stop();
    }
  });

  test("connect via NIP-05 names-only uses opts.relays", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const stop = armBunkerResponder({
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
    });

    try {
      const signer = await Nip46Signer.connect("bunker@example.com", {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        timeoutMs: 3000,
        secret: "tok",
        relays: ["wss://bunker.example"],
        fetch: async () => ({
          status: 200,
          json: async () => ({ names: { bunker: bunkerPk } }),
        }),
      });
      expect(signer.bunker.relays).toEqual(["wss://bunker.example"]);
      expect(await signer.getPublicKey()).toBe(getPublicKey(USER_SK));
      await signer.close();
    } finally {
      stop();
    }
  });

  test("connect via NIP-05 names-only without opts.relays throws", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    await expect(
      Nip46Signer.connect("bunker@example.com", {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        fetch: async () => ({
          status: 200,
          json: async () => ({ names: { bunker: bunkerPk } }),
        }),
      }),
    ).rejects.toThrow(/no relays for bunker connection/);
  });

  test("fromBunker does not send connect", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const signer = Nip46Signer.fromBunker(
      {
        pubkey: bunkerPk,
        relays: ["wss://bunker.example"],
        secret: "tok",
      },
      {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        timeoutMs: 3000,
      },
    );

    await new Promise((r) => setTimeout(r, 40));
    for (const ws of MockWebSocket.instances) {
      for (const raw of ws.sent) {
        const msg = JSON.parse(raw) as unknown[];
        expect(msg[0]).not.toBe("EVENT");
      }
    }

    await signer.close();
  });

  test("fromNostrConnectURI completes handshake", async () => {
    const clientPk = getPublicKey(CLIENT_SK);
    const secret = "hs-secret";
    const uri = createNostrConnectURI({
      clientPubkey: clientPk,
      relays: ["wss://nc.example"],
      secret,
    });

    const handshake = Nip46Signer.fromNostrConnectURI(uri, {
      clientSecretKey: CLIENT_SK,
      createPool: testPool,
      handshakeTimeoutMs: 3000,
    });

    // Wait for client REQ, then bunker confirms secret.
    await new Promise((r) => setTimeout(r, 25));
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    publishNostrConnectAck({
      bunkerSk: BUNKER_SK,
      clientPubkey: clientPk,
      secret,
      ws: MockWebSocket.instances[0]!,
    });

    const signer = await handshake;
    expect(signer.bunker.pubkey).toBe(getPublicKey(BUNKER_SK));
    expect(signer.clientPublicKey).toBe(clientPk);

    const stop = armBunkerResponder({
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
    });
    try {
      expect(await signer.getPublicKey()).toBe(getPublicKey(USER_SK));
      await signer.close();
    } finally {
      stop();
    }
  });
});
