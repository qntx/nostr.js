import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Kind,
  Keys,
  KeysSigner,
  relayListEventBuilder,
  useWebSocketImplementation,
} from "../src/index.ts";
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

function lastReqId(ws: MockWebSocket): string {
  const reqs = ws.sent.map((s) => JSON.parse(s) as unknown[]).filter((m) => m[0] === "REQ");
  const last = reqs[reqs.length - 1] as [string, string] | undefined;
  if (!last) throw new Error("no REQ");
  return last[1];
}

function findWs(part: string): MockWebSocket | undefined {
  return MockWebSocket.instances.find((ws) => ws.url.includes(part));
}

function reqReady(part: string): boolean {
  const ws = findWs(part);
  return Boolean(ws && sentMessages(ws).some((m) => m[0] === "REQ"));
}

function reqAuthors(ws: MockWebSocket): string[] {
  return sentMessages(ws)
    .filter((m) => m[0] === "REQ")
    .flatMap((m) => m.slice(2) as Array<{ authors?: string[] }>)
    .flatMap((f) => f.authors ?? []);
}

function reqPTags(ws: MockWebSocket): string[] {
  return sentMessages(ws)
    .filter((m) => m[0] === "REQ")
    .flatMap((m) => m.slice(2) as Array<{ "#p"?: string[] }>)
    .flatMap((f) => f["#p"] ?? []);
}

function hasClose(ws: MockWebSocket): boolean {
  return sentMessages(ws).some((m) => m[0] === "CLOSE");
}

function dummyPingReqs(ws: MockWebSocket): unknown[][] {
  return ws.sent
    .map((s) => JSON.parse(s) as unknown[])
    .filter((m) => m[0] === "REQ" && String(m[1]).startsWith("__ping__"));
}

beforeEach(() => {
  MockWebSocket.reset();
  useWebSocketImplementation(MockWebSocketCtor);
});

afterEach(() => {
  MockWebSocket.reset();
});

describe("Client", () => {
  test("builder publish + fetchEvents end to end on mock relays", async () => {
    const client = Client.builder()
      .signer(new KeysSigner(SK))
      .relays(["wss://a.example", "wss://b.example"])
      .websocketImplementation(MockWebSocketCtor)
      .build();

    await client.connect();
    expect(MockWebSocket.instances.length).toBe(2);

    const publishP = client.publish(EventBuilder.textNote("hello from client").createdAt(10));
    await new Promise((r) => setTimeout(r, 10));

    for (const ws of MockWebSocket.instances) {
      const eventMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "EVENT") as [
        string,
        { id: string; content: string; kind: number },
      ];
      expect(eventMsg[1].content).toBe("hello from client");
      expect(eventMsg[1].kind).toBe(Kind.TextNote);
      ws.receive(JSON.stringify(["OK", eventMsg[1].id, true, ""]));
    }

    const published = await publishP;
    expect(published.every((r) => r.result?.ok)).toBe(true);

    const note = (
      MockWebSocket.instances[0]!.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "EVENT") as [
        string,
        {
          id: string;
          content: string;
          pubkey: string;
          kind: number;
          tags: string[][];
          created_at: number;
          sig: string;
        },
      ]
    )[1];

    const fetchP = client.fetchEvents(
      { kinds: [1], authors: [note.pubkey], limit: 5 },
      { timeoutMs: 2000 },
    );
    await new Promise((r) => setTimeout(r, 10));

    for (const ws of MockWebSocket.instances) {
      const req = ws.sent.map((s) => JSON.parse(s)).find((m) => m[0] === "REQ") as [string, string];
      // last REQ after fetch
      const reqs = ws.sent.map((s) => JSON.parse(s)).filter((m) => m[0] === "REQ");
      const lastReq = reqs[reqs.length - 1] as [string, string];
      ws.receive(JSON.stringify(["EVENT", lastReq[1], note]));
      ws.receive(JSON.stringify(["EOSE", lastReq[1]]));
      void req;
    }

    const notes = await fetchP;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toBe("hello from client");

    await client.shutdown();
    expect(client.isShutdown).toBe(true);
  });

  test("publish requires signer when given EventBuilder", async () => {
    const client = Client.builder().relays(["wss://a.example"]).build();
    await expect(client.publish(EventBuilder.textNote("x"))).rejects.toThrow(/signer/);
  });

  test("Client pool ensureRelay defaults to 5000ms when connectTimeoutMs is unset", async () => {
    MockWebSocket.autoConnect = false;
    const client = new Client({
      websocketImplementation: MockWebSocketCtor,
      enableReconnect: false,
    });
    try {
      const pending = client.pool.ensureRelay("wss://hang.example");
      await waitUntil(() => MockWebSocket.instances.length === 1);
      expect(MockWebSocket.last().readyState).toBe(MockWebSocket.CONNECTING);
      const status = await Promise.race([
        pending.then(
          () => "resolved" as const,
          () => "rejected" as const,
        ),
        sleep(3500).then(() => "pending" as const),
      ]);
      expect(status).toBe("pending");
      await expect(pending).rejects.toThrow(/timed out/);
    } finally {
      await client.shutdown();
    }
  }, 8_000);

  test("gossip publish fans out to author write and tagged read relays", async () => {
    const author = new KeysSigner(SK);
    const tagged = Keys.fromSecretKey(
      "0000000000000000000000000000000000000000000000000000000000000001",
    );
    const client = Client.builder()
      .signer(author)
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .build();
    await client.connect();

    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://author-write.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(Keys.fromSecretKey(SK)),
    );
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://tagged-read.example", read: true, write: false }])
        .createdAt(1)
        .signWithKeys(tagged),
    );

    const publishP = client.publish(
      EventBuilder.textNote("hi").tag(["p", tagged.publicKey]).createdAt(1),
      { gossip: true },
    );
    await new Promise((r) => setTimeout(r, 20));

    const urls = MockWebSocket.instances.map((ws) => ws.url);
    expect(urls.some((u) => u.includes("author-write.example"))).toBe(true);
    expect(urls.some((u) => u.includes("tagged-read.example"))).toBe(true);

    for (const ws of MockWebSocket.instances) {
      const eventMsg = ws.sent
        .map((s) => JSON.parse(s) as unknown[])
        .find((m) => m[0] === "EVENT") as [string, { id: string }] | undefined;
      if (eventMsg) ws.receive(JSON.stringify(["OK", eventMsg[1].id, true, ""]));
    }
    const results = await publishP;
    expect(results.some((r) => r.result?.ok)).toBe(true);
    await client.shutdown();
  });

  test("subscribe two relays with eoseTimeoutMs fires oneose once", async () => {
    const client = Client.builder()
      .relays(["wss://a.example", "wss://b.example"])
      .websocketImplementation(MockWebSocketCtor)
      .build();
    let eose = 0;
    const closer = client.subscribe(
      { kinds: [1] },
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
    const loud = MockWebSocket.instances.find((ws) => ws.url.includes("a.example"))!;
    const silent = MockWebSocket.instances.find((ws) => ws.url.includes("b.example"))!;
    const req = sentMessages(loud).find((m) => m[0] === "REQ") as [string, string];
    loud.receive(JSON.stringify(["EOSE", req[1]]));
    expect(eose).toBe(0);
    await waitUntil(() => eose === 1);
    expect(eose).toBe(1);
    expect(sentMessages(silent).some((m) => m[0] === "CLOSE")).toBe(false);
    closer.close();
    await client.shutdown();
  });

  test("gossip subscribe with eoseTimeoutMs fires oneose once", async () => {
    const author = Keys.fromSecretKey(SK);
    const tagged = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(author),
    );
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-b.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(tagged),
    );

    let eose = 0;
    const closer = client.subscribe(
      { kinds: [1], authors: [author.publicKey, tagged.publicKey] },
      {
        gossip: true,
        eoseTimeoutMs: 50,
        oneose: () => {
          eose += 1;
        },
      },
    );
    await waitUntil(() => {
      const targets = MockWebSocket.instances.filter(
        (ws) => ws.url.includes("out-a.example") || ws.url.includes("out-b.example"),
      );
      return (
        targets.length === 2 && targets.every((ws) => sentMessages(ws).some((m) => m[0] === "REQ"))
      );
    });
    const loud = MockWebSocket.instances.find((ws) => ws.url.includes("out-a.example"))!;
    const silent = MockWebSocket.instances.find((ws) => ws.url.includes("out-b.example"))!;
    const req = sentMessages(loud).find((m) => m[0] === "REQ") as [string, string];
    loud.receive(JSON.stringify(["EOSE", req[1]]));
    expect(eose).toBe(0);
    await waitUntil(() => eose === 1);
    expect(eose).toBe(1);
    expect(sentMessages(silent).some((m) => m[0] === "CLOSE")).toBe(false);
    closer.close();
    await client.shutdown();
  });

  test("gossip subscribe leftover authors REQ default relays", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const closer = client.subscribe(
      { kinds: [1], authors: [a.publicKey, b.publicKey] },
      { gossip: true },
    );
    await waitUntil(() => reqReady("out-a.example") && reqReady("default.example"));

    const outA = findWs("out-a.example")!;
    const def = findWs("default.example")!;
    expect(reqAuthors(outA)).toEqual([a.publicKey]);
    expect(reqAuthors(def)).toEqual([b.publicKey]);
    closer.close();
    await client.shutdown();
  });

  test("gossip fetchEvents leftover authors read notes from default relays", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const noteA = EventBuilder.textNote("from-a").createdAt(1).signWithKeys(a);
    const noteB = EventBuilder.textNote("from-b").createdAt(2).signWithKeys(b);

    const fetchP = client.fetchEvents(
      { kinds: [1], authors: [a.publicKey, b.publicKey] },
      { gossip: true, timeoutMs: 2000 },
    );
    await waitUntil(() => reqReady("out-a.example") && reqReady("default.example"));

    const outA = findWs("out-a.example")!;
    const def = findWs("default.example")!;
    expect(reqAuthors(outA)).toEqual([a.publicKey]);
    expect(reqAuthors(def)).toEqual([b.publicKey]);
    const reply = (ws: MockWebSocket, note: typeof noteA) => {
      for (const msg of sentMessages(ws)) {
        if (msg[0] !== "REQ") continue;
        const subId = msg[1] as string;
        const filter = msg[2] as { authors?: string[] };
        if (filter.authors?.includes(note.pubkey)) {
          ws.receive(JSON.stringify(["EVENT", subId, note]));
        }
        ws.receive(JSON.stringify(["EOSE", subId]));
      }
    };
    reply(outA, noteA);
    reply(def, noteB);

    const notes = await fetchP;
    expect(notes.map((n) => n.id).sort()).toEqual([noteA.id, noteB.id].sort());
    expect(notes.find((n) => n.id === noteB.id)?.content).toBe("from-b");
    await client.shutdown();
  });

  test("gossip fetchEvents leftover skips a failed outbox relay", async () => {
    MockWebSocket.autoConnect = false;
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .connectTimeoutMs(40)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const noteB = EventBuilder.textNote("from-b").createdAt(2).signWithKeys(b);
    const fetchP = client.fetchEvents(
      { kinds: [1], authors: [a.publicKey, b.publicKey] },
      { gossip: true, timeoutMs: 200 },
    );
    await waitUntil(() => Boolean(findWs("out-a.example") && findWs("default.example")));
    const def = findWs("default.example")!;
    def.open();
    await waitUntil(() => reqReady("default.example"));
    expect(reqAuthors(def)).toEqual([b.publicKey]);
    def.receive(JSON.stringify(["EVENT", lastReqId(def), noteB]));
    def.receive(JSON.stringify(["EOSE", lastReqId(def)]));

    const notes = await fetchP;
    expect(notes.map((n) => n.id)).toEqual([noteB.id]);
    expect(findWs("out-a.example")!.readyState).not.toBe(MockWebSocket.OPEN);
    await client.shutdown();
  });

  test("gossip leftover with empty Client.relays throws before attach", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const leftover = { kinds: [1], authors: [a.publicKey, b.publicKey] };
    expect(() => client.subscribe(leftover, { gossip: true })).toThrow(/no relays configured/);
    await expect(client.fetchEvents(leftover, { gossip: true })).rejects.toThrow(
      /no relays configured/,
    );
    expect(() =>
      client.subscribe([{ kinds: [1], authors: [a.publicKey] }, leftover], { gossip: true }),
    ).toThrow(/no relays configured/);
    await expect(
      client.fetchEvents([{ kinds: [1], authors: [a.publicKey] }, leftover], { gossip: true }),
    ).rejects.toThrow(/no relays configured/);

    const start = Date.now();
    while (Date.now() - start < 50) {
      const reqOnOutA = MockWebSocket.instances.some(
        (ws) => ws.url.includes("out-a.example") && sentMessages(ws).some((m) => m[0] === "REQ"),
      );
      expect(reqOnOutA).toBe(false);
      await sleep(5);
    }

    await client.shutdown();
  });

  test("gossip all-routed authors skip empty Client.relays", async () => {
    const a = Keys.fromSecretKey(SK);
    const client = Client.builder()
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const closer = client.subscribe({ kinds: [1], authors: [a.publicKey] }, { gossip: true });
    await waitUntil(() => reqReady("out-a.example"));
    const outA = findWs("out-a.example")!;
    expect(reqAuthors(outA)).toEqual([a.publicKey]);
    closer.close();
    await client.shutdown();
  });

  test("gossip fetchEvents all-routed authors skip empty Client.relays", async () => {
    const a = Keys.fromSecretKey(SK);
    const client = Client.builder()
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const noteA = EventBuilder.textNote("routed-a").createdAt(1).signWithKeys(a);
    const fetchP = client.fetchEvents(
      { kinds: [1], authors: [a.publicKey] },
      { gossip: true, timeoutMs: 2000 },
    );
    await waitUntil(() => reqReady("out-a.example"));
    expect(MockWebSocket.instances.every((ws) => ws.url.includes("out-a.example"))).toBe(true);
    const outA = findWs("out-a.example")!;
    expect(reqAuthors(outA)).toEqual([a.publicKey]);
    outA.receive(JSON.stringify(["EVENT", lastReqId(outA), noteA]));
    outA.receive(JSON.stringify(["EOSE", lastReqId(outA)]));
    const notes = await fetchP;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe(noteA.id);
    await client.shutdown();
  });

  test("gossip subscribe leftover #p REQ default relays", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://in-a.example", read: true, write: false }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const closer = client.subscribe(
      { kinds: [1], "#p": [a.publicKey, b.publicKey] },
      { gossip: true },
    );
    await waitUntil(() => reqReady("in-a.example") && reqReady("default.example"));
    expect(reqPTags(findWs("in-a.example")!)).toEqual([a.publicKey]);
    expect(reqPTags(findWs("default.example")!)).toEqual([b.publicKey]);
    closer.close();
    await client.shutdown();
  });

  test("gossip subscribe leftover authors+#p REQ original filter on defaults", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const filter = {
      kinds: [1],
      authors: [a.publicKey, b.publicKey],
      "#p": [a.publicKey],
    };
    const closer = client.subscribe(filter, { gossip: true });
    await waitUntil(() => reqReady("out-a.example") && reqReady("default.example"));
    const outA = findWs("out-a.example")!;
    const def = findWs("default.example")!;
    expect(reqAuthors(outA)).toEqual([a.publicKey, b.publicKey]);
    expect(reqPTags(outA)).toEqual([a.publicKey]);
    expect(reqAuthors(def)).toEqual([a.publicKey, b.publicKey]);
    expect(reqPTags(def)).toEqual([a.publicKey]);
    closer.close();
    await client.shutdown();
  });

  test("gossip subscribe close fires onclose once across two outboxes", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-b.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(b),
    );

    let closes = 0;
    const closer = client.subscribe(
      { kinds: [1], authors: [a.publicKey, b.publicKey] },
      {
        gossip: true,
        onclose: () => {
          closes += 1;
        },
      },
    );
    await waitUntil(() => reqReady("out-a.example") && reqReady("out-b.example"));
    const outA = findWs("out-a.example")!;
    const outB = findWs("out-b.example")!;
    closer.close();
    expect(closes).toBe(1);
    expect(hasClose(outA)).toBe(true);
    expect(hasClose(outB)).toBe(true);
    await client.shutdown();
  });

  test("gossip subscribe CLOSED waits for every outbox before onclose", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-b.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(b),
    );

    let closes = 0;
    client.subscribe(
      { kinds: [1], authors: [a.publicKey, b.publicKey] },
      {
        gossip: true,
        onclose: () => {
          closes += 1;
        },
      },
    );
    await waitUntil(() => {
      const targets = MockWebSocket.instances.filter(
        (ws) => ws.url.includes("out-a.example") || ws.url.includes("out-b.example"),
      );
      return (
        targets.length === 2 && targets.every((ws) => sentMessages(ws).some((m) => m[0] === "REQ"))
      );
    });
    const outA = MockWebSocket.instances.find((ws) => ws.url.includes("out-a.example"))!;
    const outB = MockWebSocket.instances.find((ws) => ws.url.includes("out-b.example"))!;
    outA.receive(JSON.stringify(["CLOSED", lastReqId(outA), "bye-a"]));
    expect(closes).toBe(0);
    outB.receive(JSON.stringify(["CLOSED", lastReqId(outB), "bye-b"]));
    expect(closes).toBe(1);
    await client.shutdown();
  });

  test("gossip leftover plus two outboxes close fires onclose once", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const c = Keys.fromSecretKey(
      "0000000000000000000000000000000000000000000000000000000000000002",
    );
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-b.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(b),
    );

    let closes = 0;
    const closer = client.subscribe(
      { kinds: [1], authors: [a.publicKey, b.publicKey, c.publicKey] },
      {
        gossip: true,
        onclose: () => {
          closes += 1;
        },
      },
    );
    await waitUntil(
      () => reqReady("out-a.example") && reqReady("out-b.example") && reqReady("default.example"),
    );
    const outA = findWs("out-a.example")!;
    const outB = findWs("out-b.example")!;
    const def = findWs("default.example")!;
    closer.close();
    expect(closes).toBe(1);
    expect(hasClose(outA)).toBe(true);
    expect(hasClose(outB)).toBe(true);
    expect(hasClose(def)).toBe(true);
    await client.shutdown();
  });

  test("gossip leftover CLOSED waits for fallback pool before onclose", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    let closes = 0;
    client.subscribe(
      { kinds: [1], authors: [a.publicKey, b.publicKey] },
      {
        gossip: true,
        onclose: () => {
          closes += 1;
        },
      },
    );
    await waitUntil(() => reqReady("out-a.example") && reqReady("default.example"));
    const outA = findWs("out-a.example")!;
    const def = findWs("default.example")!;
    outA.receive(JSON.stringify(["CLOSED", lastReqId(outA), "bye-a"]));
    expect(closes).toBe(0);
    def.receive(JSON.stringify(["CLOSED", lastReqId(def), "bye-default"]));
    expect(closes).toBe(1);
    await client.shutdown();
  });

  test("gossip leftover two default relays stay one fallback pool", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default-a.example", "wss://default-b.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    let closes = 0;
    client.subscribe(
      { kinds: [1], authors: [a.publicKey, b.publicKey] },
      {
        gossip: true,
        onclose: () => {
          closes += 1;
        },
      },
    );
    await waitUntil(
      () =>
        reqReady("out-a.example") && reqReady("default-a.example") && reqReady("default-b.example"),
    );
    const outA = findWs("out-a.example")!;
    const defA = findWs("default-a.example")!;
    const defB = findWs("default-b.example")!;
    expect(reqAuthors(outA)).toEqual([a.publicKey]);
    expect(reqAuthors(defA)).toEqual([b.publicKey]);
    expect(reqAuthors(defB)).toEqual([b.publicKey]);

    outA.receive(JSON.stringify(["CLOSED", lastReqId(outA), "bye-out"]));
    expect(closes).toBe(0);
    defA.receive(JSON.stringify(["CLOSED", lastReqId(defA), "bye-a"]));
    expect(closes).toBe(0);
    defB.receive(JSON.stringify(["CLOSED", lastReqId(defB), "bye-b"]));
    expect(closes).toBe(1);
    await client.shutdown();
  });

  test("gossip empty filters fire oneose without opening sockets", async () => {
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    let eose = 0;
    let closed: string | undefined;
    client.subscribe([], {
      gossip: true,
      oneose: () => {
        eose += 1;
      },
      onclose: (reason) => {
        closed = reason;
      },
    });
    await waitUntil(() => eose === 1);
    expect(eose).toBe(1);
    expect(closed).toBeUndefined();
    expect(MockWebSocket.instances).toHaveLength(0);
    await client.shutdown();
  });

  test("gossip leftover and two generic filters do not forward caller id", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );

    const leftover = client.subscribe(
      { kinds: [1], authors: [a.publicKey, b.publicKey] },
      { gossip: true, id: "caller-id" },
    );
    await waitUntil(() => reqReady("out-a.example") && reqReady("default.example"));
    const leftoverIds = MockWebSocket.instances.flatMap((ws) =>
      sentMessages(ws)
        .filter((m) => m[0] === "REQ")
        .map((m) => m[1] as string),
    );
    expect(leftoverIds.length).toBeGreaterThan(1);
    expect(leftoverIds.every((id) => id !== "caller-id")).toBe(true);
    leftover.close();
    await client.shutdown();
    MockWebSocket.reset();

    const genericClient = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    const generics = genericClient.subscribe([{ kinds: [1] }, { kinds: [0] }], {
      gossip: true,
      id: "caller-id",
    });
    await waitUntil(() => reqReady("default.example"));
    const genericIds = sentMessages(findWs("default.example")!)
      .filter((m) => m[0] === "REQ")
      .map((m) => m[1] as string);
    expect(genericIds).toHaveLength(2);
    expect(genericIds.every((id) => id !== "caller-id")).toBe(true);
    expect(new Set(genericIds).size).toBe(2);
    generics.close();
    await genericClient.shutdown();
  });

  test("gossip close still CLOSEs inners when onclose throws", async () => {
    const a = Keys.fromSecretKey(SK);
    const b = Keys.fromSecretKey(SK2);
    const c = Keys.fromSecretKey(
      "0000000000000000000000000000000000000000000000000000000000000002",
    );
    const client = Client.builder()
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .build();
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-a.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(a),
    );
    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://out-b.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(b),
    );

    const closer = client.subscribe(
      { kinds: [1], authors: [a.publicKey, b.publicKey, c.publicKey] },
      {
        gossip: true,
        onclose: () => {
          throw new Error("boom");
        },
      },
    );
    await waitUntil(
      () => reqReady("out-a.example") && reqReady("out-b.example") && reqReady("default.example"),
    );
    const outA = findWs("out-a.example")!;
    const outB = findWs("out-b.example")!;
    const def = findWs("default.example")!;
    expect(() => closer.close()).toThrow(/boom/);
    expect(hasClose(outA)).toBe(true);
    expect(hasClose(outB)).toBe(true);
    expect(hasClose(def)).toBe(true);
    await client.shutdown();
  });

  test("custom verifyEvent returning false drops events on subscribe", async () => {
    let verifies = 0;
    const client = Client.builder()
      .relays(["wss://verify-drop.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .verifyEvent(() => {
        verifies += 1;
        return false;
      })
      .build();

    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("rejected").createdAt(1).signWithKeys(keys);
    const received: string[] = [];

    await client.connect();
    const sub = client.subscribe({ kinds: [1] }, { onevent: (e) => received.push(e.id) });
    await sleep(10);

    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["EVENT", lastReqId(ws), note]));
    expect(verifies).toBe(1);
    expect(received).toHaveLength(0);

    const local = await client.queryLocal({ kinds: [1] });
    expect(local).toHaveLength(0);

    sub.close();
    await client.shutdown();
  });

  test("custom verifyEvent returning true still delivers events on subscribe", async () => {
    let verifies = 0;
    const client = Client.builder()
      .relays(["wss://verify-pass.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .verifyEvent(() => {
        verifies += 1;
        return true;
      })
      .build();

    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("accepted").createdAt(1).signWithKeys(keys);
    const received: string[] = [];

    await client.connect();
    const sub = client.subscribe({ kinds: [1] }, { onevent: (e) => received.push(e.id) });
    await sleep(10);

    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["EVENT", lastReqId(ws), note]));
    expect(verifies).toBe(1);
    expect(received).toEqual([note.id]);

    sub.close();
    await client.shutdown();
  });

  test("ClientOptions.verifyEvent on the constructor drops subscribe events", async () => {
    const client = new Client({
      relays: ["wss://verify-ctor.example"],
      websocketImplementation: MockWebSocketCtor,
      enableReconnect: false,
      verifyEvent: () => false,
    });

    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("ctor-drop").createdAt(1).signWithKeys(keys);
    const received: string[] = [];

    await client.connect();
    const sub = client.subscribe({ kinds: [1] }, { onevent: (e) => received.push(e.id) });
    await sleep(10);

    const ws = MockWebSocket.last();
    ws.receive(JSON.stringify(["EVENT", lastReqId(ws), note]));
    expect(received).toHaveLength(0);

    sub.close();
    await client.shutdown();
  });

  test("enablePing forwards interval so relays send dummy ping REQ", async () => {
    const client = Client.builder()
      .relays(["wss://ping.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .enablePing(true)
      .pingIntervalMs(30)
      .pingTimeoutMs(400)
      .build();

    await client.connect();
    const ws = MockWebSocket.last();
    await waitUntil(() => dummyPingReqs(ws).length > 0);
    expect(dummyPingReqs(ws)[0]![2]).toEqual({ ids: ["a".repeat(64)], limit: 0 });
    await client.shutdown();
  });

  test("enablePing stays off by default", async () => {
    const client = Client.builder()
      .relays(["wss://no-ping.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .pingIntervalMs(10)
      .build();

    await client.connect();
    const ws = MockWebSocket.last();
    await sleep(50);
    expect(dummyPingReqs(ws)).toHaveLength(0);
    await client.shutdown();
  });

  test("unanswered dummy ping closes the socket using forwarded pingTimeoutMs", async () => {
    const client = Client.builder()
      .relays(["wss://ping-timeout.example"])
      .websocketImplementation(MockWebSocketCtor)
      .enableReconnect(false)
      .enablePing(true)
      .pingIntervalMs(20)
      .pingTimeoutMs(40)
      .build();

    await client.connect();
    const ws = MockWebSocket.last();
    await waitUntil(() => dummyPingReqs(ws).length > 0);
    await waitUntil(() => ws.readyState === MockWebSocket.CLOSED);
    await client.shutdown();
  });

  test("gossip publish includes e/a relay hints and skips invalid ones", async () => {
    const author = new KeysSigner(SK);
    const client = Client.builder()
      .signer(author)
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .build();
    await client.connect();

    client.gossip.ingest(
      relayListEventBuilder([{ url: "wss://author-write.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(Keys.fromSecretKey(SK)),
    );

    const eId = "aa".repeat(32);
    const publishP = client.publish(
      EventBuilder.textNote("hi")
        .tag(["e", eId, "wss://e-hint.example"])
        .tag(["a", `30023:${Keys.fromSecretKey(SK).publicKey}:x`, "wss://a-hint.example"])
        .tag(["e", "bb".repeat(32), "not a url"])
        .tag(["e", "cc".repeat(32), ""])
        .tag(["p", "dd".repeat(32), "wss://p-hint.example"])
        .createdAt(1),
      { gossip: true },
    );
    await new Promise((r) => setTimeout(r, 20));

    const eventUrls = MockWebSocket.instances
      .filter((ws) => ws.sent.some((s) => (JSON.parse(s) as unknown[])[0] === "EVENT"))
      .map((ws) => ws.url);
    expect(eventUrls.some((u) => u.includes("author-write.example"))).toBe(true);
    expect(eventUrls.some((u) => u.includes("e-hint.example"))).toBe(true);
    expect(eventUrls.some((u) => u.includes("a-hint.example"))).toBe(true);
    expect(eventUrls.some((u) => u.includes("p-hint.example"))).toBe(false);

    for (const ws of MockWebSocket.instances) {
      const eventMsg = ws.sent
        .map((s) => JSON.parse(s) as unknown[])
        .find((m) => m[0] === "EVENT") as [string, { id: string; kind: number }] | undefined;
      if (eventMsg) {
        expect(eventMsg[1].kind).not.toBe(Kind.RelayList);
        ws.receive(JSON.stringify(["OK", eventMsg[1].id, true, ""]));
      }
    }
    const results = await publishP;
    expect(results.some((r) => r.result?.ok)).toBe(true);
    await client.shutdown();
  });

  test("gossip publish caps e/a hints at 5 unique URLs", async () => {
    const author = new KeysSigner(SK);
    const client = Client.builder()
      .signer(author)
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .build();
    await client.connect();

    const note = EventBuilder.textNote("hints").createdAt(1);
    for (let i = 0; i < 6; i++) {
      note.tag(["e", i.toString(16).padStart(64, "0"), `wss://hint${i}.example`]);
    }
    note.tag(["e", "f".repeat(64), "wss://hint0.example"]);

    const publishP = client.publish(note, { gossip: true });
    await new Promise((r) => setTimeout(r, 20));

    const eventUrls = MockWebSocket.instances
      .filter((ws) => ws.sent.some((s) => (JSON.parse(s) as unknown[])[0] === "EVENT"))
      .map((ws) => ws.url);
    expect(eventUrls.filter((u) => u.includes("hint")).length).toBe(5);
    expect(eventUrls.some((u) => u.includes("hint5.example"))).toBe(false);
    expect(eventUrls.some((u) => u.includes("default.example"))).toBe(false);

    for (const ws of MockWebSocket.instances) {
      const eventMsg = ws.sent
        .map((s) => JSON.parse(s) as unknown[])
        .find((m) => m[0] === "EVENT") as [string, { id: string }] | undefined;
      if (eventMsg) ws.receive(JSON.stringify(["OK", eventMsg[1].id, true, ""]));
    }
    await publishP;
    await client.shutdown();
  });

  test("gossip publish with only invalid hints uses default relays", async () => {
    const author = new KeysSigner(SK);
    const client = Client.builder()
      .signer(author)
      .relays(["wss://default.example"])
      .websocketImplementation(MockWebSocketCtor)
      .build();
    await client.connect();

    const publishP = client.publish(
      EventBuilder.textNote("no routes")
        .tag(["e", "aa".repeat(32), "not a url"])
        .createdAt(1),
      { gossip: true },
    );
    await new Promise((r) => setTimeout(r, 20));

    const eventUrls = MockWebSocket.instances
      .filter((ws) => ws.sent.some((s) => (JSON.parse(s) as unknown[])[0] === "EVENT"))
      .map((ws) => ws.url);
    expect(eventUrls.some((u) => u.includes("default.example"))).toBe(true);

    for (const ws of MockWebSocket.instances) {
      const eventMsg = ws.sent
        .map((s) => JSON.parse(s) as unknown[])
        .find((m) => m[0] === "EVENT") as [string, { id: string }] | undefined;
      if (eventMsg) ws.receive(JSON.stringify(["OK", eventMsg[1].id, true, ""]));
    }
    const results = await publishP;
    expect(results.some((r) => r.result?.ok)).toBe(true);
    await client.shutdown();
  });
});
