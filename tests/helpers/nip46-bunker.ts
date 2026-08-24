import {
  Kind,
  Keys,
  decodeNip46Request,
  encodeNip46Response,
  finalizeEvent,
  getConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  type TagTuple,
} from "../../src/index.ts";
import { MockWebSocket } from "./mock-ws.ts";

export type BunkerResponderOptions = {
  bunkerSk: string;
  userSk: string;
  clientPubkey: string;
  /**
   * Methods that first emit `auth_url` (result) with this URL in the error field,
   * then the real response on the next poll.
   */
  authUrl?: string;
  authUrlMethods?: string[];
  /** Collected RPC requests (mutated as they arrive). */
  requests?: Array<{ method: string; params: string[] }>;
  /** `switch_relays` result. Default `"null"`. */
  switchRelays?: string[] | null;
  /** Override `connect` RPC result. Default `"ack"`. */
  connectResult?: string;
};

/**
 * Poll mock sockets and answer NIP-46 kind:24133 requests as a bunker.
 */
export function armBunkerResponder(opts: BunkerResponderOptions): () => void {
  const bunkerKeys = Keys.fromSecretKey(opts.bunkerSk);
  const userKeys = Keys.fromSecretKey(opts.userSk);
  const convKey = getConversationKey(bunkerKeys.secretKey.bytes, opts.clientPubkey);
  const handled = new Set<string>();
  const authPending = new Set<string>();
  const authMethods = new Set(opts.authUrlMethods ?? ["connect"]);

  const reply = (
    ws: MockWebSocket,
    clientPubkey: string,
    id: string,
    result?: string,
    error?: string,
  ) => {
    const responseJson = encodeNip46Response({ id, result, error });
    const event = finalizeEvent(
      {
        kind: Kind.NostrConnect,
        tags: [["p", clientPubkey]],
        content: nip44Encrypt(responseJson, convKey),
        created_at: Math.floor(Date.now() / 1000),
      },
      bunkerKeys.secretKey,
    );
    for (const raw of ws.sent) {
      const m = JSON.parse(raw) as unknown[];
      if (m[0] === "REQ") {
        ws.receive(JSON.stringify(["EVENT", m[1], event]));
      }
    }
  };

  const tick = () => {
    for (const ws of MockWebSocket.instances) {
      for (const raw of ws.sent) {
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!Array.isArray(msg) || msg[0] !== "EVENT") continue;
        const event = msg[1] as {
          kind: number;
          pubkey: string;
          content: string;
          id: string;
        };
        if (handled.has(event.id)) continue;

        // ACK publish so pool.publish resolves.
        ws.receive(JSON.stringify(["OK", event.id, true, ""]));

        if (event.kind !== Kind.NostrConnect) {
          handled.add(event.id);
          continue;
        }
        if (event.pubkey !== opts.clientPubkey) {
          handled.add(event.id);
          continue;
        }

        try {
          const req = decodeNip46Request(nip44Decrypt(event.content, convKey));

          if (opts.authUrl && authMethods.has(req.method) && !authPending.has(req.id)) {
            authPending.add(req.id);
            reply(ws, opts.clientPubkey, req.id, "auth_url", opts.authUrl);
            // leave unhandled so the real answer is sent next tick
            continue;
          }

          handled.add(event.id);
          opts.requests?.push({ method: req.method, params: req.params });

          let result: string | undefined;
          let error: string | undefined;
          switch (req.method) {
            case "connect":
              result = opts.connectResult ?? "ack";
              break;
            case "get_public_key":
              result = userKeys.publicKey;
              break;
            case "ping":
              result = "pong";
              break;
            case "switch_relays":
              result =
                opts.switchRelays === undefined || opts.switchRelays === null
                  ? "null"
                  : JSON.stringify(opts.switchRelays);
              break;
            case "logout":
              result = "ack";
              break;
            case "sign_event": {
              const template = JSON.parse(req.params[0]!) as {
                kind: number;
                tags: TagTuple[];
                content: string;
                created_at: number;
              };
              const signed = finalizeEvent(template, userKeys.secretKey);
              result = JSON.stringify(signed);
              break;
            }
            default:
              error = `unsupported method ${req.method}`;
          }

          reply(ws, opts.clientPubkey, req.id, result, error);
        } catch {
          handled.add(event.id);
        }
      }
    }
  };

  const interval = setInterval(tick, 5);
  return () => clearInterval(interval);
}

/** Publish a nostrconnect handshake secret confirmation as the bunker. */
export function publishNostrConnectAck(opts: {
  bunkerSk: string;
  clientPubkey: string;
  secret: string;
  ws: MockWebSocket;
}): void {
  const bunkerKeys = Keys.fromSecretKey(opts.bunkerSk);
  const convKey = getConversationKey(bunkerKeys.secretKey.bytes, opts.clientPubkey);
  const payload = encodeNip46Response({ id: "handshake", result: opts.secret });
  const event = finalizeEvent(
    {
      kind: Kind.NostrConnect,
      tags: [["p", opts.clientPubkey]],
      content: nip44Encrypt(payload, convKey),
      created_at: Math.floor(Date.now() / 1000),
    },
    bunkerKeys.secretKey,
  );

  for (const raw of opts.ws.sent) {
    const m = JSON.parse(raw) as unknown[];
    if (m[0] === "REQ") {
      opts.ws.receive(JSON.stringify(["EVENT", m[1], event]));
    }
  }
}
