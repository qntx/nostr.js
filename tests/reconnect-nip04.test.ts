import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Keys,
  KeysSigner,
  Relay,
  nip04Decrypt,
  nip04Encrypt,
  useWebSocketImplementation,
} from "../src/index.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const SK2 = "0000000000000000000000000000000000000000000000000000000000000001";

beforeEach(() => {
  MockWebSocket.reset();
  useWebSocketImplementation(MockWebSocketCtor);
});

afterEach(() => {
  MockWebSocket.reset();
});

describe("Relay reconnect", () => {
  test("resubscribes after unexpected disconnect", async () => {
    const relay = new Relay("wss://reconnect.example", {
      enableReconnect: true,
      reconnectBackoffMs: [10, 20, 50],
      websocketImplementation: MockWebSocketCtor,
    });
    await relay.connect();

    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("after reconnect").createdAt(1).signWithKeys(keys);

    const events: (typeof note)[] = [];
    let reconnected = false;
    relay.onreconnect = () => {
      reconnected = true;
    };

    const sub = relay.subscribe([{ kinds: [1] }], {
      onevent: (e) => events.push(e),
    });

    const first = MockWebSocket.instances[0]!;
    const firstReq = first.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "REQ") as [
      string,
      string,
    ];
    expect(firstReq[0]).toBe("REQ");

    // drop connection
    first.close();
    expect(relay.connected).toBe(false);

    // wait for reconnect backoff + new socket
    await new Promise((r) => setTimeout(r, 40));
    expect(reconnected).toBe(true);
    expect(relay.connected).toBe(true);
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    const second = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
    const reReq = second.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "REQ") as [
      string,
      string,
    ];
    expect(reReq[0]).toBe("REQ");
    expect(reReq[1]).toBe(sub.id);

    second.receive(JSON.stringify(["EVENT", sub.id, note]));
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("after reconnect");

    relay.close();
  });

  test("intentional close does not reconnect", async () => {
    const relay = new Relay("wss://nogo.example", {
      enableReconnect: true,
      reconnectBackoffMs: [10],
      websocketImplementation: MockWebSocketCtor,
    });
    await relay.connect();
    relay.subscribe([{ kinds: [1] }], {});
    const before = MockWebSocket.instances.length;
    relay.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(MockWebSocket.instances.length).toBe(before);
  });
});

describe("nip04", () => {
  test("encrypt/decrypt round-trip", () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const cipher = nip04Encrypt(a.secretKey.bytes, b.publicKey, "legacy dm");
    expect(cipher).toContain("?iv=");
    expect(nip04Decrypt(b.secretKey.bytes, a.publicKey, cipher)).toBe("legacy dm");
  });

  test("KeysSigner nip04 methods", async () => {
    const a = new KeysSigner(SK);
    const b = new KeysSigner(SK2);
    const pkB = await b.getPublicKey();
    const pkA = await a.getPublicKey();
    const cipher = await a.nip04Encrypt!(pkB, "via signer");
    expect(await b.nip04Decrypt!(pkA, cipher)).toBe("via signer");
  });
});
