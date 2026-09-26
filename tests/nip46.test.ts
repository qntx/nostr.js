import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { EventBuilder, Nip46Signer, Pool, getPublicKey, verifyEvent } from "../src/index.ts";
import {
  createNostrConnectURI,
  parseBunkerURL,
  parseNostrConnectURI,
  toBunkerURL,
} from "../src/nips/nip46.ts";
import {
  createFakeNip46Signer,
  createFakeRelayNetwork,
  type FakeRelayNetwork,
} from "../src/testing/index.ts";
import { stubReportError } from "./helpers/report-error.ts";

const BUNKER_SK = "0000000000000000000000000000000000000000000000000000000000000001";
const CLIENT_SK = "0000000000000000000000000000000000000000000000000000000000000002";
const USER_SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

let net: FakeRelayNetwork;

function testPool() {
  return new Pool({
    websocketImplementation: net.websocketImplementation,
    enableReconnect: true,
  });
}

beforeEach(() => {
  net = createFakeRelayNetwork();
});

afterEach(() => {
  net.close();
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

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

  test("parseBunkerURL rejects NIP-05 identifiers and other non-bunker strings", () => {
    expect(parseBunkerURL("alice@example.com")).toBeNull();
    expect(parseBunkerURL("bunker@example.com")).toBeNull();
    expect(parseBunkerURL("example.com")).toBeNull();
    expect(parseBunkerURL("")).toBeNull();
    expect(parseBunkerURL("not a bunker")).toBeNull();
    expect(parseBunkerURL("bunker://")).toBeNull();
    expect(parseBunkerURL(`bunker://${getPublicKey(BUNKER_SK).slice(0, 63)}`)).toBeNull();
    expect(parseBunkerURL(getPublicKey(BUNKER_SK))).toBeNull();
    expect(
      parseBunkerURL(
        createNostrConnectURI({
          clientPubkey: getPublicKey(CLIENT_SK),
          relays: ["wss://relay.example"],
          secret: "hello",
        }),
      ),
    ).toBeNull();
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

    const requests: Array<{ method: string; params: string[] }> = [];
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      requests,
    });

    try {
      const signer = await Nip46Signer.connect(url, {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        timeoutMs: 3000,
      });

      expect(requests.map((r) => r.method)).toEqual(["connect", "switch_relays", "get_public_key"]);
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
      remote.close();
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
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
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
      remote.close();
    }
  });

  test("connect rejects NIP-05 identifiers", async () => {
    await expect(
      Nip46Signer.connect("alice@example.com", {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        timeoutMs: 3000,
        secret: "tok",
        relays: ["wss://bunker.example"],
      }),
    ).rejects.toThrow(/invalid bunker input/);
    await expect(
      Nip46Signer.connect("bunker@example.com", {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        relays: ["wss://bunker.example"],
      }),
    ).rejects.toThrow(/invalid bunker input/);
  });

  test("connect rejects empty, garbage, and nostrconnect strings", async () => {
    const opts = {
      clientSecretKey: CLIENT_SK,
      createPool: testPool,
      relays: ["wss://bunker.example"],
    };
    await expect(Nip46Signer.connect("", opts)).rejects.toThrow(/invalid bunker input/);
    await expect(Nip46Signer.connect("not a bunker", opts)).rejects.toThrow(/invalid bunker input/);
    await expect(Nip46Signer.connect(getPublicKey(BUNKER_SK), opts)).rejects.toThrow(
      /invalid bunker input/,
    );
    const nc = createNostrConnectURI({
      clientPubkey: getPublicKey(CLIENT_SK),
      relays: ["wss://nc.example"],
      secret: "hello",
    });
    await expect(Nip46Signer.connect(nc, opts)).rejects.toThrow(/invalid bunker input/);
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

    await waitFor(() => net.relay("wss://bunker.example").clientMessages().length > 0);
    await new Promise((r) => setTimeout(r, 20));
    const frames = net.relay("wss://bunker.example").clientMessages();
    expect(frames.some((m) => (m as unknown[])[0] === "REQ")).toBe(true);
    expect(frames.some((m) => (m as unknown[])[0] === "EVENT")).toBe(false);

    await signer.close();
  });

  test("fromBunker requires clientSecretKey", () => {
    expect(() =>
      Nip46Signer.fromBunker(
        {
          pubkey: getPublicKey(BUNKER_SK),
          relays: ["wss://bunker.example"],
          secret: null,
        },
        { createPool: testPool } as never,
      ),
    ).toThrow(/fromBunker requires clientSecretKey/);
  });

  test("connectRemote accepts the bunker secret as connect result", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const secret = "tok";
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      connectResult: secret,
    });
    try {
      const signer = await Nip46Signer.connect(
        { pubkey: bunkerPk, relays: ["wss://bunker.example"], secret },
        { clientSecretKey: CLIENT_SK, createPool: testPool, timeoutMs: 3000 },
      );
      expect(await signer.getPublicKey()).toBe(getPublicKey(USER_SK));
      await signer.close();
    } finally {
      remote.close();
    }
  });

  test("connectRemote rejects a connect result that is not ack or secret", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      connectResult: "ok",
    });
    try {
      await expect(
        Nip46Signer.connect(
          { pubkey: bunkerPk, relays: ["wss://bunker.example"], secret: "tok" },
          { clientSecretKey: CLIENT_SK, createPool: testPool, timeoutMs: 3000 },
        ),
      ).rejects.toThrow(/connect result is not ack or secret: ok/);
    } finally {
      remote.close();
    }
  });

  test("connectRemote rejects a mismatched secret", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      connectResult: "other-secret",
    });
    try {
      await expect(
        Nip46Signer.connect(
          { pubkey: bunkerPk, relays: ["wss://bunker.example"], secret: "tok" },
          { clientSecretKey: CLIENT_SK, createPool: testPool, timeoutMs: 3000 },
        ),
      ).rejects.toThrow(/connect result is not ack or secret: other-secret/);
    } finally {
      remote.close();
    }
  });

  test("connectRemote without a pointer secret rejects a non-ack result", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      connectResult: "tok",
    });
    try {
      await expect(
        Nip46Signer.connect(
          { pubkey: bunkerPk, relays: ["wss://bunker.example"], secret: null },
          { clientSecretKey: CLIENT_SK, createPool: testPool, timeoutMs: 3000 },
        ),
      ).rejects.toThrow(/connect result is not ack or secret: tok/);
    } finally {
      remote.close();
    }
  });

  test("connect closes signer when connectRemote fails", async () => {
    let poolClosed = false;
    let subClosed = false;
    await expect(
      Nip46Signer.connect(
        {
          pubkey: getPublicKey(BUNKER_SK),
          relays: ["wss://bunker.example"],
          secret: "tok",
        },
        {
          clientSecretKey: CLIENT_SK,
          createPool: () => ({
            subscribe: () => ({
              close: () => {
                subClosed = true;
              },
            }),
            publish: async () => [{ result: { ok: true, message: "" } }],
            close: () => {
              poolClosed = true;
            },
          }),
          timeoutMs: 50,
        },
      ),
    ).rejects.toThrow(/timed out/);
    expect(subClosed).toBe(true);
    expect(poolClosed).toBe(true);
  });

  test("fromNostrConnectURI completes handshake", async () => {
    const clientPk = getPublicKey(CLIENT_SK);
    const secret = "hs-secret";
    const uri = createNostrConnectURI({
      clientPubkey: clientPk,
      relays: ["wss://nc.example"],
      secret,
    });

    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://nc.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
    });
    try {
      const handshake = Nip46Signer.fromNostrConnectURI(uri, {
        clientSecretKey: CLIENT_SK,
        createPool: testPool,
        handshakeTimeoutMs: 3000,
        timeoutMs: 3000,
      });

      await waitFor(() =>
        net
          .relay("wss://nc.example")
          .clientMessages()
          .some((m) => (m as unknown[])[0] === "REQ"),
      );
      remote.confirmHandshake(secret);

      const signer = await handshake;
      expect(signer.bunker.pubkey).toBe(getPublicKey(BUNKER_SK));
      expect(signer.clientPublicKey).toBe(clientPk);
      expect(await signer.getPublicKey()).toBe(getPublicKey(USER_SK));
      await signer.close();
    } finally {
      remote.close();
    }
  });

  test("connect sends perms and metadata", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const requests: Array<{ method: string; params: string[] }> = [];
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      requests,
    });
    try {
      const signer = await Nip46Signer.connect(
        toBunkerURL({ pubkey: bunkerPk, relays: ["wss://bunker.example"], secret: "tok" }),
        {
          clientSecretKey: CLIENT_SK,
          createPool: testPool,
          timeoutMs: 3000,
          perms: ["sign_event:1", "nip44_encrypt"],
          metadata: { name: "test-client", url: "https://example.com" },
        },
      );
      const connect = requests.find((r) => r.method === "connect");
      expect(connect?.params).toEqual([
        bunkerPk,
        "tok",
        "sign_event:1,nip44_encrypt",
        JSON.stringify({ name: "test-client", url: "https://example.com" }),
      ]);
      await signer.close();
    } finally {
      remote.close();
    }
  });

  test("switchRelays updates bunker relays; logout acks and closes", async () => {
    const bunkerPk = getPublicKey(BUNKER_SK);
    const clientPk = getPublicKey(CLIENT_SK);
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      switchRelays: ["wss://new.example"],
    });
    remote.attach("wss://new.example");
    try {
      const signer = await Nip46Signer.connect(
        toBunkerURL({ pubkey: bunkerPk, relays: ["wss://bunker.example"], secret: "tok" }),
        { clientSecretKey: CLIENT_SK, createPool: testPool, timeoutMs: 3000 },
      );
      expect(signer.bunker.relays).toEqual(["wss://new.example"]);
      await signer.logout();
    } finally {
      remote.close();
    }
  });
});

describe("issue #130", () => {
  test("auth_url keeps the request alive past timeoutMs and resolves on the later response", async () => {
    const clientPk = getPublicKey(CLIENT_SK);
    const authUrls: string[] = [];
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      authUrl: "https://auth.example/approve",
      authUrlMethods: ["ping"],
      authReplyDelayMs: 150,
    });

    try {
      const signer = Nip46Signer.fromBunker(
        {
          pubkey: getPublicKey(BUNKER_SK),
          relays: ["wss://bunker.example"],
          secret: null,
        },
        {
          clientSecretKey: CLIENT_SK,
          createPool: testPool,
          timeoutMs: 60,
          authTimeoutMs: 2000,
          onAuthUrl: (u) => authUrls.push(u),
        },
      );
      const started = Date.now();
      await expect(signer.ping()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      expect(authUrls).toEqual(["https://auth.example/approve"]);
      await signer.close();
    } finally {
      remote.close();
    }
  });

  test("publish rejected by every relay fails fast", async () => {
    const signer = Nip46Signer.fromBunker(
      {
        pubkey: getPublicKey(BUNKER_SK),
        relays: ["wss://bunker.example"],
        secret: null,
      },
      {
        clientSecretKey: CLIENT_SK,
        createPool: () => ({
          subscribe: () => ({ close: () => {} }),
          publish: async () => [
            { error: "blocked: spam" },
            { result: { ok: false, message: "restricted: no" } },
          ],
          close: () => {},
        }),
        timeoutMs: 500,
      },
    );
    await expect(signer.ping()).rejects.toThrow(
      /request not accepted by any relay: blocked: spam; restricted: no/,
    );
    await signer.close();
  });

  test("throwing onAuthUrl is reported and the request still resolves", async () => {
    const { reported, restore } = stubReportError();
    const clientPk = getPublicKey(CLIENT_SK);
    const boom = new Error("auth callback boom");
    const remote = createFakeNip46Signer({
      network: net,
      relayUrl: "wss://bunker.example",
      bunkerSk: BUNKER_SK,
      userSk: USER_SK,
      clientPubkey: clientPk,
      authUrl: "https://auth.example/approve",
      authUrlMethods: ["ping"],
    });

    try {
      const signer = Nip46Signer.fromBunker(
        {
          pubkey: getPublicKey(BUNKER_SK),
          relays: ["wss://bunker.example"],
          secret: null,
        },
        {
          clientSecretKey: CLIENT_SK,
          createPool: testPool,
          timeoutMs: 2000,
          onAuthUrl: () => {
            throw boom;
          },
        },
      );
      await expect(signer.ping()).resolves.toBeUndefined();
      expect(reported).toEqual([boom]);
      await signer.close();
    } finally {
      restore();
      remote.close();
    }
  });
});
