import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  Client,
  ClientError,
  CryptoError,
  DataLoader,
  EventBuilder,
  Gossip,
  Keys,
  KeysSigner,
  LoaderError,
  IndexedDbEventStore,
  MemoryEventStore,
  Nip19Error,
  NostrError,
  OutboxError,
  OutboxFeed,
  Pool,
  RelayClosedError,
  RelayPublishError,
  StorageError,
  WasmVerifyPoisonedError,
  createLoaders,
  npubEncode,
  nsecEncode,
  useWebSocketImplementation,
} from "../src/index.ts";
import { subscriptionToAsyncIterable } from "../src/relay/subscription.ts";
import { makeVerifyEvent } from "../src/wasm/adapter.ts";
import { loadNostrWasm, resetNostrWasmForTests } from "../src/wasm/load.ts";
import { MockWebSocket, MockWebSocketCtor } from "./helpers/mock-ws.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

function captureError(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected reject");
    },
    (err: unknown) => err,
  );
}

function syncThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected throw");
}

async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timeout waiting for condition");
}

describe("event loader nsec/npub", () => {
  test("nsec ref throws Nip19Error from parseRef default", () => {
    const keys = Keys.fromSecretKey(SK);
    const nsec = nsecEncode(keys.secretKey.bytes);
    expect(nsec.startsWith("nsec1")).toBe(true);
    const loaders = createLoaders({ pool: new Pool(), relays: [] });
    const err = syncThrow(() => loaders.event(nsec));
    expect(err).toBeInstanceOf(Nip19Error);
    expect((err as Nip19Error).message).toBe("cannot load event from nsec");
  });

  test("npub ref throws Nip19Error from parseRef default", () => {
    const keys = Keys.fromSecretKey(SK);
    const npub = npubEncode(keys.publicKey);
    expect(npub.startsWith("npub1")).toBe(true);
    const loaders = createLoaders({ pool: new Pool(), relays: [] });
    const err = syncThrow(() => loaders.event(npub));
    expect(err).toBeInstanceOf(Nip19Error);
    expect((err as Nip19Error).message).toBe("cannot load event from npub");
  });
});

describe("OutboxFeed closed", () => {
  test("start after close throws OutboxError via sync assertOpen", async () => {
    const keys = Keys.fromSecretKey(SK);
    const feed = new OutboxFeed({
      pool: new Pool({ websocketImplementation: MockWebSocketCtor }),
      gossip: new Gossip(),
      storage: new MemoryEventStore(),
      discoveryRelays: ["wss://discovery.example"],
      authors: [keys.publicKey],
    });
    feed.close();
    const err = await captureError(feed.start());
    expect(err).toBeInstanceOf(OutboxError);
    expect((err as OutboxError).message).toBe("OutboxFeed is closed");
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe("DataLoader batch length", () => {
  test("values.length !== keys.length rejects LoaderError", async () => {
    let batchLen = 0;
    const loader = new DataLoader<string, string>(async (keys) => {
      batchLen = keys.length;
      return [];
    });
    const a = loader.load("a");
    const b = loader.load("b");
    const errA = await captureError(a);
    const errB = await captureError(b);
    expect(batchLen).toBe(2);
    expect(errA).toBeInstanceOf(LoaderError);
    expect(errB).toBe(errA);
    expect((errA as LoaderError).message).toBe(
      "DataLoader batch function must return array of length 2, got 0",
    );
  });
});

describe("wasm HTTP load", () => {
  afterEach(() => {
    resetNostrWasmForTests();
  });

  test("fetch 404 throws CryptoError", async () => {
    resetNostrWasmForTests();
    const href = "https://wasm-404.qntx.test/nostr_crypto_wasm_bg.wasm";
    const prev = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (input: URL | string) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url !== href) return prev(input);
      fetchCalls += 1;
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }) as typeof fetch;
    try {
      const err = await captureError(loadNostrWasm({ module: new URL(href) }));
      expect(fetchCalls).toBe(1);
      expect(err).toBeInstanceOf(CryptoError);
      expect((err as CryptoError).message).toBe(`failed to fetch wasm: 404 ${href}`);
    } finally {
      globalThis.fetch = prev;
    }
  });
});

describe("subscriptionToAsyncIterable close reasons", () => {
  function started(): {
    onclose: (reason: string) => void;
    next: () => Promise<IteratorResult<unknown>>;
  } {
    let onclose: ((reason: string) => void) | undefined;
    const stream = subscriptionToAsyncIterable((handlers) => {
      onclose = handlers.onclose;
      return {
        close: (reason) => {
          handlers.onclose?.(reason ?? "closed by client");
        },
      };
    });
    if (!onclose) throw new Error("start omitted onclose");
    const iterator = stream[Symbol.asyncIterator]();
    return { onclose, next: () => iterator.next() };
  }

  test("onclose relay gone throws RelayClosedError from next", async () => {
    const { onclose, next } = started();
    const pending = next();
    onclose("relay gone");
    const err = await captureError(pending);
    expect(err).toBeInstanceOf(RelayClosedError);
    expect((err as RelayClosedError).message).toBe("relay gone");
  });

  test("onclose eose completes without throw", async () => {
    const { onclose, next } = started();
    const pending = next();
    onclose("eose");
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  test("onclose closed by client completes without throw", async () => {
    const { onclose, next } = started();
    const pending = next();
    onclose("closed by client");
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  test("onclose aborted completes without throw", async () => {
    const { onclose, next } = started();
    const pending = next();
    onclose("aborted");
    expect(await pending).toEqual({ value: undefined, done: true });
  });
});

describe("Pool.publishAny rejected OK", () => {
  beforeEach(() => {
    MockWebSocket.reset();
    useWebSocketImplementation(MockWebSocketCtor);
  });

  afterEach(() => {
    MockWebSocket.reset();
  });

  test("rejected OK inner throw is RelayPublishError", async () => {
    const pool = new Pool({
      websocketImplementation: MockWebSocketCtor,
      enableReconnect: false,
    });
    const keys = Keys.fromSecretKey(SK);
    const note = EventBuilder.textNote("rej").createdAt(1).signWithKeys(keys);
    const pending = pool.publishAny(["wss://rej.example"], note);
    await waitUntil(() =>
      MockWebSocket.instances.some((ws) =>
        ws.sent.some((raw) => (JSON.parse(raw) as unknown[])[0] === "EVENT"),
      ),
    );
    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    MockWebSocket.last().receive(JSON.stringify(["OK", note.id, false, "blocked: spam"]));
    const err = await captureError(pending);
    expect(err).toBeInstanceOf(AggregateError);
    const inner = (err as AggregateError).errors[0];
    expect(inner).toBeInstanceOf(RelayPublishError);
    expect((inner as RelayPublishError).message).toContain("blocked: spam");
    pool.close();
  });
});

describe("IndexedDbEventStore missing IndexedDB", () => {
  test("open throws StorageError not CryptoError", async () => {
    const g = globalThis as { indexedDB?: unknown };
    const prev = g.indexedDB;
    delete g.indexedDB;
    try {
      expect(IndexedDbEventStore.isAvailable()).toBe(false);
      const err = await captureError(new IndexedDbEventStore({ dbName: "taxonomy-no-idb" }).open());
      expect(err).toBeInstanceOf(StorageError);
      expect(err).not.toBeInstanceOf(CryptoError);
      expect(err).toBeInstanceOf(NostrError);
      expect((err as StorageError).message).toBe("IndexedDB is not available in this environment");
    } finally {
      if (prev !== undefined) g.indexedDB = prev;
      else delete g.indexedDB;
    }
  });
});

describe("WasmVerifyPoisonedError", () => {
  test("makeVerifyEvent RuntimeError poisons as WasmVerifyPoisonedError", () => {
    const poison: { error?: Error } = {};
    let calls = 0;
    const fn = makeVerifyEvent(
      {
        verifySerialized: () => {
          calls += 1;
          throw new WebAssembly.RuntimeError("trap");
        },
      },
      poison,
    );
    const signed = EventBuilder.textNote("hello")
      .createdAt(1617932115)
      .signWithKeys(Keys.fromSecretKey(SK));
    const event = { ...signed };
    const err = syncThrow(() => fn(event));
    expect(err).toBeInstanceOf(WasmVerifyPoisonedError);
    expect(err).toBeInstanceOf(NostrError);
    expect(poison.error).toBe(err);
    expect(poison.error?.name).toBe("WasmVerifyPoisonedError");
    expect((err as WasmVerifyPoisonedError).cause).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(calls).toBe(1);
    const sticky = syncThrow(() => fn({ ...event }));
    expect(sticky).toBe(poison.error);
    expect(calls).toBe(1);
  });
});

describe("ClientError", () => {
  const unsigned = {
    kind: 1,
    content: "x",
    created_at: 1,
    tags: [] as const,
    pubkey: "0".repeat(64),
  };

  function pinClientError(err: unknown, message: string): void {
    expect(err).toBeInstanceOf(ClientError);
    expect(err).not.toBeInstanceOf(CryptoError);
    expect(err).toBeInstanceOf(NostrError);
    expect((err as ClientError).name).toBe("ClientError");
    expect((err as ClientError).message).toBe(message);
  }

  test("getPublicKey/signEvent/signEventBuilder/signTemplate without signer", async () => {
    const client = new Client();
    pinClientError(await captureError(client.getPublicKey()), "no signer configured");
    pinClientError(await captureError(client.signEvent(unsigned)), "no signer configured");
    pinClientError(
      await captureError(client.signEventBuilder(EventBuilder.textNote("x"))),
      "no signer configured",
    );
    pinClientError(
      await captureError(client.signTemplate({ kind: 1, content: "x", created_at: 1, tags: [] })),
      "no signer configured",
    );
  });

  test("requireNip59Crypto methods without signer", async () => {
    const client = new Client({ relays: ["wss://a.example"] });
    pinClientError(
      await captureError(client.sendPrivateMessage("0".repeat(64), "hi")),
      "no signer configured",
    );
    pinClientError(await captureError(client.fetchPrivateMessages()), "no signer configured");
    pinClientError(await captureError(client.subscribePrivateMessages()), "no signer configured");
  });

  test("assertAlive after shutdown", async () => {
    const client = new Client({ relays: ["wss://a.example"] });
    await client.shutdown();
    pinClientError(await captureError(client.connect()), "client is shut down");
    pinClientError(
      syncThrow(() => client.subscribe({ kinds: [1] })),
      "client is shut down",
    );
  });

  test("defaultRelays with no relays configured", () => {
    const client = new Client();
    pinClientError(
      syncThrow(() => client.subscribe({ kinds: [1] })),
      "no relays configured",
    );
  });

  test("throwIfAborted with non-Error reason is ClientError", async () => {
    const client = new Client({
      signer: new KeysSigner(SK),
      storage: new MemoryEventStore(),
    });
    const ac = new AbortController();
    ac.abort("stop");
    pinClientError(
      await captureError(
        client.syncToRelay("wss://a.example", { kinds: [1] }, { signal: ac.signal }),
      ),
      "aborted",
    );
  });

  test("throwIfAborted with Error reason rethrows that Error", async () => {
    const client = new Client({
      signer: new KeysSigner(SK),
      storage: new MemoryEventStore(),
    });
    const ac = new AbortController();
    const reason = new Error("custom-abort");
    ac.abort(reason);
    const err = await captureError(
      client.syncToRelay("wss://a.example", { kinds: [1] }, { signal: ac.signal }),
    );
    expect(err).toBe(reason);
    expect(err).not.toBeInstanceOf(ClientError);
    expect(err).not.toBeInstanceOf(CryptoError);
  });
});
