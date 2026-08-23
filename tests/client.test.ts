import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  EventBuilder,
  Kind,
  Keys,
  KeysSigner,
  useWebSocketImplementation,
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
      EventBuilder.relayList([{ url: "wss://author-write.example", read: false, write: true }])
        .createdAt(1)
        .signWithKeys(Keys.fromSecretKey(SK)),
    );
    client.gossip.ingest(
      EventBuilder.relayList([{ url: "wss://tagged-read.example", read: true, write: false }])
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
});
