import { describe, expect, test } from "vite-plus/test";
import { ReactiveEventStore } from "../src/index.ts";
import type { Event } from "../src/core/event.ts";
import { Keys } from "../src/index.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

const N = 100_000;
const WATCHES = 100;

// The index does not verify signatures; fabricate events so the measurement
// covers store.add only, not schnorr signing.
function event(i: number, pubkey: string): Event {
  return {
    id: i.toString(16).padStart(64, "0"),
    pubkey,
    created_at: 1_700_000_000 + i,
    kind: 1,
    tags: [],
    content: `note ${i}`,
    sig: "00".repeat(64),
  };
}

describe("reactive store bench", () => {
  test(`add: ${N} events with ${WATCHES} subscribed query watches`, () => {
    const store = new ReactiveEventStore({ maxEvents: N });
    const pubkey = Keys.fromSecretKey(SK).publicKey;

    for (let i = 0; i < WATCHES; i++) {
      const watch = store.watchQuery([{ kinds: [1], "#t": [`t${i}`] }]);
      watch.subscribe(() => {});
      watch.getSnapshot();
    }

    const events: Event[] = Array.from({ length: N }, (_, i) => event(i, pubkey));

    const t0 = performance.now();
    for (let i = 0; i < N; i++) store.add(events[i]!, "wss://bench");
    const ms = performance.now() - t0;

    const usPerAdd = (ms / N) * 1000;
    console.log(
      `[reactive-store bench] ${N} adds × ${WATCHES} watches: ${ms.toFixed(1)}ms total, ` +
        `${usPerAdd.toFixed(2)}µs per add`,
    );
    expect(store.size).toBeLessThanOrEqual(N);
  }, 300_000);
});
