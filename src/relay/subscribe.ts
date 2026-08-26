/** REQ subscription runtime: exclusive one-shot, live coalescing, dispatch, reconnect replay. */
import type { Event } from "../core/event.ts";
import { filterFingerprint, type Filter } from "../core/filter.ts";
import type { ClientMessage, SubscriptionId } from "../core/message.ts";
import { RelayConnectionError } from "./error.ts";
import {
  Subscription,
  subscriptionToAsyncIterable,
  type SubscribeOptions,
} from "./subscription.ts";

export type LiveGroup = {
  fp: string;
  sub: Subscription;
  attachments: Set<Subscription>;
};

export type LiveCtx = {
  liveByFp: Map<string, LiveGroup>;
  liveBySubId: Map<SubscriptionId, LiveGroup>;
  subs: Map<SubscriptionId, Subscription>;
  connected: () => boolean;
  enableReconnect: () => boolean;
  send: (message: ClientMessage) => void;
  scheduleReconnect: () => void;
  acceptEvent: (event: Event) => boolean;
  armEoseTimeout: (sub: Subscription, ms: number) => void;
};

// Independent live attachments must not abort sibling delivery or skip watermark.
export function captureListenerError(errors: unknown[], fn: () => void): void {
  try {
    fn();
  } catch (err) {
    errors.push(err);
  }
}

export function flushListenerErrors(errors: unknown[]): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors);
}

export function openExclusive(
  ctx: LiveCtx,
  filters: Filter[],
  opts: SubscribeOptions,
): Subscription {
  const sub = new Subscription(filters, opts, (id) => {
    ctx.subs.delete(id);
    try {
      if (ctx.connected()) ctx.send(["CLOSE", id]);
    } catch {
      // ignore
    }
  });

  ctx.subs.set(sub.id, sub);
  if (ctx.connected()) {
    ctx.send(["REQ", sub.id, ...filters]);
  } else if (ctx.enableReconnect()) {
    ctx.scheduleReconnect();
  }

  if (opts.eoseTimeoutMs !== undefined) ctx.armEoseTimeout(sub, opts.eoseTimeoutMs);
  return sub;
}

export function subscribeLive(
  ctx: LiveCtx,
  filters: Filter[],
  opts: SubscribeOptions,
): Subscription {
  const fp = filterFingerprint(filters);
  let group = ctx.liveByFp.get(fp);
  let created = false;
  if (!group) {
    created = true;
    const wire = new Subscription(filters, { id: opts.id }, () => {
      endLiveGroup(ctx, fp, { sendClose: true, reason: "closed by client" });
    });
    group = { fp, sub: wire, attachments: new Set() };
    ctx.liveByFp.set(fp, group);
    ctx.liveBySubId.set(wire.id, group);
    ctx.subs.set(wire.id, wire);
  }

  const slot: { handle: Subscription | undefined } = { handle: undefined };
  const handle = new Subscription(filters, { ...opts, id: group.sub.id }, () => {
    // constructor may close on an already-aborted signal before `handle` is assigned
    const current = slot.handle;
    if (!current) return;
    detachLive(ctx, fp, current);
  });
  slot.handle = handle;

  if (handle.closed) {
    if (created && group.attachments.size === 0) {
      forgetLiveGroup(ctx, group);
    }
    return handle;
  }

  group.attachments.add(handle);

  if (created) {
    if (ctx.connected()) {
      ctx.send(["REQ", group.sub.id, ...filters]);
    } else if (ctx.enableReconnect()) {
      ctx.scheduleReconnect();
    }
  }

  if (opts.eoseTimeoutMs !== undefined) ctx.armEoseTimeout(handle, opts.eoseTimeoutMs);

  if (group.sub.eosed) {
    queueMicrotask(() => {
      if (handle.closed || handle.eosed) return;
      handle.eosed = true;
      handle.handlers.oneose?.();
    });
  }

  return handle;
}

export function forgetLiveGroup(ctx: LiveCtx, group: LiveGroup): void {
  ctx.liveByFp.delete(group.fp);
  ctx.liveBySubId.delete(group.sub.id);
  ctx.subs.delete(group.sub.id);
  group.sub.closed = true;
}

export function detachLive(ctx: LiveCtx, fp: string, handle: Subscription): void {
  const group = ctx.liveByFp.get(fp);
  if (!group) return;
  if (!group.attachments.delete(handle)) return;
  if (group.attachments.size > 0) return;
  endLiveGroup(ctx, fp, { sendClose: true, reason: "closed by client" });
}

export function endLiveGroup(
  ctx: LiveCtx,
  fp: string,
  opts: { sendClose: boolean; reason: string },
): void {
  const group = ctx.liveByFp.get(fp);
  if (!group) return;
  const id = group.sub.id;
  const remaining = [...group.attachments];
  group.attachments.clear();
  forgetLiveGroup(ctx, group);
  if (opts.sendClose) {
    try {
      if (ctx.connected()) ctx.send(["CLOSE", id]);
    } catch {
      // ignore
    }
  }
  const errors: unknown[] = [];
  for (const att of remaining) {
    captureListenerError(errors, () => {
      att.close(opts.reason);
    });
  }
  flushListenerErrors(errors);
}

export function deliverLiveEvent(ctx: LiveCtx, group: LiveGroup, event: Event): void {
  const sub = group.sub;
  const attachments = [...group.attachments];
  const errors: unknown[] = [];
  for (const att of attachments) {
    captureListenerError(errors, () => {
      att.handlers.receivedEvent?.(event.id);
    });
  }
  if (sub.idsAtWatermark.has(event.id)) {
    flushListenerErrors(errors);
    return;
  }

  const recipients: Subscription[] = [];
  for (const att of attachments) {
    if (att.closed) continue;
    let skip = false;
    captureListenerError(errors, () => {
      skip = Boolean(att.handlers.alreadyHaveEvent?.(event.id));
    });
    if (!skip) recipients.push(att);
  }
  if (recipients.length === 0) {
    flushListenerErrors(errors);
    return;
  }
  if (!ctx.acceptEvent(event)) {
    flushListenerErrors(errors);
    return;
  }

  sub.noteVerified(event);
  for (const att of recipients) att.noteVerified(event);
  for (const att of recipients) {
    captureListenerError(errors, () => {
      att.handlers.onevent?.(event);
    });
  }
  flushListenerErrors(errors);
}

export function deliverLiveEose(group: LiveGroup): void {
  const attachments = Array.from(group.attachments);
  const errors: unknown[] = [];
  for (const att of attachments) {
    if (att.closed || att.eosed) continue;
    att.eosed = true;
    captureListenerError(errors, () => {
      att.handlers.oneose?.();
    });
  }
  flushListenerErrors(errors);
}

export function closeAllSubscriptions(ctx: LiveCtx, reason: string): void {
  const errors: unknown[] = [];
  const fps = Array.from(ctx.liveByFp.keys());
  for (const fp of fps) {
    captureListenerError(errors, () => {
      endLiveGroup(ctx, fp, { sendClose: false, reason });
    });
  }
  for (const sub of ctx.subs.values()) {
    if (!sub.closed) {
      sub.closed = true;
      captureListenerError(errors, () => {
        sub.handlers.onclose?.(reason);
      });
    }
  }
  ctx.subs.clear();
  ctx.liveByFp.clear();
  ctx.liveBySubId.clear();
  flushListenerErrors(errors);
}

export function dropSubscription(ctx: LiveCtx, sub: Subscription, reason: string): void {
  const group = ctx.liveBySubId.get(sub.id);
  if (group) {
    endLiveGroup(ctx, group.fp, { sendClose: false, reason });
    return;
  }
  ctx.subs.delete(sub.id);
  sub.closed = true;
  sub.handlers.onclose?.(reason);
}

export function onSubEvent(ctx: LiveCtx, subId: string, event: Event): void {
  const sub = ctx.subs.get(subId);
  if (!sub || sub.closed) return;
  const group = ctx.liveBySubId.get(subId);
  if (group) {
    deliverLiveEvent(ctx, group, event);
    return;
  }
  sub.handlers.receivedEvent?.(event.id);
  if (sub.idsAtWatermark.has(event.id)) return;
  if (sub.handlers.alreadyHaveEvent?.(event.id)) return;
  if (!ctx.acceptEvent(event)) return;
  sub.noteVerified(event);
  sub.handlers.onevent?.(event);
}

export function onSubEose(ctx: LiveCtx, subId: string): void {
  const sub = ctx.subs.get(subId);
  if (!sub || sub.closed) return;
  if (sub.eosed) return;
  sub.eosed = true;
  const group = ctx.liveBySubId.get(subId);
  if (group) {
    deliverLiveEose(group);
  } else {
    sub.handlers.oneose?.();
    if (sub.closeOnEose) sub.close("eose");
  }
}

export function resubscribeAll(ctx: LiveCtx): boolean {
  for (const sub of ctx.subs.values()) {
    if (sub.closed) continue;
    sub.eosed = false;
    sub.authRetried = false;
    const group = ctx.liveBySubId.get(sub.id);
    if (group) {
      for (const att of group.attachments) att.eosed = false;
    }
    try {
      ctx.send(["REQ", sub.id, ...sub.replayFilters()]);
    } catch {
      return false;
    }
  }
  return true;
}

export function streamFilters(
  subscribe: (filters: Filter[], opts: SubscribeOptions) => Subscription,
  filters: Filter[],
  opts?: { signal?: AbortSignal; id?: string },
): AsyncIterable<Event> & { close: (reason?: string) => void } {
  return subscriptionToAsyncIterable(
    (handlers) => subscribe(filters, { ...handlers, id: opts?.id, signal: opts?.signal }),
    { signal: opts?.signal },
  );
}

export async function fetchFilters(
  subscribe: (filters: Filter[], opts: SubscribeOptions) => Subscription,
  filters: Filter[],
  opts: { timeoutMs: number; signal?: AbortSignal; id?: string; url: string },
): Promise<Event[]> {
  const events: Event[] = [];
  const seen = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.close(err ? err.message : "fetch complete");
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => done(), opts.timeoutMs);

    const sub = subscribe(filters, {
      id: opts.id,
      signal: opts.signal,
      closeOnEose: true,
      onevent(event) {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        events.push(event);
      },
      oneose() {
        done();
      },
      onclose() {
        if (!settled) done();
      },
    });

    opts.signal?.addEventListener(
      "abort",
      () => done(new RelayConnectionError("fetch aborted", opts.url)),
      { once: true },
    );
  });

  return events;
}

export function armEoseTimeout(sub: Subscription, eoseTimeoutMs: number): void {
  const timer = setTimeout(() => {
    if (sub.eosed || sub.closed) return;
    sub.eosed = true;
    sub.handlers.oneose?.();
  }, eoseTimeoutMs);
  const prevClose = sub.handlers.onclose;
  sub.handlers.onclose = (reason) => {
    clearTimeout(timer);
    prevClose?.(reason);
  };
  const prevEose = sub.handlers.oneose;
  sub.handlers.oneose = () => {
    clearTimeout(timer);
    prevEose?.();
  };
}
