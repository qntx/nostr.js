/**
 * Optional live-relay smoke tests.
 * Enable with: NOSTR_LIVE_RELAY=wss://… bun test tests/live-relay.test.ts
 *
 * Skipped by default so CI stays deterministic without network.
 * Uses describe.skip (not describe.runIf) for bun:test + vite-plus compatibility.
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
const describeLive = LIVE ? describe : describe.skip;

async function ensureNodeWebSocket(): Promise<void> {
  if (typeof globalThis.WebSocket !== "undefined") return;
  try {
    // Optional peer; avoid static resolve of `ws` types in typecheck.
    const mod = (await import(/* @vite-ignore */ "ws" as string)) as {
      default: Parameters<typeof useWebSocketImplementation>[0];
    };
    useWebSocketImplementation(mod.default);
  } catch {
    throw new Error("NOSTR_LIVE_RELAY set but no global WebSocket and `ws` is not installed");
  }
}

describeLive("live relay", () => {
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
