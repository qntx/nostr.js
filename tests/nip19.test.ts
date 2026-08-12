import { describe, expect, test } from "vite-plus/test";
import {
  decodeNostrURI,
  getPublicKey,
  naddrEncode,
  neventEncode,
  nip19Decode,
  noteEncode,
  nprofileEncode,
  npubEncode,
  nsecEncode,
  SecretKey,
} from "../src/index.ts";

describe("nip19", () => {
  test("nsec / npub / note round-trip", () => {
    const sk = SecretKey.generate();
    const nsec = nsecEncode(sk.bytes);
    expect(nsec).toMatch(/^nsec1/);
    const decoded = nip19Decode(nsec);
    expect(decoded.type).toBe("nsec");
    if (decoded.type === "nsec") {
      expect(Array.from(decoded.data)).toEqual(Array.from(sk.bytes));
    }

    const pk = getPublicKey(sk);
    const npub = npubEncode(pk);
    expect(nip19Decode(npub)).toEqual({ type: "npub", data: pk });

    const note = noteEncode(pk);
    expect(nip19Decode(note)).toEqual({ type: "note", data: pk });
  });

  test("nprofile / nevent / naddr round-trip", () => {
    const pk = getPublicKey(SecretKey.generate());
    const relays = ["wss://relay.example.com", "wss://nostr.banana.com"];

    const nprofile = nprofileEncode({ pubkey: pk, relays });
    const profile = nip19Decode(nprofile);
    expect(profile.type).toBe("nprofile");
    if (profile.type === "nprofile") {
      expect(profile.data.pubkey).toBe(pk);
      expect(profile.data.relays).toEqual(expect.arrayContaining(relays));
    }

    const nevent = neventEncode({ id: pk, relays, kind: 1, author: pk });
    const event = nip19Decode(nevent);
    expect(event.type).toBe("nevent");
    if (event.type === "nevent") {
      expect(event.data.id).toBe(pk);
      expect(event.data.kind).toBe(1);
      expect(event.data.author).toBe(pk);
    }

    const naddr = naddrEncode({
      identifier: "banana",
      pubkey: pk,
      kind: 30023,
      relays,
    });
    const addr = nip19Decode(naddr);
    expect(addr.type).toBe("naddr");
    if (addr.type === "naddr") {
      expect(addr.data.identifier).toBe("banana");
      expect(addr.data.kind).toBe(30023);
      expect(addr.data.pubkey).toBe(pk);
    }
  });

  test("decodeNostrURI handles prefix and invalid", () => {
    const pk = getPublicKey(SecretKey.generate());
    const npub = npubEncode(pk);
    const ok = decodeNostrURI(`nostr:${npub}`);
    expect(ok.type).toBe("npub");
    expect(decodeNostrURI("not-a-code").type).toBe("invalid");
  });
});
