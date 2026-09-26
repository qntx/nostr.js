import { Keys, finalizeEvent, type Tag } from "../core/index.ts";
import {
  getConversationKey,
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
} from "../nips/nip44.ts";
import { decodeNip46Request, encodeNip46Response } from "../nips/nip46.ts";
import { Kind } from "../core/kind.ts";
import type { FakeRelayNetwork } from "./network.ts";

export type FakeNip46SignerOptions = {
  /** The network the fake signer joins as a client of `relayUrl`. */
  network: FakeRelayNetwork;
  relayUrl: string;
  /** Pubkey of the NIP-46 client under test. */
  clientPubkey: string;
  /** Remote-signer key; random when omitted. */
  bunkerSk?: string;
  /** The user key the signer signs for; random when omitted. */
  userSk?: string;
  /** First answer `auth_url` (result) with this URL in the error field, then the real response. */
  authUrl?: string;
  authUrlMethods?: readonly string[];
  /** Delay in ms before the real response after an `auth_url` reply. */
  authReplyDelayMs?: number;
  /** Collected RPC requests (mutated as they arrive). */
  requests?: Array<{ method: string; params: string[] }>;
  /** `switch_relays` result. Default `"null"`. */
  switchRelays?: string[] | null;
  /** Override `connect` RPC result. Default `"ack"`. */
  connectResult?: string;
};

export interface FakeNip46Signer {
  readonly bunkerPubkey: string;
  readonly userPublicKey: string;
  /** Also answer RPCs on another relay of the same network (e.g. after switch_relays). */
  attach(relayUrl: string): void;
  /** Publish the nostrconnect handshake secret confirmation as the bunker. */
  confirmHandshake(secret: string): void;
  close(): void;
}

type SocketMessage = { data: unknown };

/**
 * In-process NIP-46 remote signer: subscribes to kind:24133 requests on
 * `relayUrl` and answers as a bunker, encrypted to `clientPubkey` with NIP-44.
 */
export function createFakeNip46Signer(opts: FakeNip46SignerOptions): FakeNip46Signer {
  const bunkerKeys = opts.bunkerSk ? Keys.fromSecretKey(opts.bunkerSk) : Keys.generate();
  const userKeys = opts.userSk ? Keys.fromSecretKey(opts.userSk) : Keys.generate();
  const convKey = getConversationKey(bunkerKeys.secretKey.bytes, opts.clientPubkey);
  const handled = new Set<string>();
  const authPending = new Set<string>();
  const authMethods = new Set(opts.authUrlMethods ?? ["connect"]);
  let closed = false;

  const sockets = new Set<{ close(): void }>();
  const listen = (relayUrl: string): void => {
    const ws = new opts.network.websocketImplementation(relayUrl);
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify([
          "REQ",
          "fake-nip46-signer",
          { kinds: [Kind.NostrConnect], "#p": [bunkerKeys.publicKey] },
        ]),
      );
    });
    ws.addEventListener("message", (ev) => onMessage(ev, ws));
    sockets.add(ws as unknown as { close(): void });
  };

  const onMessage = (ev: unknown, ws: { send(data: string): void }): void => {
    const data = (ev as SocketMessage).data;
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== "EVENT") return;
    const event = msg[2] as {
      kind: number;
      pubkey: string;
      content: string;
      id: string;
    };
    if (!event || event.kind !== Kind.NostrConnect) return;
    if (event.pubkey !== opts.clientPubkey || handled.has(event.id)) return;

    try {
      const req = decodeNip46Request(nip44Decrypt(event.content, convKey));
      if (opts.authUrl && authMethods.has(req.method) && !authPending.has(req.id)) {
        authPending.add(req.id);
        reply(ws, opts.clientPubkey, req.id, "auth_url", opts.authUrl);
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
            tags: Tag[];
            content: string;
            created_at: number;
          };
          result = JSON.stringify(finalizeEvent(template, userKeys.secretKey));
          break;
        }
        default:
          error = `unsupported method ${req.method}`;
      }
      if (authPending.has(req.id) && opts.authReplyDelayMs !== undefined) {
        const pendingId = req.id;
        const pendingResult = result;
        const pendingError = error;
        setTimeout(
          () => reply(ws, opts.clientPubkey, pendingId, pendingResult, pendingError),
          opts.authReplyDelayMs,
        );
      } else {
        reply(ws, opts.clientPubkey, req.id, result, error);
      }
    } catch {
      handled.add(event.id);
    }
  };

  const reply = (
    ws: { send(data: string): void },
    clientPubkey: string,
    id: string,
    result?: string,
    error?: string,
  ): void => {
    if (closed) return;
    const payload = encodeNip46Response({ id, result, error });
    const event = finalizeEvent(
      {
        kind: Kind.NostrConnect,
        tags: [["p", clientPubkey]],
        content: nip44Encrypt(payload, convKey),
        created_at: Math.floor(Date.now() / 1000),
      },
      bunkerKeys.secretKey,
    );
    ws.send(JSON.stringify(["EVENT", event]));
  };

  listen(opts.relayUrl);

  return {
    bunkerPubkey: bunkerKeys.publicKey,
    userPublicKey: userKeys.publicKey,
    confirmHandshake(secret: string): void {
      const payload = encodeNip46Response({ id: "handshake", result: secret });
      const event = finalizeEvent(
        {
          kind: Kind.NostrConnect,
          tags: [["p", opts.clientPubkey]],
          content: nip44Encrypt(payload, convKey),
          created_at: Math.floor(Date.now() / 1000),
        },
        bunkerKeys.secretKey,
      );
      opts.network.relay(opts.relayUrl).inject(event);
    },
    attach(relayUrl: string): void {
      listen(relayUrl);
    },
    close(): void {
      closed = true;
      for (const ws of sockets) ws.close();
      sockets.clear();
    },
  };
}
