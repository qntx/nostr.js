import type { Event } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import type { EventBuilder } from "../core/builder.ts";
import type { Gossip } from "../gossip/gossip.ts";
import type { Pool, PoolPublishResult } from "../relay/pool.ts";
import {
  Nip17Error,
  buildChatMessageRumor,
  dmRelayListEventBuilder,
  normalizeRecipients,
  requireDmRelays,
  wrapDirectMessage,
  type Recipient,
} from "../nips/nip17.ts";
import { unwrap, type Nip59Crypto } from "../nips/nip59.ts";
import type { ReactiveEventStore } from "../store/reactive.ts";
import type {
  FetchPrivateMessagesOptions,
  PrivateMessageSendResult,
  PublishOptions,
  ReceivedPrivateMessage,
  SendPrivateMessageOptions,
  SubscribePrivateMessagesOptions,
} from "./types.ts";

export type DmDeps = {
  pool: Pool;
  gossip: Gossip;
  index: ReactiveEventStore;
  hydrateGossip: (pubkeys: readonly string[]) => Promise<void>;
  observe: (event: Event, relayUrl?: string) => void;
  assertAlive: () => void;
  requireNip59Crypto: () => Nip59Crypto;
  throwIfAborted: (signal?: AbortSignal) => void;
  wantObserve: (flag?: boolean) => boolean;
  publish: (
    eventOrBuilder: Event | EventBuilder,
    opts?: PublishOptions,
  ) => Promise<PoolPublishResult[]>;
};

export function giftWrapRelays(gossip: Gossip, event: Event): string[] {
  const targets: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === "p" && tag[1]) targets.push(tag[1].toLowerCase());
  }
  if (targets.length === 0) {
    throw new Nip17Error("gift wrap has no p-tag recipient");
  }
  if (targets.length !== 1) {
    throw new Nip17Error("gift wrap must have exactly one p-tag recipient");
  }
  const relays = gossip.dmRelays(targets[0]!);
  if (relays.length === 0) {
    throw new Nip17Error("no kind 10050 in gossip; use sendPrivateMessage or pass relays");
  }
  return relays;
}

export async function setDmRelays(
  deps: DmDeps,
  relays: readonly string[],
  opts?: PublishOptions,
): Promise<PoolPublishResult[]> {
  return deps.publish(dmRelayListEventBuilder(relays), { gossip: true, ...opts });
}

export async function sendPrivateMessage(
  deps: DmDeps,
  recipients: string | Recipient | readonly (string | Recipient)[],
  content: string,
  opts?: SendPrivateMessageOptions,
): Promise<PrivateMessageSendResult> {
  deps.assertAlive();
  const crypto = deps.requireNip59Crypto();
  const sender = await crypto.getPublicKey();
  const list = normalizeRecipients(recipients);
  if (list.length === 0) {
    throw new Nip17Error("recipients must not be empty");
  }

  const targets = new Set<string>([sender.toLowerCase(), ...list.map((r) => r.pubkey)]);
  await deps.hydrateGossip([...targets]);
  for (const pk of targets) {
    requireDmRelays(pk, deps.gossip.dmRelays(pk));
  }

  const rumor = buildChatMessageRumor(sender, list, content, {
    created_at: opts?.created_at,
    subject: opts?.subject,
    replyTo: opts?.replyTo,
  });
  const wraps = await wrapDirectMessage(crypto, list, rumor);
  const sent = await Promise.all(
    wraps.map(async ({ recipient, wrap }) => {
      const relays = requireDmRelays(recipient, deps.gossip.dmRelays(recipient));
      const results = await deps.pool.publish(relays, wrap, { timeoutMs: opts?.timeoutMs });
      if (results.some((r) => r.result?.ok) && deps.wantObserve(opts?.observe)) {
        deps.observe(wrap);
      }
      return { recipient, wrap, results };
    }),
  );
  return { rumor, wraps: sent };
}

export async function fetchPrivateMessages(
  deps: DmDeps,
  opts?: FetchPrivateMessagesOptions,
): Promise<ReceivedPrivateMessage[]> {
  deps.assertAlive();
  const crypto = deps.requireNip59Crypto();
  const self = await crypto.getPublicKey();
  deps.throwIfAborted(opts?.signal);
  await deps.hydrateGossip([self]);
  deps.throwIfAborted(opts?.signal);
  const relays = requireDmRelays(self, deps.gossip.dmRelays(self));
  const urls = new Map<string, Set<string>>();
  const events = await deps.pool.fetch(
    relays,
    [
      {
        kinds: [Kind.GiftWrap],
        "#p": [self],
        since: opts?.since,
        until: opts?.until,
      },
    ],
    {
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      onevent: (event, relayUrl) => {
        let set = urls.get(event.id);
        if (!set) urls.set(event.id, (set = new Set()));
        set.add(relayUrl);
      },
    },
  );

  const byRumor = new Map<string, ReceivedPrivateMessage>();
  for (const wrap of events) {
    try {
      const rumor = await unwrap(crypto, wrap);
      const wrapUrls = urls.get(wrap.id);
      const firstUrl = wrapUrls?.values().next().value;
      if (deps.wantObserve(opts?.observe)) {
        deps.observe(wrap, firstUrl);
        // Every other relay that delivered the same wrap is recorded too.
        if (wrapUrls) {
          for (const url of wrapUrls) {
            if (url !== firstUrl) deps.index.markSeen(wrap.id, url);
          }
        }
      }
      byRumor.set(rumor.id, { wrap, rumor, relayUrl: firstUrl });
    } catch {
      // junk / forgery / key mismatch — not stored
    }
  }

  return [...byRumor.values()].sort((a, b) => {
    if (a.rumor.created_at !== b.rumor.created_at) {
      return a.rumor.created_at - b.rumor.created_at;
    }
    return a.rumor.id.localeCompare(b.rumor.id);
  });
}

export async function subscribePrivateMessages(
  deps: DmDeps,
  opts?: SubscribePrivateMessagesOptions,
): Promise<{ close: (reason?: string) => void }> {
  deps.assertAlive();
  const crypto = deps.requireNip59Crypto();
  const self = await crypto.getPublicKey();
  deps.throwIfAborted(opts?.signal);
  await deps.hydrateGossip([self]);
  deps.throwIfAborted(opts?.signal);
  const relays = requireDmRelays(self, deps.gossip.dmRelays(self));

  const seen = new Set<string>();
  // Wrap ids processed (observed) already; receipts before that are buffered
  // so every delivering relay URL lands in seenOn once the wrap is indexed.
  const processed = new Set<string>();
  const pendingUrls = new Map<string, string[]>();
  const flushSeen = (wrapId: string): void => {
    processed.add(wrapId);
    const extra = pendingUrls.get(wrapId);
    if (extra === undefined) return;
    pendingUrls.delete(wrapId);
    for (const url of extra) deps.index.markSeen(wrapId, url);
  };
  let tail = Promise.resolve();
  let closed = false;
  const markClosed = (): void => {
    closed = true;
  };
  if (opts?.signal?.aborted) markClosed();
  else opts?.signal?.addEventListener("abort", markClosed, { once: true });

  const inner = deps.pool.subscribe(
    relays,
    // 21059 is ephemeral (relays MUST NOT store); live inbox has to REQ it.
    [{ kinds: [Kind.GiftWrap, Kind.GiftWrapEphemeral], "#p": [self], since: opts?.since }],
    {
      signal: opts?.signal,
      oneose: opts?.oneose,
      onclose: (reason) => {
        markClosed();
        opts?.onclose?.(reason);
      },
      eoseTimeoutMs: opts?.eoseTimeoutMs,
      receivedEvent: (id, relayUrl) => {
        if (closed) return;
        if (processed.has(id)) {
          deps.index.markSeen(id, relayUrl);
          return;
        }
        const list = pendingUrls.get(id);
        if (list === undefined) pendingUrls.set(id, [relayUrl]);
        else if (!list.includes(relayUrl)) list.push(relayUrl);
      },
      onevent: (wrap, relayUrl) => {
        if (closed) return;
        tail = tail
          .then(async () => {
            if (closed) return;
            try {
              const rumor = await unwrap(crypto, wrap);
              if (closed) return;
              if (seen.has(rumor.id)) {
                flushSeen(wrap.id);
                return;
              }
              seen.add(rumor.id);
              if (deps.wantObserve(opts?.observe)) deps.observe(wrap, relayUrl);
              flushSeen(wrap.id);
              opts?.onevent?.({ wrap, rumor, relayUrl });
            } catch {
              // junk / forgery — not stored
            }
          })
          .catch(() => {
            // keep the queue alive if a handler throws
          });
      },
    },
  );

  return {
    close: (reason?: string) => {
      markClosed();
      inner.close(reason);
    },
  };
}
