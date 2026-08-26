import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Keys,
  MessageError,
  Pool,
  Relay,
  encodeClientMessage,
  mergeCountHll,
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

    const hll = "ab" + "00".repeat(255);
    const msg = parseRelayMessage(
      JSON.stringify(["COUNT", "c1", { count: 3, approximate: true, hll }]),
    );
    expect(msg).toEqual(["COUNT", "c1", { count: 3, approximate: true, hll }]);
    if (msg[0] !== "COUNT") throw new Error("expected COUNT");
    expect(msg[2].hll).toBe(hll);
    expect(msg[2].hll).toHaveLength(512);
  });

  test("omits invalid hll and keeps count/approximate", () => {
    const short = parseRelayMessage(
      JSON.stringify(["COUNT", "c1", { count: 3, approximate: true, hll: "abc" }]),
    );
    expect(short).toEqual(["COUNT", "c1", { count: 3, approximate: true }]);
    if (short[0] !== "COUNT") throw new Error("expected COUNT");
    expect("hll" in short[2]).toBe(false);

    const nonHex = parseRelayMessage(
      JSON.stringify(["COUNT", "c1", { count: 1, hll: "g".repeat(512) }]),
    );
    expect(nonHex).toEqual(["COUNT", "c1", { count: 1 }]);
    if (nonHex[0] !== "COUNT") throw new Error("expected COUNT");
    expect("hll" in nonHex[2]).toBe(false);

    const notString = parseRelayMessage(
      JSON.stringify(["COUNT", "c1", { count: 2, approximate: false, hll: 1 }]),
    );
    expect(notString).toEqual(["COUNT", "c1", { count: 2, approximate: false }]);
    if (notString[0] !== "COUNT") throw new Error("expected COUNT");
    expect("hll" in notString[2]).toBe(false);
  });

  test("lowercases a valid 512-hex hll", () => {
    const lower = "cd" + "00".repeat(255);
    const msg = parseRelayMessage(
      JSON.stringify(["COUNT", "c1", { count: 9, hll: lower.toUpperCase() }]),
    );
    expect(msg).toEqual(["COUNT", "c1", { count: 9, hll: lower }]);
    if (msg[0] !== "COUNT") throw new Error("expected COUNT");
    expect(msg[2].hll).toBe(lower);
  });
});

describe("mergeCountHll", () => {
  test("empty input is the 512-zero identity sketch", () => {
    expect(mergeCountHll([])).toBe("0".repeat(512));
  });

  test("one element is a lowercase clone", () => {
    const sketch = "AB" + "00".repeat(255);
    expect(mergeCountHll([sketch])).toBe("ab" + "00".repeat(255));
  });

  test("register-wise max of 0x01 and 0x02", () => {
    const a = "01" + "02" + "00".repeat(254);
    const b = "02" + "01" + "00".repeat(254);
    expect(mergeCountHll([a, b])).toBe("02" + "02" + "00".repeat(254));
  });

  test("rejects length 511", () => {
    expect(() => mergeCountHll(["0".repeat(511)])).toThrow(MessageError);
  });

  test("rejects non-hex gg", () => {
    expect(() => mergeCountHll(["gg" + "00".repeat(255)])).toThrow(MessageError);
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

  test("auth-required CLOSED without authSigner rejects", async () => {
    const relay = await Relay.connect("wss://count.example", {
      websocketImplementation: MockWebSocketCtor,
    });
    const countP = relay.count([{ kinds: [1] }], { id: "count:noauth", timeoutMs: 2000 });
    await Promise.resolve();
    MockWebSocket.last().receive(
      JSON.stringify(["CLOSED", "count:noauth", "auth-required: login"]),
    );
    await expect(countP).rejects.toThrow(/auth-required: login/);
    relay.close();
  });

  test("second count after non-auth CLOSED still works", async () => {
    const relay = await Relay.connect("wss://count.example", {
      websocketImplementation: MockWebSocketCtor,
    });
    const first = relay.count([{ kinds: [1] }], { id: "count:first", timeoutMs: 2000 });
    await Promise.resolve();
    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["CLOSED", "count:first", "unsupported: COUNT"]));
    await expect(first).rejects.toThrow(/unsupported: COUNT/);

    const second = relay.count([{ kinds: [0] }], { id: "count:second", timeoutMs: 2000 });
    await Promise.resolve();
    ws.receive(JSON.stringify(["COUNT", "count:second", { count: 4 }]));
    await expect(second).resolves.toEqual({ count: 4 });
    expect("hll" in (await second)).toBe(false);
    relay.close();
  });

  test("CLOSED auth-required retries COUNT after AUTH", async () => {
    const keys = Keys.fromSecretKey(SK);
    const relay = await Relay.connect("wss://count-auth.example", {
      websocketImplementation: MockWebSocketCtor,
      authSigner: async (template) =>
        EventBuilder.textNote("")
          .kind(template.kind)
          .tags(template.tags)
          .content(template.content)
          .createdAt(template.created_at)
          .signWithKeys(keys),
    });
    const filters = [{ kinds: [1], authors: [keys.publicKey] }];
    const countP = relay.count(filters, { id: "count:auth", timeoutMs: 2000 });
    await Promise.resolve();
    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["AUTH", "count-challenge"]));
    ws.receive(JSON.stringify(["CLOSED", "count:auth", "auth-required: login"]));
    await new Promise((r) => setTimeout(r, 20));
    const authFrame = ws.sent
      .map((s) => JSON.parse(s) as unknown[])
      .find((m) => m[0] === "AUTH") as [string, { id: string }] | undefined;
    expect(authFrame?.[0]).toBe("AUTH");
    ws.receive(JSON.stringify(["OK", authFrame![1].id, true, ""]));
    await new Promise((r) => setTimeout(r, 20));
    const counts = ws.sent.map((s) => JSON.parse(s) as unknown[]).filter((m) => m[0] === "COUNT");
    expect(counts).toHaveLength(2);
    expect(counts[1]).toEqual(["COUNT", "count:auth", filters[0]]);
    ws.receive(JSON.stringify(["COUNT", "count:auth", { count: 11, approximate: true }]));
    await expect(countP).resolves.toEqual({ count: 11, approximate: true });
    relay.close();
  });

  test("timeout does not fire while AUTH is in flight", async () => {
    const keys = Keys.fromSecretKey(SK);
    const relay = await Relay.connect("wss://count-auth-timeout.example", {
      websocketImplementation: MockWebSocketCtor,
      authSigner: async (template) =>
        EventBuilder.textNote("")
          .kind(template.kind)
          .tags(template.tags)
          .content(template.content)
          .createdAt(template.created_at)
          .signWithKeys(keys),
    });
    const countP = relay.count([{ kinds: [1] }], { id: "count:slow", timeoutMs: 40 });
    await Promise.resolve();
    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["AUTH", "slow-challenge"]));
    ws.receive(JSON.stringify(["CLOSED", "count:slow", "auth-required: login"]));
    await new Promise((r) => setTimeout(r, 20));
    const authFrame = ws.sent
      .map((s) => JSON.parse(s) as unknown[])
      .find((m) => m[0] === "AUTH") as [string, { id: string }] | undefined;
    expect(authFrame?.[0]).toBe("AUTH");
    await new Promise((r) => setTimeout(r, 80));
    ws.receive(JSON.stringify(["OK", authFrame![1].id, true, ""]));
    await new Promise((r) => setTimeout(r, 20));
    ws.receive(JSON.stringify(["COUNT", "count:slow", { count: 2 }]));
    await expect(countP).resolves.toEqual({ count: 2 });
    relay.close();
  });

  test("COUNT times out after AUTH retry, not during AUTH", async () => {
    const keys = Keys.fromSecretKey(SK);
    const relay = await Relay.connect("wss://count-auth-post-timeout.example", {
      websocketImplementation: MockWebSocketCtor,
      authSigner: async (template) =>
        EventBuilder.textNote("")
          .kind(template.kind)
          .tags(template.tags)
          .content(template.content)
          .createdAt(template.created_at)
          .signWithKeys(keys),
    });
    const filters = [{ kinds: [1], authors: [keys.publicKey] }];
    const countP = relay.count(filters, { id: "count:post-auth-timeout", timeoutMs: 40 });
    await Promise.resolve();
    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["AUTH", "post-timeout-challenge"]));
    ws.receive(JSON.stringify(["CLOSED", "count:post-auth-timeout", "auth-required: login"]));
    await new Promise((r) => setTimeout(r, 20));
    const authFrame = ws.sent
      .map((s) => JSON.parse(s) as unknown[])
      .find((m) => m[0] === "AUTH") as [string, { id: string }] | undefined;
    expect(authFrame?.[0]).toBe("AUTH");
    await new Promise((r) => setTimeout(r, 80));
    ws.receive(JSON.stringify(["OK", authFrame![1].id, true, ""]));
    await new Promise((r) => setTimeout(r, 20));
    const counts = ws.sent.map((s) => JSON.parse(s) as unknown[]).filter((m) => m[0] === "COUNT");
    expect(counts).toHaveLength(2);
    expect(counts[1]).toEqual(["COUNT", "count:post-auth-timeout", filters[0]]);
    await expect(countP).rejects.toThrow(/count timed out/);
    relay.close();
  });

  test("auth-required CLOSED with no challenge rejects and does not leak the waiter", async () => {
    const keys = Keys.fromSecretKey(SK);
    const relay = await Relay.connect("wss://count-no-challenge.example", {
      websocketImplementation: MockWebSocketCtor,
      authSigner: async (template) =>
        EventBuilder.textNote("")
          .kind(template.kind)
          .tags(template.tags)
          .content(template.content)
          .createdAt(template.created_at)
          .signWithKeys(keys),
    });
    const first = relay.count([{ kinds: [1] }], { id: "count:nochal", timeoutMs: 2000 });
    await Promise.resolve();
    MockWebSocket.last().receive(
      JSON.stringify(["CLOSED", "count:nochal", "auth-required: login"]),
    );
    await expect(first).rejects.toThrow(/auth-required: login/);

    const second = relay.count([{ kinds: [1] }], { id: "count:nochal2", timeoutMs: 2000 });
    await Promise.resolve();
    MockWebSocket.last().receive(JSON.stringify(["COUNT", "count:nochal2", { count: 8 }]));
    await expect(second).resolves.toEqual({ count: 8 });
    relay.close();
  });

  test("AUTH failure rejects COUNT and a later count still works", async () => {
    const keys = Keys.fromSecretKey(SK);
    const relay = await Relay.connect("wss://count-auth-fail.example", {
      websocketImplementation: MockWebSocketCtor,
      authSigner: async (template) =>
        EventBuilder.textNote("")
          .kind(template.kind)
          .tags(template.tags)
          .content(template.content)
          .createdAt(template.created_at)
          .signWithKeys(keys),
    });
    const first = relay.count([{ kinds: [1] }], { id: "count:fail", timeoutMs: 2000 });
    await Promise.resolve();
    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["AUTH", "fail-challenge"]));
    ws.receive(JSON.stringify(["CLOSED", "count:fail", "auth-required: login"]));
    await new Promise((r) => setTimeout(r, 20));
    const authFrame = ws.sent
      .map((s) => JSON.parse(s) as unknown[])
      .find((m) => m[0] === "AUTH") as [string, { id: string }] | undefined;
    expect(authFrame?.[0]).toBe("AUTH");
    ws.receive(JSON.stringify(["OK", authFrame![1].id, false, "restricted: bad auth"]));
    await expect(first).rejects.toThrow(/auth-required: login/);

    const second = relay.count([{ kinds: [1] }], { id: "count:after-fail", timeoutMs: 2000 });
    await Promise.resolve();
    ws.receive(JSON.stringify(["COUNT", "count:after-fail", { count: 1 }]));
    await expect(second).resolves.toEqual({ count: 1 });
    relay.close();
  });

  test("second auth-required CLOSED does not retry COUNT", async () => {
    const keys = Keys.fromSecretKey(SK);
    const relay = await Relay.connect("wss://count-auth-twice.example", {
      websocketImplementation: MockWebSocketCtor,
      authSigner: async (template) =>
        EventBuilder.textNote("")
          .kind(template.kind)
          .tags(template.tags)
          .content(template.content)
          .createdAt(template.created_at)
          .signWithKeys(keys),
    });
    const countP = relay.count([{ kinds: [1] }], { id: "count:twice", timeoutMs: 2000 });
    await Promise.resolve();
    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["AUTH", "twice-challenge"]));
    ws.receive(JSON.stringify(["CLOSED", "count:twice", "auth-required: login"]));
    await new Promise((r) => setTimeout(r, 20));
    const authFrame = ws.sent
      .map((s) => JSON.parse(s) as unknown[])
      .find((m) => m[0] === "AUTH") as [string, { id: string }] | undefined;
    expect(authFrame?.[0]).toBe("AUTH");
    ws.receive(JSON.stringify(["OK", authFrame![1].id, true, ""]));
    await new Promise((r) => setTimeout(r, 20));
    expect(
      ws.sent.map((s) => JSON.parse(s) as unknown[]).filter((m) => m[0] === "COUNT"),
    ).toHaveLength(2);
    ws.receive(JSON.stringify(["CLOSED", "count:twice", "auth-required: login"]));
    await expect(countP).rejects.toThrow(/auth-required: login/);
    expect(
      ws.sent.map((s) => JSON.parse(s) as unknown[]).filter((m) => m[0] === "COUNT"),
    ).toHaveLength(2);
    relay.close();
  });

  test("authSigner throw rejects COUNT with the thrown Error", async () => {
    const boom = new Error("sign failed");
    const relay = await Relay.connect("wss://count-auth-throw.example", {
      websocketImplementation: MockWebSocketCtor,
      authSigner: async () => {
        throw boom;
      },
    });
    const first = relay.count([{ kinds: [1] }], { id: "count:throw", timeoutMs: 2000 });
    await Promise.resolve();
    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["AUTH", "throw-challenge"]));
    ws.receive(JSON.stringify(["CLOSED", "count:throw", "auth-required: login"]));
    await expect(first).rejects.toBe(boom);

    const second = relay.count([{ kinds: [1] }], { id: "count:after-throw", timeoutMs: 2000 });
    await Promise.resolve();
    ws.receive(JSON.stringify(["COUNT", "count:after-throw", { count: 3 }]));
    await expect(second).resolves.toEqual({ count: 3 });
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

  test("rejects empty and oversize custom ids without sending COUNT", async () => {
    const relay = await Relay.connect("wss://count-id.example", {
      websocketImplementation: MockWebSocketCtor,
    });
    await expect(relay.count([{ kinds: [1] }], { id: "" })).rejects.toThrow(MessageError);
    await expect(relay.count([{ kinds: [1] }], { id: "a".repeat(65) })).rejects.toThrow(
      MessageError,
    );
    expect(
      MockWebSocket.last()
        .sent.map((s) => JSON.parse(s) as unknown[])
        .filter((m) => m[0] === "COUNT"),
    ).toHaveLength(0);
    relay.close();
  });

  test("sends COUNT with a 64-char custom id", async () => {
    const relay = await Relay.connect("wss://count-id-ok.example", {
      websocketImplementation: MockWebSocketCtor,
    });
    const id = "a".repeat(64);
    const countP = relay.count([{ kinds: [1] }], { id, timeoutMs: 2000 });
    await Promise.resolve();
    const countMsg = MockWebSocket.last()
      .sent.map((s) => JSON.parse(s) as unknown[])
      .find((m) => m[0] === "COUNT") as [string, string, ...unknown[]];
    expect(countMsg[1]).toBe(id);
    MockWebSocket.last().receive(JSON.stringify(["COUNT", id, { count: 1 }]));
    await expect(countP).resolves.toEqual({ count: 1 });
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
