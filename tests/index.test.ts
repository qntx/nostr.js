import { expect, test } from "vite-plus/test";
import { Kind, finalizeEvent, verifyEvent, getPublicKey } from "../src/index.ts";

test("core root export signs and verifies", () => {
  const sk = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
  const event = finalizeEvent(
    {
      kind: Kind.TextNote,
      tags: [],
      content: "hello from @qntx/nostr",
      created_at: 1_700_000_000,
    },
    sk,
  );
  expect(event.pubkey).toBe(getPublicKey(sk));
  expect(verifyEvent(event)).toBe(true);
});
