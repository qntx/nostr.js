import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Keys,
  Pool,
  Relay,
  RelayClosedError,
  RelayStatus,
  isInsecureRelayUrl,
  useWebSocketImplementation,
  verifyEvent,
} from "../src/index.ts";
import type { WebSocketConstructor } from "../src/relay/websocket.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureError(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected reject");
    },
    (err: unknown) => err,
  );
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

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.#once.get(event)?.delete(listener);
  }

  pongListenerCount(): number {
    return this.#once.get("pong")?.size ?? 0;
  }
}

class NodeWsPingSocket extends MockWebSocket {
  pingCalls = 0;
  pongEnabled = false;
  #listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  ping(): void {
    this.pingCalls += 1;
    if (!this.pongEnabled) return;
    queueMicrotask(() => {
      for (const fn of this.#listeners.get("pong") ?? []) fn();
    });
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
  }

  once(event: string, listener: (...args: unknown[]) => void): void {
    const wrap = (...args: unknown[]) => {
      this.off(event, wrap);
      listener(...args);
    };
    this.on(event, wrap);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.#listeners.get(event)?.delete(listener);
  }

  pongListenerCount(): number {
    return this.#listeners.get("pong")?.size ?? 0;
  }
}

class NativeTimeoutSocket extends NativePingSocket {
  pongEnabled = false;
}

const NativePingCtor = NativePingSocket as unknown as WebSocketConstructor;
const NativeTimeoutCtor = NativeTimeoutSocket as unknown as WebSocketConstructor;
const NodeWsPingCtor = NodeWsPingSocket as unknown as WebSocketConstructor;

class PingOnlySocket extends MockWebSocket {
  pingCalls = 0;
  ping(): void {
    this.pingCalls += 1;
  }
}

const PingOnlyCtor = PingOnlySocket as unknown as WebSocketConstructor;

/** removeEventListener is a no-op so stale open/close can still hit captured handlers. */
class StickyListenersSocket extends MockWebSocket {
  override removeEventListener(_type: string, _listener: (ev: unknown) => void): void {}
}

const StickyListenersCtor = StickyListenersSocket as unknown as WebSocketConstructor;

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

  test("forged EVENT with huge created_at does not move watermark", async () => {
    let verifies = 0;
    const relay = await Relay.connect("wss://forged-wm.example", {
      verifyEvent: (event) => {
        verifies += 1;
        return verifyEvent(event);
      },
    });
    const keys = Keys.fromSecretKey(SK);
    const good = EventBuilder.textNote("ok").createdAt(10).signWithKeys(keys);
    const forgedId = "bb".repeat(32);
    const forged = { ...good, id: forgedId, created_at: 999_999 };
    const events: string[] = [];
    const sub = relay.subscribe([{ kinds: [1], since: 5 }], {
      onevent: (e) => events.push(e.id),
    });

    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["EVENT", sub.id, good]));
    expect(events).toEqual([good.id]);
    expect(verifies).toBe(1);
    expect(sub.lastCreatedAt).toBe(10);
    expect([...sub.idsAtWatermark]).toEqual([good.id]);
    expect(sub.filters[0]!.since).toBe(5);
    expect(sub.replayFilters()[0]!.since).toBe(10);

    ws.receive(JSON.stringify(["EVENT", sub.id, forged]));
    expect(verifies).toBe(2);
    expect(events).toEqual([good.id]);
    expect(sub.lastCreatedAt).toBe(10);
    expect(sub.idsAtWatermark.has(good.id)).toBe(true);
    expect(sub.idsAtWatermark.has(forgedId)).toBe(false);
    expect(sub.idsAtWatermark.size).toBe(1);
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
    expect(sub.lastCreatedAt).toBeUndefined();
    expect(sub.idsAtWatermark.size).toBe(0);
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
      websocketImplementation: NativeTimeoutCtor,
      enablePing: true,
      pingIntervalMs: 20,
      pingTimeoutMs: 40,
    });
    try {
      const ws = MockWebSocket.last() as NativeTimeoutSocket;
      await waitUntil(() => ws.pingCalls > 0);
      await waitUntil(() => !relay.connected);
      expect(relay.connected).toBe(false);
      expect(ws.pongListenerCount()).toBe(0);
    } finally {
      relay.close();
    }
  });

  test("native ping on node ws uses on/off and timeout drops the pong listener", async () => {
    const relay = await Relay.connect("wss://ping-ws.example", {
      websocketImplementation: NodeWsPingCtor,
      enablePing: true,
      pingIntervalMs: 20,
      pingTimeoutMs: 40,
    });
    try {
      const ws = MockWebSocket.last() as NodeWsPingSocket;
      await waitUntil(() => ws.pingCalls > 0);
      expect(dummyPingReqs(ws)).toHaveLength(0);
      await waitUntil(() => !relay.connected);
      expect(ws.pongListenerCount()).toBe(0);
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

describe("Relay generation / close", () => {
  test("close() during in-flight connect() rejects; next connect() is a new handshake", async () => {
    MockWebSocket.autoConnect = false;
    const relay = new Relay("wss://gen-close.example", {
      websocketImplementation: MockWebSocketCtor,
    });
    const first = relay.connect();
    const coalesced = relay.connect();
    expect(MockWebSocket.instances.length).toBe(1);
    expect(relay.status).toBe(RelayStatus.Connecting);
    const firstWs = MockWebSocket.last();
    const firstClosed = captureError(first);
    const coalescedClosed = captureError(coalesced);
    relay.close();
    expect(await firstClosed).toBeInstanceOf(RelayClosedError);
    expect(await coalescedClosed).toBeInstanceOf(RelayClosedError);
    expect(relay.status).toBe(RelayStatus.Closed);
    expect(relay.connected).toBe(false);

    MockWebSocket.autoConnect = true;
    const second = relay.connect();
    expect(second).not.toBe(first);
    await second;
    expect(relay.connected).toBe(true);
    expect(relay.status).toBe(RelayStatus.Connected);
    expect(MockWebSocket.instances.length).toBe(2);
    expect(MockWebSocket.last()).not.toBe(firstWs);
    relay.close();
  });

  test("late open after close() does not set connected and does not send REQ", async () => {
    MockWebSocket.autoConnect = false;
    const relay = new Relay("wss://late-open.example", {
      websocketImplementation: StickyListenersCtor,
    });
    const connecting = relay.connect();
    const firstWs = MockWebSocket.last();
    const closed = captureError(connecting);
    relay.close();
    expect(await closed).toBeInstanceOf(RelayClosedError);

    MockWebSocket.autoConnect = true;
    await relay.connect();
    const secondWs = MockWebSocket.last();
    expect(secondWs).not.toBe(firstWs);
    expect(relay.connected).toBe(true);
    relay.subscribe([{ kinds: [1] }]);
    expect(sentMessages(secondWs).filter((m) => m[0] === "REQ")).toHaveLength(1);
    expect(sentMessages(firstWs).filter((m) => m[0] === "REQ")).toHaveLength(0);

    firstWs.open();
    expect(relay.connected).toBe(true);
    expect(relay.status).toBe(RelayStatus.Connected);
    expect(MockWebSocket.last()).toBe(secondWs);
    expect(sentMessages(secondWs).filter((m) => m[0] === "REQ")).toHaveLength(1);
    expect(sentMessages(firstWs).filter((m) => m[0] === "REQ")).toHaveLength(0);
    relay.close();
  });

  test("close() then connect() succeeds with a new generation", async () => {
    const relay = new Relay("wss://reopen.example", {
      websocketImplementation: MockWebSocketCtor,
    });
    await relay.connect();
    const genAfterConnect = relay.generation;
    relay.close();
    expect(relay.status).toBe(RelayStatus.Closed);
    expect(relay.generation).toBeGreaterThan(genAfterConnect);
    await relay.connect();
    expect(relay.connected).toBe(true);
    expect(relay.status).toBe(RelayStatus.Connected);
    expect(relay.generation).toBeGreaterThan(genAfterConnect);
    relay.close();
  });

  test("stale connect timeout after close() does not kill the next socket", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const held: Array<() => void> = [];
    globalThis.setTimeout = ((handler: unknown, delay?: number, ...args: unknown[]) => {
      if (delay === 80 && typeof handler === "function") {
        held.push(() => {
          (handler as (...a: unknown[]) => void)(...args);
        });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler as Parameters<typeof setTimeout>[0], delay, ...args);
    }) as typeof setTimeout;

    try {
      MockWebSocket.autoConnect = false;
      const relay = new Relay("wss://stale-timeout.example", {
        websocketImplementation: MockWebSocketCtor,
        connectTimeoutMs: 10_000,
        enableReconnect: true,
        reconnectBackoffMs: [10],
      });
      const first = relay.connect({ timeoutMs: 80 });
      const firstClosed = captureError(first);
      relay.close();
      expect(await firstClosed).toBeInstanceOf(RelayClosedError);
      expect(held).toHaveLength(1);

      MockWebSocket.autoConnect = true;
      await relay.connect();
      expect(relay.connected).toBe(true);
      const secondWs = MockWebSocket.last();
      let secondCloseCalls = 0;
      const origClose = secondWs.close.bind(secondWs);
      secondWs.close = () => {
        secondCloseCalls += 1;
        origClose();
      };

      held[0]!();
      expect(relay.connected).toBe(true);
      expect(relay.status).toBe(RelayStatus.Connected);
      expect(secondWs.readyState).toBe(MockWebSocket.OPEN);
      expect(secondCloseCalls).toBe(0);

      relay.subscribe([{ kinds: [1] }], {});
      const before = MockWebSocket.instances.length;
      secondWs.close();
      await waitUntil(() => MockWebSocket.instances.length > before && relay.connected);
      expect(relay.connected).toBe(true);
      relay.close();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("WebSocket constructor throw leaves Closed status", async () => {
    class BoomSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(_url: string) {
        throw new Error("no socket");
      }
    }
    const relay = new Relay("wss://boom.example", {
      websocketImplementation: BoomSocket as unknown as WebSocketConstructor,
    });
    await expect(relay.connect()).rejects.toThrow("no socket");
    expect(relay.status).toBe(RelayStatus.Closed);
    expect(relay.connected).toBe(false);
  });

  test("intentional close does not schedule reconnect", async () => {
    const relay = new Relay("wss://nogo-gen.example", {
      enableReconnect: true,
      reconnectBackoffMs: [10],
      websocketImplementation: MockWebSocketCtor,
    });
    await relay.connect();
    relay.subscribe([{ kinds: [1] }], {});
    const before = MockWebSocket.instances.length;
    relay.close();
    await sleep(30);
    expect(MockWebSocket.instances.length).toBe(before);
    expect(relay.status).toBe(RelayStatus.Closed);
  });
});

function socketFor(substr: string): MockWebSocket {
  const ws = MockWebSocket.instances.find((s) => s.url.includes(substr));
  if (!ws) throw new Error(`no socket matching ${substr}`);
  return ws;
}

function reqId(ws: MockWebSocket): string {
  const req = sentMessages(ws).find((m) => m[0] === "REQ") as [string, string] | undefined;
  if (!req) throw new Error(`no REQ on ${ws.url}`);
  return req[1];
}

describe("Relay synthetic EOSE", () => {
  test("eoseTimeoutMs fires oneose without CLOSE; later EOSE is ignored; EVENT still delivered; reconnect allows a new oneose", async () => {
    const relay = await Relay.connect("wss://synth-eose.example", {
      websocketImplementation: MockWebSocketCtor,
      enableReconnect: true,
      reconnectBackoffMs: [10],
    });
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("live").createdAt(1).signWithKeys(keys);
    const events: string[] = [];
    let eose = 0;
    const sub = relay.subscribe([{ kinds: [1] }], {
      eoseTimeoutMs: 40,
      onevent: (e) => events.push(e.id),
      oneose: () => {
        eose += 1;
      },
    });
    const first = MockWebSocket.last();
    await waitUntil(() => sentMessages(first).some((m) => m[0] === "REQ"));
    await waitUntil(() => eose === 1);
    expect(sentMessages(first).some((m) => m[0] === "CLOSE")).toBe(false);

    first.receive(JSON.stringify(["EVENT", sub.id, note]));
    expect(events).toEqual([note.id]);
    first.receive(JSON.stringify(["EOSE", sub.id]));
    expect(eose).toBe(1);

    first.close();
    await waitUntil(() => {
      const live = MockWebSocket.instances.find(
        (ws) =>
          ws !== first &&
          ws.url.includes("synth-eose.example") &&
          ws.readyState === MockWebSocket.OPEN,
      );
      return Boolean(live && sentMessages(live).some((m) => m[0] === "REQ"));
    });
    const second = MockWebSocket.instances.find(
      (ws) =>
        ws !== first &&
        ws.url.includes("synth-eose.example") &&
        ws.readyState === MockWebSocket.OPEN,
    )!;
    second.receive(JSON.stringify(["EOSE", sub.id]));
    expect(eose).toBe(2);
    relay.close();
  });
});

describe("Pool aggregated EOSE", () => {
  test("two relays both EOSE fire oneose once", async () => {
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    let eose = 0;
    const closer = pool.subscribe(["wss://a.example", "wss://b.example"], [{ kinds: [1] }], {
      oneose: () => {
        eose += 1;
      },
    });
    await waitUntil(
      () =>
        MockWebSocket.instances.length === 2 &&
        MockWebSocket.instances.every((ws) => sentMessages(ws).some((m) => m[0] === "REQ")),
    );
    for (const ws of MockWebSocket.instances) {
      ws.receive(JSON.stringify(["EOSE", reqId(ws)]));
    }
    expect(eose).toBe(1);
    closer.close();
    pool.close();
  });

  test("one silent relay plus eoseTimeoutMs fires oneose once and does not CLOSE the silent REQ", async () => {
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    let eose = 0;
    const closer = pool.subscribe(
      ["wss://loud.example", "wss://silent.example"],
      [{ kinds: [1] }],
      {
        eoseTimeoutMs: 50,
        oneose: () => {
          eose += 1;
        },
      },
    );
    await waitUntil(
      () =>
        MockWebSocket.instances.length === 2 &&
        MockWebSocket.instances.every((ws) => sentMessages(ws).some((m) => m[0] === "REQ")),
    );
    const loud = socketFor("loud.example");
    const silent = socketFor("silent.example");
    loud.receive(JSON.stringify(["EOSE", reqId(loud)]));
    expect(eose).toBe(0);
    await waitUntil(() => eose === 1);
    expect(eose).toBe(1);
    expect(sentMessages(silent).some((m) => m[0] === "CLOSE")).toBe(false);
    closer.close();
    pool.close();
  });

  test("connect failure plus EOSE fires oneose once", async () => {
    MockWebSocket.autoConnect = false;
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    let eose = 0;
    const closer = pool.subscribe(["wss://ok.example", "wss://fail.example"], [{ kinds: [1] }], {
      connectionTimeoutMs: 40,
      oneose: () => {
        eose += 1;
      },
    });
    await waitUntil(() => MockWebSocket.instances.length === 2);
    socketFor("ok.example").open();
    await waitUntil(() => sentMessages(socketFor("ok.example")).some((m) => m[0] === "REQ"));
    const ok = socketFor("ok.example");
    ok.receive(JSON.stringify(["EOSE", reqId(ok)]));
    await waitUntil(() => eose === 1);
    expect(eose).toBe(1);
    closer.close();
    pool.close();
  });

  test("caller close before EOSE fires onclose and not oneose", async () => {
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    let eose = 0;
    let closed: string | undefined;
    const closer = pool.subscribe(["wss://a.example", "wss://b.example"], [{ kinds: [1] }], {
      oneose: () => {
        eose += 1;
      },
      onclose: (reason) => {
        closed = reason;
      },
    });
    await waitUntil(
      () =>
        MockWebSocket.instances.length === 2 &&
        MockWebSocket.instances.every((ws) => sentMessages(ws).some((m) => m[0] === "REQ")),
    );
    closer.close("stop");
    expect(closed).toBe("stop");
    expect(eose).toBe(0);
    pool.close();
  });

  test("abort before EOSE fires onclose and not oneose", async () => {
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    const ac = new AbortController();
    let eose = 0;
    let closed: string | undefined;
    pool.subscribe(["wss://a.example", "wss://b.example"], [{ kinds: [1] }], {
      signal: ac.signal,
      oneose: () => {
        eose += 1;
      },
      onclose: (reason) => {
        closed = reason;
      },
    });
    await waitUntil(
      () =>
        MockWebSocket.instances.length === 2 &&
        MockWebSocket.instances.every((ws) => sentMessages(ws).some((m) => m[0] === "REQ")),
    );
    ac.abort();
    expect(closed).toBe("aborted");
    expect(eose).toBe(0);
    pool.close();
  });

  test("empty relay list fires onclose(no relays) and not oneose", async () => {
    const pool = new Pool({ websocketImplementation: MockWebSocketCtor });
    let eose = 0;
    let closed: string | undefined;
    pool.subscribe([], [{ kinds: [1] }], {
      oneose: () => {
        eose += 1;
      },
      onclose: (reason) => {
        closed = reason;
      },
    });
    await waitUntil(() => closed !== undefined);
    expect(closed).toBe("no relays");
    expect(eose).toBe(0);
    pool.close();
  });

  test("reconnect EOSE on one URL does not complete the set while the other is silent", async () => {
    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      enableReconnect: true,
      reconnectBackoffMs: [10],
    });
    let eose = 0;
    const closer = pool.subscribe(["wss://a.example", "wss://b.example"], [{ kinds: [1] }], {
      oneose: () => {
        eose += 1;
      },
    });
    await waitUntil(
      () =>
        MockWebSocket.instances.length === 2 &&
        MockWebSocket.instances.every((ws) => sentMessages(ws).some((m) => m[0] === "REQ")),
    );
    const firstA = socketFor("a.example");
    const b = socketFor("b.example");
    firstA.receive(JSON.stringify(["EOSE", reqId(firstA)]));
    expect(eose).toBe(0);

    firstA.close();
    await waitUntil(() => {
      const live = MockWebSocket.instances.find(
        (ws) =>
          ws !== firstA && ws.url.includes("a.example") && ws.readyState === MockWebSocket.OPEN,
      );
      return Boolean(live && sentMessages(live).some((m) => m[0] === "REQ"));
    });
    const secondA = MockWebSocket.instances.find(
      (ws) => ws !== firstA && ws.url.includes("a.example") && ws.readyState === MockWebSocket.OPEN,
    )!;
    secondA.receive(JSON.stringify(["EOSE", reqId(secondA)]));
    await sleep(20);
    expect(eose).toBe(0);

    b.receive(JSON.stringify(["EOSE", reqId(b)]));
    expect(eose).toBe(1);
    closer.close();
    pool.close();
  });
});
