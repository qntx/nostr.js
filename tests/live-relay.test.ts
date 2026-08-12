/**
 * Optional live-relay smoke tests.
 * Enable with: NOSTR_LIVE_RELAY=wss://… vp test tests/live-relay.test.ts
 *
 * Skipped by default so CI stays deterministic without network.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  EventBuilder,
  Keys,
  KeysSigner,
  Client,
  useWebSocketImplementation,
} from "../src/index.ts";

const LIVE = process.env.NOSTR_LIVE_RELAY?.trim();

async function ensureNodeWebSocket(): Promise<void> {
  if (typeof globalThis.WebSocket !== "undefined") return;
  try {
    // Optional peer; types may be absent.
    // @ts-expect-error — no @types/ws required for this optional smoke path
    const mod = (await import("ws")) as { default: unknown };
    useWebSocketImplementation(mod.default as never);
  } catch {
    throw new Error("NOSTR_LIVE_RELAY set but no global WebSocket and `ws` is not installed");
  }
}

describe.runIf(Boolean(LIVE))("live relay", () => {
  test("connect publish fetch against NOSTR_LIVE_RELAY", async () => {
    await ensureNodeWebSocket();
    const url = LIVE!;
    const keys = Keys.generate();
    const client = Client.builder()
      .signer(new KeysSigner(keys))
      .relays([url])
      .enableReconnect(false)
      .build();

    await client.connect();
    const stamp = `qntx-live-${Date.now()}`;
    const results = await client.publish(EventBuilder.textNote(stamp));
    expect(results.some((r) => r.result?.ok)).toBe(true);

    const found = await client.fetchEvents(
      { kinds: [1], authors: [keys.publicKey], limit: 5 },
      { timeoutMs: 8_000 },
    );
    expect(found.some((e) => e.content === stamp)).toBe(true);

    await client.shutdown();
  }, 20_000);
});
