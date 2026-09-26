import { NostrError } from "../core/error.ts";
import type { Event } from "../core/event.ts";
import type { Gossip } from "../gossip/gossip.ts";
import type { PoolPublishResult } from "../relay/pool.ts";
import type { WebSocketConstructor } from "../relay/websocket.ts";
import type { NostrSigner } from "../signer/types.ts";
import type { StorageError } from "../storage/error.ts";
import type { EventStore } from "../storage/types.ts";
import type { ReactiveEventStore } from "../store/reactive.ts";
import type { ReplyTo } from "../nips/nip17.ts";
import type { Rumor } from "../nips/nip59.ts";

/** Direction of a {@link Client.sync} run: upload, download, or both. */
export const SyncDirection = {
  Up: "up",
  Down: "down",
  Both: "both",
} as const;

/** Union of the {@link SyncDirection} values. */
export type SyncDirectionName = (typeof SyncDirection)[keyof typeof SyncDirection];

/** Options for {@link Client.sync} (NIP-77 set reconciliation). */
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

/** Outcome of a {@link Client.sync} run: ids compared, sent, received, and failures. */
export type SyncSummary = {
  local: string[];
  remote: string[];
  sent: string[];
  received: string[];
  sendFailures: Record<string, string>;
  persistFailures: Record<string, string>;
};

/** Options for {@link Client.builder} / `ClientOptions` accepted by the builder. */
export type ClientOptions = {
  signer?: NostrSigner;
  relays?: readonly string[];
  websocketImplementation?: WebSocketConstructor;
  /** Injected EVENT verifier. Default is core BIP-340. */
  verifyEvent?: (event: Event) => boolean;
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  /**
   * When true (default), answer NIP-42 AUTH automatically. The signer is read
   * at challenge time, so `setSigner()` applies to live connections; challenges
   * received while no signer is set are ignored.
   */
  automaticAuth?: boolean;
  /** When true (default), relays reconnect with backoff after disconnect. */
  enableReconnect?: boolean;
  /** Keepalive ping. Default false. */
  enablePing?: boolean;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** Forwarded to the pool: when false (default), `ws://` relays are rejected. */
  allowInsecure?: boolean;
  /** Forwarded to the pool: `ws://` URLs allowed despite `allowInsecure`. */
  trustedInsecureUrls?: readonly string[];
  /** Forwarded to the pool: close idle relays after this many ms. */
  idleTimeoutMs?: number;
  /** Forwarded to the pool: soft cap on connected non-pinned relays. */
  maxRelays?: number;
  /** Forwarded to the pool: relays never closed by idle cleanup or `maxRelays`. */
  pinnedUrls?: readonly string[];
  gossip?: Gossip;
  /**
   * Local event store. Defaults to {@link MemoryEventStore}.
   * Browser apps that want persistence must pass {@link IndexedDbEventStore} and `await open()`.
   */
  storage?: EventStore;
  /**
   * Synchronous reactive index that mirrors every ingested event before
   * callbacks and persistence. Defaults to a new {@link ReactiveEventStore}.
   */
  index?: ReactiveEventStore;
  /**
   * When true (default), every ingested event is written to storage.
   * Set false to disable automatic persistence while keeping the store for manual use.
   */
  persistEvents?: boolean;
  /**
   * Storage I/O failures: live `putMany` flush and `fetchEvents({ localFirst: true })` query.
   * Those paths do not throw.
   */
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
  /**
   * Every event of every relay batch, including duplicates across relays.
   * `relayUrl` is the normalized URL of the relay that delivered it.
   */
  onevent?: (event: Event, relayUrl: string) => void;
};

export type SubscribeOptions = {
  relays?: string[];
  /**
   * First receipt of each event only (deduped across relays).
   * `relayUrl` is the normalized URL of the relay that delivered it first.
   */
  onevent?: (event: Event, relayUrl: string) => void;
  /**
   * Every receipt from every relay, including duplicates skipped by dedupe.
   */
  receivedEvent?: (id: string, relayUrl: string) => void;
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

/** Options for sending a NIP-17 private message. */
export type SendPrivateMessageOptions = {
  readonly subject?: string;
  readonly replyTo?: ReplyTo;
  readonly created_at?: number;
  readonly timeoutMs?: number;
  readonly observe?: boolean;
};

/** Result of sending a NIP-17 DM: the rumor plus per-recipient wrap publish results. */
export type PrivateMessageSendResult = {
  rumor: Rumor;
  wraps: ReadonlyArray<{
    recipient: string;
    wrap: Event;
    results: PoolPublishResult[];
  }>;
};

/** An unwrapped NIP-17 private message: the received gift wrap and its inner rumor. */
export type ReceivedPrivateMessage = {
  wrap: Event;
  rumor: Rumor;
  /** Normalized URL of the relay that delivered the wrap, when known. */
  relayUrl?: string;
};

/** Options for fetching NIP-17 private-message history. */
export type FetchPrivateMessagesOptions = {
  readonly since?: number;
  readonly until?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly observe?: boolean;
};

/** Options for a live NIP-17 private-message subscription. */
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
