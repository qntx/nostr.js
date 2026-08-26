import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { EventBuilder, Keys, KeysSigner, Relay, useWebSocketImplementation } from "../src/index.ts";
import { decrypt as nip04Decrypt, encrypt as nip04Encrypt } from "../src/nips/nip04.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const SK2 = "0000000000000000000000000000000000000000000000000000000000000001";

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

function reqFilters(ws: MockWebSocket): Array<[string, string, ...Record<string, unknown>[]]> {
  return sentMessages(ws).filter((m) => m[0] === "REQ") as Array<
    [string, string, ...Record<string, unknown>[]]
  >;
}

class FailReqSocket extends MockWebSocket {
  static failNextReq = false;
  send(data: string): void {
    const msg = JSON.parse(data) as unknown[];
    if (FailReqSocket.failNextReq && msg[0] === "REQ") {
      FailReqSocket.failNextReq = false;
      throw new Error("forced REQ send failure");
    }
    super.send(data);
  }
}

const FailReqCtor = FailReqSocket as unknown as typeof MockWebSocketCtor;

beforeEach(() => {
  MockWebSocket.reset();
  FailReqSocket.failNextReq = false;
  useWebSocketImplementation(MockWebSocketCtor);
});

afterEach(() => {
  FailReqSocket.failNextReq = false;
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

  test("failed initial connect with enableReconnect keeps a live sub and REQ on socket 2", async () => {
    MockWebSocket.failConnect = true;
    const relay = new Relay("wss://first-fail.example", {
      enableReconnect: true,
      reconnectBackoffMs: [80],
      websocketImplementation: MockWebSocketCtor,
    });
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("after first fail").createdAt(1).signWithKeys(keys);
    const events: string[] = [];
    let eose = 0;
    let closed: string | undefined;
    const connecting = relay.connect();
    const sub = relay.subscribe([{ kinds: [1] }], {
      onevent: (e) => events.push(e.id),
      oneose: () => {
        eose += 1;
      },
      onclose: (reason) => {
        closed = reason;
      },
    });
    await expect(connecting).rejects.toThrow();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.readyState).toBe(MockWebSocket.CLOSED);
    expect(sub.closed).toBe(false);
    expect(closed).toBeUndefined();
    expect(eose).toBe(0);

    MockWebSocket.failConnect = false;
    await waitUntil(
      () =>
        relay.connected &&
        MockWebSocket.instances.length >= 2 &&
        sentMessages(MockWebSocket.last()).some((m) => m[0] === "REQ"),
    );
    expect(sub.closed).toBe(false);
    expect(closed).toBeUndefined();
    expect(eose).toBe(0);

    const second = MockWebSocket.last();
    expect(second).not.toBe(MockWebSocket.instances[0]);
    const reReq = reqFilters(second)[0];
    if (!reReq) throw new Error("expected REQ on socket 2");
    expect(reReq[0]).toBe("REQ");
    expect(reReq[1]).toBe(sub.id);

    second.receive(JSON.stringify(["EVENT", sub.id, note]));
    expect(events).toEqual([note.id]);
    second.receive(JSON.stringify(["EOSE", sub.id]));
    expect(eose).toBe(1);
    relay.close();
  });

  test("first-connect timeout with enableReconnect still REQ on socket 2", async () => {
    MockWebSocket.autoConnect = false;
    const relay = new Relay("wss://timeout-first.example", {
      enableReconnect: true,
      reconnectBackoffMs: [80],
      connectTimeoutMs: 30,
      websocketImplementation: MockWebSocketCtor,
    });
    let eose = 0;
    const connecting = relay.connect();
    const sub = relay.subscribe([{ kinds: [1] }], {
      oneose: () => {
        eose += 1;
      },
    });
    await expect(connecting).rejects.toThrow(/timed out/);
    expect(sub.closed).toBe(false);
    expect(eose).toBe(0);
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.autoConnect = true;
    await waitUntil(
      () =>
        relay.connected &&
        MockWebSocket.instances.length >= 2 &&
        sentMessages(MockWebSocket.last()).some((m) => m[0] === "REQ"),
    );
    expect(eose).toBe(0);
    const second = MockWebSocket.last();
    expect(second).not.toBe(MockWebSocket.instances[0]);
    const reReq = reqFilters(second)[0];
    if (!reReq) throw new Error("expected REQ on socket 2");
    expect(reReq[1]).toBe(sub.id);
    second.receive(JSON.stringify(["EOSE", sub.id]));
    expect(eose).toBe(1);
    relay.close();
  });

  test("abort during first connect does not reconnect", async () => {
    MockWebSocket.autoConnect = false;
    const ac = new AbortController();
    const relay = new Relay("wss://abort-first.example", {
      enableReconnect: true,
      reconnectBackoffMs: [10],
      websocketImplementation: MockWebSocketCtor,
    });
    const connecting = relay.connect({ signal: ac.signal });
    const sub = relay.subscribe([{ kinds: [1] }], {});
    ac.abort();
    await expect(connecting).rejects.toThrow();
    expect(sub.closed).toBe(true);
    const before = MockWebSocket.instances.length;
    expect(before).toBe(1);
    await sleep(40);
    expect(MockWebSocket.instances.length).toBe(before);
    expect(relay.connected).toBe(false);
    relay.close();
  });

  test("fetch after failed first connect does not arm reconnect", async () => {
    MockWebSocket.failConnect = true;
    const relay = new Relay("wss://fetch-first-fail.example", {
      enableReconnect: true,
      reconnectBackoffMs: [10],
      websocketImplementation: MockWebSocketCtor,
    });
    await expect(relay.fetch([{ kinds: [1] }], { timeoutMs: 50 })).rejects.toThrow();
    expect(MockWebSocket.instances).toHaveLength(1);
    await sleep(40);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(relay.connected).toBe(false);
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

  test("reconnect REQ since is lastCreatedAt inclusive, not +1", async () => {
    const relay = new Relay("wss://since.example", {
      enableReconnect: true,
      reconnectBackoffMs: [5],
      websocketImplementation: MockWebSocketCtor,
    });
    await relay.connect();
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("wm").createdAt(50).signWithKeys(keys);
    const later = EventBuilder.textNote("same-second unseen").createdAt(50).signWithKeys(keys);
    const events: string[] = [];
    const sub = relay.subscribe([{ kinds: [1] }], {
      onevent: (e) => events.push(e.id),
    });

    const first = MockWebSocket.last();
    first.receive(JSON.stringify(["EVENT", sub.id, note]));
    expect(sub.lastCreatedAt).toBe(50);
    expect(sub.filters).toEqual([{ kinds: [1] }]);
    expect(sub.replayFilters()[0]!.since).toBe(50);

    first.close();
    await waitUntil(() => relay.connected && MockWebSocket.instances.length >= 2);
    const second = MockWebSocket.last();
    const reReq = reqFilters(second)[0]!;
    expect(reReq[1]).toBe(sub.id);
    expect(reReq[2]!.since).toBe(50);
    expect(reReq[2]!.since).not.toBe(51);

    second.receive(JSON.stringify(["EVENT", sub.id, later]));
    expect(events).toEqual([note.id, later.id]);
    relay.close();
  });

  test("same-second ids are watermarked; new id at watermark second is delivered", async () => {
    const relay = new Relay("wss://same-sec.example", {
      enableReconnect: true,
      reconnectBackoffMs: [5],
      websocketImplementation: MockWebSocketCtor,
    });
    await relay.connect();
    const keys = Keys.fromSecretKey(SK);
    const t = 100;
    const a = EventBuilder.textNote("a").createdAt(t).signWithKeys(keys);
    const b = EventBuilder.textNote("b").createdAt(t).signWithKeys(keys);
    const c = EventBuilder.textNote("c").createdAt(t).signWithKeys(keys);
    const events: string[] = [];
    const received: string[] = [];
    const sub = relay.subscribe([{ kinds: [1] }], {
      onevent: (e) => events.push(e.id),
      receivedEvent: (id) => received.push(id),
    });

    const first = MockWebSocket.last();
    first.receive(JSON.stringify(["EVENT", sub.id, a]));
    first.receive(JSON.stringify(["EVENT", sub.id, b]));
    expect(events).toEqual([a.id, b.id]);
    expect(sub.lastCreatedAt).toBe(t);
    expect(sub.idsAtWatermark.has(a.id)).toBe(true);
    expect(sub.idsAtWatermark.has(b.id)).toBe(true);

    first.close();
    await waitUntil(() => relay.connected && MockWebSocket.instances.length >= 2);
    const second = MockWebSocket.last();
    expect(reqFilters(second)[0]![2]!.since).toBe(t);

    second.receive(JSON.stringify(["EVENT", sub.id, a]));
    second.receive(JSON.stringify(["EVENT", sub.id, b]));
    expect(events).toEqual([a.id, b.id]);
    expect(received).toEqual([a.id, b.id, a.id, b.id]);

    second.receive(JSON.stringify(["EVENT", sub.id, c]));
    expect(events).toEqual([a.id, b.id, c.id]);
    expect(sub.idsAtWatermark.has(c.id)).toBe(true);
    relay.close();
  });

  test("extra live REQ while offline does not reset reconnect backoff", async () => {
    const relay = new Relay("wss://extra-live.example", {
      enableReconnect: true,
      reconnectBackoffMs: [40, 5000],
      websocketImplementation: MockWebSocketCtor,
    });
    const sub1 = relay.subscribe([{ kinds: [1] }]);
    const sub2 = relay.subscribe([{ kinds: [2] }]);
    expect(sub1.closed).toBe(false);
    expect(sub2.closed).toBe(false);
    expect(sub1.id).not.toBe(sub2.id);
    expect(MockWebSocket.instances).toHaveLength(0);

    await waitUntil(() => MockWebSocket.instances.length >= 1, 200);
    await waitUntil(() => relay.connected && reqFilters(MockWebSocket.last()).length >= 2);
    const reqs = reqFilters(MockWebSocket.last());
    expect(reqs.map((m) => m[1])).toEqual(expect.arrayContaining([sub1.id, sub2.id]));
    expect(reqs.map((m) => m[2]!.kinds)).toEqual(expect.arrayContaining([[1], [2]]));
    expect(MockWebSocket.instances).toHaveLength(1);
    relay.close();
  });

  test("closeOnEose subscribe while offline does not reset reconnect backoff", async () => {
    const relay = new Relay("wss://extra-eose.example", {
      enableReconnect: true,
      reconnectBackoffMs: [40, 5000],
      websocketImplementation: MockWebSocketCtor,
    });
    const live = relay.subscribe([{ kinds: [1] }]);
    const once = relay.subscribe([{ kinds: [2] }], { closeOnEose: true });
    expect(live.closed).toBe(false);
    expect(once.closed).toBe(false);
    expect(live.id).not.toBe(once.id);
    expect(MockWebSocket.instances).toHaveLength(0);

    await waitUntil(() => MockWebSocket.instances.length >= 1, 200);
    await waitUntil(() => relay.connected && reqFilters(MockWebSocket.last()).length >= 2);
    const reqs = reqFilters(MockWebSocket.last());
    expect(reqs.map((m) => m[1])).toEqual(expect.arrayContaining([live.id, once.id]));
    expect(MockWebSocket.instances).toHaveLength(1);
    relay.close();
  });

  test("reconnect CLOSED auth-required retries AUTH; post-AUTH REQ keeps inclusive since", async () => {
    const keys = Keys.fromSecretKey(SK);
    const relay = new Relay("wss://auth-wm.example", {
      enableReconnect: true,
      reconnectBackoffMs: [5],
      websocketImplementation: MockWebSocketCtor,
      authSigner: async (template) =>
        EventBuilder.textNote("")
          .kind(template.kind)
          .tags(template.tags)
          .content(template.content)
          .createdAt(template.created_at)
          .signWithKeys(keys),
    });
    await relay.connect();
    const note = EventBuilder.textNote("wm").createdAt(42).signWithKeys(keys);
    const sub = relay.subscribe([{ kinds: [1] }], {});
    MockWebSocket.last().receive(JSON.stringify(["EVENT", sub.id, note]));
    expect(sub.lastCreatedAt).toBe(42);

    MockWebSocket.last().close();
    await waitUntil(() => relay.connected && MockWebSocket.instances.length >= 2);
    const second = MockWebSocket.last();
    expect(reqFilters(second)[0]![2]!.since).toBe(42);

    second.receive(JSON.stringify(["AUTH", "new-challenge"]));
    second.receive(JSON.stringify(["CLOSED", sub.id, "auth-required: login"]));
    await waitUntil(() => sentMessages(second).some((m) => m[0] === "AUTH"));
    const authFrame = sentMessages(second).find((m) => m[0] === "AUTH") as [string, { id: string }];
    second.receive(JSON.stringify(["OK", authFrame[1].id, true, ""]));
    await waitUntil(() => reqFilters(second).length >= 2);

    const postAuth = reqFilters(second).at(-1)!;
    expect(postAuth[1]).toBe(sub.id);
    expect(postAuth[2]!.since).toBe(42);
    expect(postAuth[2]!.since).not.toBe(43);
    relay.close();
  });

  test("reconnect REQ send failure reschedules and a later socket REQs the live sub", async () => {
    const relay = new Relay("wss://req-fail.example", {
      enableReconnect: true,
      reconnectBackoffMs: [5],
      websocketImplementation: FailReqCtor,
    });
    let reconnects = 0;
    relay.onreconnect = () => {
      reconnects += 1;
    };
    await relay.connect();
    const sub = relay.subscribe([{ kinds: [1] }]);
    const first = MockWebSocket.last();
    expect(reqFilters(first)[0]![1]).toBe(sub.id);

    FailReqSocket.failNextReq = true;
    first.close();
    await waitUntil(() => MockWebSocket.instances.length >= 2);
    const second = MockWebSocket.instances[1]!;
    await waitUntil(() => !relay.connected && second.readyState === MockWebSocket.CLOSED);
    expect(reconnects).toBe(0);
    expect(sub.closed).toBe(false);
    expect(reqFilters(second).some((m) => m[1] === sub.id)).toBe(false);

    await waitUntil(
      () =>
        relay.connected &&
        MockWebSocket.instances.some(
          (ws) => ws !== first && ws !== second && reqFilters(ws).some((m) => m[1] === sub.id),
        ),
      1000,
    );
    const later = MockWebSocket.instances.find(
      (ws) => ws !== first && ws !== second && reqFilters(ws).some((m) => m[1] === sub.id),
    )!;
    expect(reconnects).toBe(1);
    expect(sub.closed).toBe(false);
    expect(reqFilters(later).some((m) => m[1] === sub.id)).toBe(true);
    FailReqSocket.failNextReq = false;
    relay.close();
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
