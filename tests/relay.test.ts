import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Keys,
  Pool,
  Relay,
  isInsecureRelayUrl,
  useWebSocketImplementation,
  verifyEvent,
} from "../src/index.ts";
import type { WebSocketConstructor } from "../src/relay/websocket.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error("timeout waiting for condition");
}

function sentMessages(ws: MockWebSocket): unknown[][] {
  return ws.sent.map((s) => JSON.parse(s) as unknown[]);
}

function dummyPingReqs(
  ws: MockWebSocket,
): Array<[string, string, { ids: string[]; limit: number }]> {
  return sentMessages(ws).filter(
    (m) => m[0] === "REQ" && String(m[1]).startsWith("__ping__"),
  ) as Array<[string, string, { ids: string[]; limit: number }]>;
}

class NativePingSocket extends MockWebSocket {
  pingCalls = 0;
  pongAddEventListenerCalls = 0;
  pongEnabled = true;
  #once = new Map<string, Set<(...args: unknown[]) => void>>();

  override addEventListener(type: string, listener: (ev: unknown) => void): void {
    if (type === "pong") this.pongAddEventListenerCalls += 1;
    super.addEventListener(type, listener);
  }

  ping(): void {
    this.pingCalls += 1;
    if (!this.pongEnabled) return;
    queueMicrotask(() => {
      const set = this.#once.get("pong");
      if (!set) return;
      this.#once.delete("pong");
      for (const fn of set) fn();
    });
  }

  once(event: string, listener: (...args: unknown[]) => void): void {
    let set = this.#once.get(event);
    if (!set) {
      set = new Set();
      this.#once.set(event, set);
    }
    set.add(listener);
  }
}

const NativePingCtor = NativePingSocket as unknown as WebSocketConstructor;

class PingOnlySocket extends MockWebSocket {
  pingCalls = 0;
  ping(): void {
    this.pingCalls += 1;
  }
}

const PingOnlyCtor = PingOnlySocket as unknown as WebSocketConstructor;

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

beforeEach(() => {
  MockWebSocket.reset();
  useWebSocketImplementation(MockWebSocketCtor);
});

afterEach(() => {
  MockWebSocket.reset();
});

describe("Relay", () => {
  test("connect, subscribe, receive events, eose", async () => {
    const relay = new Relay("wss://relay.example.com");
    const connectP = relay.connect();
    // allow microtask open
    await connectP;
    expect(relay.connected).toBe(true);

    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("hi").createdAt(1).signWithKeys(keys);

    const events: (typeof note)[] = [];
    let eosed = false;

    const sub = relay.subscribe([{ kinds: [1] }], {
      onevent: (e) => events.push(e),
      oneose: () => {
        eosed = true;
      },
    });

    const ws = MockWebSocket.last();
    const req = ws.lastSent() as [string, string, ...unknown[]];
    expect(req[0]).toBe("REQ");
    expect(req[1]).toBe(sub.id);

    ws.receive(JSON.stringify(["EVENT", sub.id, note]));
    ws.receive(JSON.stringify(["EOSE", sub.id]));

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(note.id);
    expect(verifyEvent(events[0]!)).toBe(true);
    expect(eosed).toBe(true);

    sub.close();
    const closeMsg = ws.lastSent() as [string, string];
    expect(closeMsg[0]).toBe("CLOSE");
    relay.close();
  });

  test("publish waits for OK", async () => {
    const relay = await Relay.connect("wss://relay.example.com");
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("pub").createdAt(2).signWithKeys(keys);

    const publishP = relay.publish(note);
    const ws = MockWebSocket.last();
    const sent = ws.lastSent() as [string, typeof note];
    expect(sent[0]).toBe("EVENT");
    expect(sent[1].id).toBe(note.id);

    ws.receive(JSON.stringify(["OK", note.id, true, ""]));
    const result = await publishP;
    expect(result.ok).toBe(true);
    relay.close();
  });

  test("fetch collects until eose", async () => {
    const relay = await Relay.connect("wss://relay.example.com");
    const keys = Keys.fromSecretKey(SK);
    const a = EventBuilder.textNote("a").createdAt(1).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(2).signWithKeys(keys);

    const fetchP = relay.fetch([{ kinds: [1] }], { timeoutMs: 2000 });
    // let REQ go out
    await Promise.resolve();
    const ws = MockWebSocket.last();
    const req = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "REQ") as [string, string];
    ws.receive(JSON.stringify(["EVENT", req[1], a]));
    ws.receive(JSON.stringify(["EVENT", req[1], b]));
    ws.receive(JSON.stringify(["EOSE", req[1]]));

    const events = await fetchP;
    expect(events.map((e) => e.content).sort()).toEqual(["a", "b"]);
    relay.close();
  });

  test("rejects invalid signatures", async () => {
    const relay = await Relay.connect("wss://relay.example.com");
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("x").createdAt(1).signWithKeys(keys);
    const bad = { ...note, content: "tampered" };

    const events: unknown[] = [];
    const sub = relay.subscribe([{ kinds: [1] }], {
      onevent: (e) => events.push(e),
    });
    MockWebSocket.last().receive(JSON.stringify(["EVENT", sub.id, bad]));
    expect(events).toHaveLength(0);
    relay.close();
  });
});

describe("Pool", () => {
  test("fetch dedupes across relays", async () => {
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("shared").createdAt(1).signWithKeys(keys);

    const fetchP = pool.fetch(["wss://a.example", "wss://b.example"], [{ kinds: [1] }], {
      timeoutMs: 2000,
    });

    // wait for both sockets
    await new Promise((r) => setTimeout(r, 10));
    expect(MockWebSocket.instances.length).toBe(2);

    for (const ws of MockWebSocket.instances) {
      const req = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "REQ") as [string, string];
      ws.receive(JSON.stringify(["EVENT", req[1], note]));
      ws.receive(JSON.stringify(["EOSE", req[1]]));
    }

    const events = await fetchP;
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(note.id);
    pool.close();
  });

  test("publish fans out", async () => {
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("fan").createdAt(1).signWithKeys(keys);

    const publishP = pool.publish(["wss://a.example", "wss://b.example"], note);
    await new Promise((r) => setTimeout(r, 10));

    for (const ws of MockWebSocket.instances) {
      const eventMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "EVENT") as [
        string,
        typeof note,
      ];
      ws.receive(JSON.stringify(["OK", eventMsg[1].id, true, ""]));
    }

    const results = await publishP;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.result?.ok)).toBe(true);
    pool.close();
  });
});

describe("isInsecureRelayUrl", () => {
  test("ws/http without .onion are insecure; onion and wss are not", () => {
    expect(isInsecureRelayUrl("ws://x.com")).toBe(true);
    expect(isInsecureRelayUrl("http://x.com")).toBe(true);
    expect(isInsecureRelayUrl("wss://x.com")).toBe(false);
    expect(isInsecureRelayUrl("ws://foo.onion")).toBe(false);
    expect(isInsecureRelayUrl("ws://192.168.1.9")).toBe(true);
  });
});

describe("alreadyHaveEvent / receivedEvent", () => {
  test("alreadyHaveEvent true skips verify and onevent; receivedEvent still fires", async () => {
    let verifies = 0;
    const relay = await Relay.connect("wss://have.example", {
      websocketImplementation: MockWebSocketCtor,
      verifyEvent: (event) => {
        verifies += 1;
        return verifyEvent(event);
      },
    });
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("dup").createdAt(1).signWithKeys(keys);
    const received: string[] = [];
    const events: unknown[] = [];

    const sub = relay.subscribe([{ kinds: [1] }], {
      alreadyHaveEvent: () => true,
      receivedEvent: (id) => received.push(id),
      onevent: (e) => events.push(e),
    });

    MockWebSocket.last().receive(JSON.stringify(["EVENT", sub.id, note]));
    expect(received).toEqual([note.id]);
    expect(events).toHaveLength(0);
    expect(verifies).toBe(0);
    relay.close();
  });

  test("Pool.subscribe two relays verifies once and records receivedEvent", async () => {
    let verifies = 0;
    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      verifyEvent: (event) => {
        verifies += 1;
        return verifyEvent(event);
      },
    });
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("shared-sub").createdAt(1).signWithKeys(keys);
    const events: string[] = [];
    const received: string[] = [];

    const closer = pool.subscribe(["wss://a.example", "wss://b.example"], [{ kinds: [1] }], {
      receivedEvent: (id) => received.push(id),
      onevent: (e) => events.push(e.id),
    });

    await waitUntil(
      () =>
        MockWebSocket.instances.length === 2 &&
        MockWebSocket.instances.every((ws) => sentMessages(ws).some((m) => m[0] === "REQ")),
    );
    for (const ws of MockWebSocket.instances) {
      const req = sentMessages(ws).find((m) => m[0] === "REQ") as [string, string];
      ws.receive(JSON.stringify(["EVENT", req[1], note]));
    }

    expect(verifies).toBe(1);
    expect(events).toEqual([note.id]);
    expect(received).toEqual([note.id, note.id]);
    closer.close();
    pool.close();
  });

  test("failed verify is not added to Pool seen; later valid copy surfaces", async () => {
    let verifies = 0;
    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      verifyEvent: (event) => {
        verifies += 1;
        return verifyEvent(event);
      },
    });
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("ok").createdAt(1).signWithKeys(keys);
    const bad = { ...note, content: "tampered" };
    const events: string[] = [];

    const closer = pool.subscribe(["wss://seen.example"], [{ kinds: [1] }], {
      onevent: (e) => events.push(e.id),
    });
    await waitUntil(
      () =>
        MockWebSocket.instances.length > 0 &&
        sentMessages(MockWebSocket.last()).some((m) => m[0] === "REQ"),
    );
    const ws = MockWebSocket.last();
    const req = sentMessages(ws).find((m) => m[0] === "REQ") as [string, string];
    ws.receive(JSON.stringify(["EVENT", req[1], bad]));
    expect(events).toHaveLength(0);
    ws.receive(JSON.stringify(["EVENT", req[1], note]));
    expect(events).toEqual([note.id]);
    expect(verifies).toBe(2);
    closer.close();
    pool.close();
  });
});

describe("insecure URL policy", () => {
  test("allowInsecure false rejects ws unless trusted", async () => {
    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      allowInsecure: false,
    });
    await expect(pool.ensureRelay("ws://evil.example")).rejects.toThrow(
      /insecure relay connection blocked/,
    );
    pool.setTrustedInsecureUrls(["ws://evil.example"]);
    const relay = await pool.ensureRelay("ws://evil.example");
    expect(relay.connected).toBe(true);
    pool.close();
  });

  test("setAllowInsecure toggles the check", async () => {
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    const first = await pool.ensureRelay("ws://open.example");
    expect(first.connected).toBe(true);
    pool.close(["ws://open.example"]);
    pool.setAllowInsecure(false);
    await expect(pool.ensureRelay("ws://open.example")).rejects.toThrow(
      /insecure relay connection blocked/,
    );
    pool.close();
  });
});

describe("idle cleanup", () => {
  test("subscribe holds relay; after close + idleTimeout cleanIdleRelays drops it", async () => {
    const closed: string[] = [];
    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      idleTimeoutMs: 30,
      onIdleRelaysClosed: (urls) => closed.push(...urls),
    });
    try {
      const relay = await pool.ensureRelay("wss://idle.example");
      const sub = relay.subscribe([{ kinds: [1] }]);
      expect(relay.subscriptionCount).toBe(1);
      await sleep(50);
      pool.cleanIdleRelays();
      expect(pool.listRelays()).toHaveLength(1);

      sub.close();
      expect(relay.subscriptionCount).toBe(0);
      await sleep(40);
      pool.cleanIdleRelays();
      expect(pool.listRelays()).toHaveLength(0);
      expect(closed.length).toBeGreaterThan(0);
    } finally {
      pool.close();
    }
  });

  test("cleanIdleRelays is a no-op when idleTimeoutMs is unset", async () => {
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    try {
      await pool.ensureRelay("wss://keep.example");
      await sleep(20);
      pool.cleanIdleRelays();
      expect(pool.listRelays()).toHaveLength(1);
    } finally {
      pool.close();
    }
  });
});

describe("ping", () => {
  test("dummy REQ is outside #subs; EOSE sends CLOSE and leaves subscriptionCount 0", async () => {
    const relay = await Relay.connect("wss://ping-dummy.example", {
      websocketImplementation: MockWebSocketCtor,
      enablePing: true,
      pingIntervalMs: 30,
      pingTimeoutMs: 400,
    });
    try {
      const ws = MockWebSocket.last();
      await waitUntil(() => dummyPingReqs(ws).length > 0);
      expect(relay.subscriptionCount).toBe(0);

      const ping = dummyPingReqs(ws)[0]!;
      expect(ping[2]).toEqual({ ids: ["a".repeat(64)], limit: 0 });
      ws.receive(JSON.stringify(["EOSE", ping[1]]));
      expect(relay.subscriptionCount).toBe(0);
      expect(relay.connected).toBe(true);
      expect(sentMessages(ws).some((m) => m[0] === "CLOSE" && m[1] === ping[1])).toBe(true);
    } finally {
      relay.close();
    }
  });

  test("dummy ping CLOSED is liveness; CLOSE is sent; subscriptionCount stays 0", async () => {
    const relay = await Relay.connect("wss://ping-closed.example", {
      websocketImplementation: MockWebSocketCtor,
      enablePing: true,
      pingIntervalMs: 30,
      pingTimeoutMs: 400,
    });
    try {
      const ws = MockWebSocket.last();
      await waitUntil(() => dummyPingReqs(ws).length > 0);
      const ping = dummyPingReqs(ws)[0]!;
      ws.receive(JSON.stringify(["CLOSED", ping[1], "rate-limited"]));
      expect(relay.subscriptionCount).toBe(0);
      expect(relay.connected).toBe(true);
      expect(sentMessages(ws).some((m) => m[0] === "CLOSE" && m[1] === ping[1])).toBe(true);
    } finally {
      relay.close();
    }
  });

  test("dummy ping does not block idle cleanup", async () => {
    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      enablePing: true,
      pingIntervalMs: 30,
      pingTimeoutMs: 400,
      idleTimeoutMs: 40,
    });
    try {
      const relay = await pool.ensureRelay("wss://ping-idle.example");
      const ws = MockWebSocket.last();
      await waitUntil(() => dummyPingReqs(ws).length > 0);
      const ping = dummyPingReqs(ws)[0]!;
      ws.receive(JSON.stringify(["EOSE", ping[1]]));
      expect(relay.subscriptionCount).toBe(0);
      await sleep(50);
      pool.cleanIdleRelays();
      expect(pool.listRelays()).toHaveLength(0);
    } finally {
      pool.close();
    }
  });

  test("native ping uses once('pong'), not addEventListener('pong')", async () => {
    const relay = await Relay.connect("wss://ping-native.example", {
      websocketImplementation: NativePingCtor,
      enablePing: true,
      pingIntervalMs: 30,
      pingTimeoutMs: 400,
    });
    try {
      const ws = MockWebSocket.last() as NativePingSocket;
      await waitUntil(() => ws.pingCalls > 0);
      expect(ws.pongAddEventListenerCalls).toBe(0);
      expect(dummyPingReqs(ws)).toHaveLength(0);
      expect(relay.connected).toBe(true);
      expect(relay.subscriptionCount).toBe(0);
    } finally {
      relay.close();
    }
  });

  test("native ping timeout without pong closes the socket", async () => {
    const relay = await Relay.connect("wss://ping-timeout.example", {
      websocketImplementation: NativePingCtor,
      enablePing: true,
      pingIntervalMs: 20,
      pingTimeoutMs: 40,
    });
    try {
      const ws = MockWebSocket.last() as NativePingSocket;
      ws.pongEnabled = false;
      await waitUntil(() => ws.pingCalls > 0);
      await waitUntil(() => !relay.connected);
      expect(relay.connected).toBe(false);
    } finally {
      relay.close();
    }
  });

  test("ping without once/on falls back to dummy REQ", async () => {
    const relay = await Relay.connect("wss://ping-only.example", {
      websocketImplementation: PingOnlyCtor,
      enablePing: true,
      pingIntervalMs: 30,
      pingTimeoutMs: 400,
    });
    try {
      const ws = MockWebSocket.last() as PingOnlySocket;
      await waitUntil(() => dummyPingReqs(ws).length > 0);
      expect(ws.pingCalls).toBe(0);
      expect(relay.subscriptionCount).toBe(0);
      const ping = dummyPingReqs(ws)[0]!;
      ws.receive(JSON.stringify(["EOSE", ping[1]]));
      expect(relay.connected).toBe(true);
    } finally {
      relay.close();
    }
  });
});
