import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Keys,
  Pool,
  Relay,
  encodeClientMessage,
  parseRelayMessage,
  useWebSocketImplementation,
} from "../src/index.ts";
import { FakeRelayBus } from "./helpers/fake-relay.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

describe("NIP-45 COUNT codec", () => {
  test("encode client COUNT and parse relay COUNT with optional fields", () => {
    const wire = encodeClientMessage(["COUNT", "c1", { kinds: [1] }]);
    expect(JSON.parse(wire)).toEqual(["COUNT", "c1", { kinds: [1] }]);

    const msg = parseRelayMessage(
      JSON.stringify(["COUNT", "c1", { count: 3, approximate: true, hll: "abc" }]),
    );
    expect(msg).toEqual(["COUNT", "c1", { count: 3, approximate: true, hll: "abc" }]);
  });
});

describe("Relay.count", () => {
  beforeEach(() => {
    MockWebSocket.reset();
    useWebSocketImplementation(MockWebSocketCtor);
  });
  afterEach(() => {
    MockWebSocket.reset();
  });

  test("sends COUNT and resolves payload", async () => {
    const relay = await Relay.connect("wss://count.example", {
      websocketImplementation: MockWebSocketCtor,
    });

    const countP = relay.count([{ kinds: [1], authors: ["aa".repeat(32)] }], {
      id: "count:test",
      timeoutMs: 2000,
    });
    await Promise.resolve();
    const ws = MockWebSocket.last();
    const sent = ws.sent.map((s) => JSON.parse(s) as unknown[]);
    const countMsg = sent.find((m) => m[0] === "COUNT") as [string, string, ...unknown[]];
    expect(countMsg[0]).toBe("COUNT");
    expect(countMsg[1]).toBe("count:test");
    expect(countMsg[2]).toEqual({ kinds: [1], authors: ["aa".repeat(32)] });

    ws.receive(JSON.stringify(["COUNT", "count:test", { count: 7, approximate: false }]));
    await expect(countP).resolves.toEqual({ count: 7, approximate: false });
    relay.close();
  });

  test("CLOSED on COUNT id rejects", async () => {
    const relay = await Relay.connect("wss://count.example", {
      websocketImplementation: MockWebSocketCtor,
    });
    const countP = relay.count([{ kinds: [1] }], { id: "count:closed", timeoutMs: 2000 });
    await Promise.resolve();
    MockWebSocket.last().receive(JSON.stringify(["CLOSED", "count:closed", "unsupported: COUNT"]));
    await expect(countP).rejects.toThrow(/unsupported: COUNT/);
    relay.close();
  });

  test("requires connection and non-empty filters", async () => {
    const relay = new Relay("wss://count.example", {
      websocketImplementation: MockWebSocketCtor,
    });
    await expect(relay.count([{ kinds: [1] }])).rejects.toThrow(/not connected/);
    await relay.connect();
    await expect(relay.count([])).rejects.toThrow(/at least one filter/);
    relay.close();
  });
});

describe("Pool.count + FakeRelayBus", () => {
  let bus: FakeRelayBus;

  beforeEach(() => {
    MockWebSocket.reset();
    useWebSocketImplementation(MockWebSocketCtor);
    bus = new FakeRelayBus();
    bus.start();
  });

  afterEach(() => {
    bus.stop();
    MockWebSocket.reset();
  });

  test("counts matching seeded events per relay", async () => {
    const keys = Keys.fromSecretKey(SK);
    const a = EventBuilder.textNote("a").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(2).signWithKeys(keys);
    const meta = EventBuilder.metadata({ name: "x" }).createdAt(3).signWithKeys(keys);

    bus.seed("wss://a.example", [a, b, meta]);
    bus.seed("wss://b.example", [a]);

    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      enableReconnect: false,
    });

    const results = await pool.count(
      ["wss://a.example", "wss://b.example"],
      [{ kinds: [1], authors: [keys.publicKey] }],
      { timeoutMs: 2000 },
    );

    const byUrl = new Map(results.map((r) => [r.url.replace(/\/$/, ""), r]));
    // normalizeURL may add trailing slash
    const aRes = [...byUrl.values()].find((r) => r.url.includes("a.example"));
    const bRes = [...byUrl.values()].find((r) => r.url.includes("b.example"));
    expect(aRes?.count).toBe(2);
    expect(bRes?.count).toBe(1);
    expect(aRes?.error).toBeUndefined();

    pool.close();
  });
});
