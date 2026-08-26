import { NostrError } from "../core/error.ts";
import type { Event } from "../core/event.ts";
import type { Gossip } from "../gossip/gossip.ts";
import type { PoolPublishResult } from "../relay/pool.ts";
import type { WebSocketConstructor } from "../relay/websocket.ts";
import type { NostrSigner } from "../signer/types.ts";
import type { StorageError } from "../storage/error.ts";
import type { EventStore } from "../storage/types.ts";
import type { ReplyTo } from "../nips/nip17.ts";
import type { Rumor } from "../nips/nip59.ts";

export const SyncDirection = {
  Up: "up",
  Down: "down",
  Both: "both",
} as const;

export type SyncDirectionName = (typeof SyncDirection)[keyof typeof SyncDirection];

export type SyncOptions = {
  relays?: readonly string[];
  direction?: SyncDirectionName;
  /**
   * Wall-clock deadline for the Negentropy reconciliation session
   * (`NEG-OPEN` through `NEG-CLOSE`), in milliseconds.
   * One clock for the whole session — not reset per `NEG-MSG`.
   * Default: the relay `publishTimeoutMs`.
   * Upload/download phases reuse this value as their per-call timeout.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  dryRun?: boolean;
  /** When false, skip observe/storage on downloaded events. Default true. */
  observe?: boolean;
};

export type SyncSummary = {
  local: string[];
  remote: string[];
  sent: string[];
  received: string[];
  sendFailures: Record<string, string>;
  persistFailures: Record<string, string>;
};

export type ClientOptions = {
  signer?: NostrSigner;
  relays?: readonly string[];
  websocketImplementation?: WebSocketConstructor;
  /** Injected EVENT verifier. Default is core BIP-340. */
  verifyEvent?: (event: Event) => boolean;
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  /** When true (default if signer present), answer NIP-42 AUTH automatically. */
  automaticAuth?: boolean;
  /** When true (default), relays reconnect with backoff after disconnect. */
  enableReconnect?: boolean;
  /** Keepalive ping. Default false. */
  enablePing?: boolean;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  gossip?: Gossip;
  /**
   * Local event store. Defaults to {@link MemoryEventStore}.
   * Browser apps that want persistence must pass {@link IndexedDbEventStore} and `await open()`.
   */
  storage?: EventStore;
  /**
   * When true (default), every ingested event is written to storage.
   * Set false to disable automatic persistence while keeping the store for manual use.
   */
  persistEvents?: boolean;
  /** Live persist failures. Does not throw on the subscribe path. */
  onstorageerror?: (err: StorageError) => void;
};

export type FetchEventsOptions = {
  relays?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  gossip?: boolean;
  /**
   * When true, query local storage first and merge with network results.
   * Defaults to false.
   */
  localFirst?: boolean;
  /** When false, skip writing fetched events to storage/observe. Default true. */
  observe?: boolean;
};

export type SubscribeOptions = {
  relays?: string[];
  onevent?: (event: Event) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
  signal?: AbortSignal;
  id?: string;
  /**
   * If set, fire `oneose` once after this many ms if not all relays have EOSEd.
   * Does not close the subscription.
   */
  eoseTimeoutMs?: number;
  /** Fan out REQs via NIP-65 gossip routes when available. */
  gossip?: boolean;
  /** When false, skip writing received events to storage/observe. Default true. */
  observe?: boolean;
};

export type PublishOptions = {
  relays?: string[];
  timeoutMs?: number;
  gossip?: boolean;
  /** When false, skip writing the published event to storage/observe. Default true. */
  observe?: boolean;
};

export type SendPrivateMessageOptions = {
  readonly subject?: string;
  readonly replyTo?: ReplyTo;
  readonly created_at?: number;
  readonly timeoutMs?: number;
  readonly observe?: boolean;
};

export type PrivateMessageSendResult = {
  rumor: Rumor;
  wraps: ReadonlyArray<{
    recipient: string;
    wrap: Event;
    results: PoolPublishResult[];
  }>;
};

export type ReceivedPrivateMessage = {
  wrap: Event;
  rumor: Rumor;
};

export type FetchPrivateMessagesOptions = {
  readonly since?: number;
  readonly until?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly observe?: boolean;
};

export type SubscribePrivateMessagesOptions = {
  readonly since?: number;
  readonly onevent?: (msg: ReceivedPrivateMessage) => void;
  readonly oneose?: () => void;
  readonly onclose?: (reason: string) => void;
  readonly signal?: AbortSignal;
  readonly eoseTimeoutMs?: number;
  readonly observe?: boolean;
};

/** Client lifecycle, configuration, or abort failure (not cryptographic). */
export class ClientError extends NostrError {}
