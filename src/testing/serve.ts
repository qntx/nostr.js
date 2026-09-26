import {
  FakeRelayCore,
  type FakeRelay,
  type FakeRelayOptions,
  type RelayTransport,
} from "./relay-core.ts";

export type ServedFakeRelay = {
  url: string;
  relay: FakeRelay;
  close(): Promise<void>;
};

/**
 * Serve the fake relay on a real WebSocket port via the optional `ws` peer
 * dependency (dynamic import — `@qntx/nostr/testing` never requires `ws`
 * unless you serve). `port: 0` picks an ephemeral port.
 */
export async function serveFakeRelay(
  opts: FakeRelayOptions & { port?: number; host?: string } = {},
): Promise<ServedFakeRelay> {
  const { port = 0, host = "127.0.0.1", ...relayOpts } = opts;
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port, host });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", (err) => reject(err));
  });
  const address = wss.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  const url = `ws://${host}:${bound}`;
  const core = new FakeRelayCore(url, relayOpts);

  wss.on("connection", (socket) => {
    const transport: RelayTransport = {
      send: (data) => socket.send(data),
      close: () => socket.close(),
    };
    const session = core.connect(transport);
    socket.on("message", (data: unknown) => {
      core.handleMessage(session, String(data));
    });
    socket.on("close", () => core.detach(session));
    socket.on("error", () => core.detach(session));
  });

  return {
    url,
    relay: core,
    close: () =>
      new Promise((resolve) => {
        core.disconnect();
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
