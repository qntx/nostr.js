import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Kind,
  Keys,
  Nip46Signer,
  createNostrConnectURI,
  decodeNip46Request,
  nip44Encrypt,
  nip44Decrypt,
  finalizeEvent,
  getConversationKey,
  getPublicKey,
  parseBunkerURL,
  parseNostrConnectURI,
  toBunkerURL,
  useWebSocketImplementation,
  verifyEvent,
  encodeNip46Response,
  type TagTuple,
} from "../src/index.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const BUNKER_SK = "0000000000000000000000000000000000000000000000000000000000000001";
const CLIENT_SK = "0000000000000000000000000000000000000000000000000000000000000002";
const USER_SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

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

/** Respond to client NIP-46 requests on mock sockets as a bunker. */
function armBunkerResponder(opts: { bunkerSk: string; userSk: string; clientPubkey: string }) {
  const bunkerKeys = Keys.fromSecretKey(opts.bunkerSk);
  const userKeys = Keys.fromSecretKey(opts.userSk);
  const convKey = getConversationKey(bunkerKeys.secretKey.bytes, opts.clientPubkey);
  const handled = new Set<string>();

  const tick = () => {
    for (const ws of MockWebSocket.instances) {
      for (const raw of ws.sent) {
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!Array.isArray(msg) || msg[0] !== "EVENT") continue;
        const event = msg[1] as {
          kind: number;
          pubkey: string;
          content: string;
          id: string;
        };
        if (handled.has(event.id)) continue;
        handled.add(event.id);

        // Always ACK publishes so pool.publish resolves.
        ws.receive(JSON.stringify(["OK", event.id, true, ""]));

        if (event.kind !== Kind.NostrConnect) continue;
        if (event.pubkey !== opts.clientPubkey) continue;

        try {
          const req = decodeNip46Request(nip44Decrypt(event.content, convKey));

          let result: string | undefined;
          let error: string | undefined;
          switch (req.method) {
            case "connect":
              result = "ack";
              break;
            case "get_public_key":
              result = userKeys.publicKey;
              break;
            case "ping":
              result = "pong";
              break;
            case "sign_event": {
              const template = JSON.parse(req.params[0]!) as {
                kind: number;
                tags: TagTuple[];
                content: string;
                created_at: number;
              };
              const signed = finalizeEvent(template, userKeys.secretKey);
              result = JSON.stringify(signed);
              break;
            }
            default:
              error = `unsupported method ${req.method}`;
          }

          const responseJson = encodeNip46Response({
            id: req.id,
            result,
            error,
          });
          const reply = finalizeEvent(
            {
              kind: Kind.NostrConnect,
              tags: [["p", opts.clientPubkey]],
              content: nip44Encrypt(responseJson, convKey),
              created_at: Math.floor(Date.now() / 1000),
            },
            bunkerKeys.secretKey,
          );

          for (const raw2 of ws.sent) {
            const m = JSON.parse(raw2) as unknown[];
            if (m[0] === "REQ") {
              const subId = m[1] as string;
              ws.receive(JSON.stringify(["EVENT", subId, reply]));
            }
          }
        } catch {
          // ignore malformed
        }
      }
    }
  };

  const interval = setInterval(tick, 5);
  return () => clearInterval(interval);
}

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
        websocketImplementation: MockWebSocketCtor,
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
});
