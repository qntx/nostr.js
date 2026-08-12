import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Keys,
  Pool,
  Relay,
  useWebSocketImplementation,
  verifyEvent,
} from "../src/index.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

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
