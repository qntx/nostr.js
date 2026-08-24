import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  KeysSigner,
  calcPaddedLen,
  getConversationKey,
  nip44Decrypt,
  nip44Encrypt,
} from "../src/index.ts";
import { bytesToHex } from "../src/core/util.ts";
import * as nip44 from "../src/nips/nip44.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(dir, "fixtures/nip44.vectors.json"), "utf8")) as {
  v2: {
    valid: {
      get_conversation_key: Array<{ sec1: string; pub2: string; conversation_key: string }>;
      calc_padded_len: Array<[number, number]>;
      encrypt_decrypt: Array<{
        sec1: string;
        sec2: string;
        conversation_key: string;
        nonce: string;
        plaintext: string;
        payload: string;
      }>;
    };
  };
};

describe("nip44", () => {
  test("get_conversation_key vectors", () => {
    for (const row of vectors.v2.valid.get_conversation_key) {
      const key = getConversationKey(hexToBytes(row.sec1), row.pub2);
      expect(bytesToHex(key)).toBe(row.conversation_key);
    }
  });

  test("calc_padded_len vectors", () => {
    for (const [input, expected] of vectors.v2.valid.calc_padded_len) {
      expect(calcPaddedLen(input)).toBe(expected);
    }
  });

  test("encrypt_decrypt vectors", () => {
    for (const row of vectors.v2.valid.encrypt_decrypt) {
      const ck = hexToBytes(row.conversation_key);
      const payload = nip44Encrypt(row.plaintext, ck, hexToBytes(row.nonce));
      expect(payload).toBe(row.payload);
      expect(nip44Decrypt(payload, ck)).toBe(row.plaintext);
    }
  });

  test("KeysSigner nip44 round-trip", async () => {
    const a = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000001");
    const b = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000002");
    const pkB = await b.getPublicKey();
    const pkA = await a.getPublicKey();
    expect(typeof a.nip44Encrypt).toBe("function");
    expect(typeof b.nip44Decrypt).toBe("function");
    const cipher = await a.nip44Encrypt(pkB, "hello nip44");
    expect(await b.nip44Decrypt(pkA, cipher)).toBe("hello nip44");
  });

  describe("KeysSigner NIP-44 conversation-key cache", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test("getConversationKey is derived once per peer and shared with decrypt", async () => {
      const a = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000001");
      const b = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000002");
      const c = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000003");
      const peerA = await b.getPublicKey();
      const peerB = await c.getPublicKey();
      expect(peerA).not.toBe(peerB);

      const spy = vi.spyOn(nip44, "getConversationKey");
      const first = await a.nip44Encrypt(peerA, "one");
      const second = await a.nip44Encrypt(peerA, "two");
      expect(spy.mock.calls.length).toBe(1);
      expect(spy.mock.calls[0]).toEqual([a.keys.secretKey.bytes, peerA]);
      expect(first).not.toBe(second);
      expect(await a.nip44Decrypt(peerA, first)).toBe("one");
      expect(await a.nip44Decrypt(peerA, second)).toBe("two");

      const third = await a.nip44Encrypt(peerB, "three");
      expect(spy.mock.calls.length).toBe(2);
      expect(spy.mock.calls[1]).toEqual([a.keys.secretKey.bytes, peerB]);
      expect(await a.nip44Decrypt(peerB, third)).toBe("three");

      expect(await a.nip44Decrypt(peerA, first)).toBe("one");
      expect(spy.mock.calls.length).toBe(2);
    });

    test("low-level nip44.encrypt ciphertext decrypts via KeysSigner cache hit", async () => {
      const signer = new KeysSigner(
        "0000000000000000000000000000000000000000000000000000000000000001",
      );
      const peerSigner = new KeysSigner(
        "0000000000000000000000000000000000000000000000000000000000000002",
      );
      const peer = await peerSigner.getPublicKey();
      const plaintext = "interop cache";
      const payload = nip44.encrypt(
        plaintext,
        nip44.getConversationKey(signer.keys.secretKey.bytes, peer),
      );
      const spy = vi.spyOn(nip44, "getConversationKey");
      expect(typeof signer.nip44Encrypt).toBe("function");
      expect(typeof signer.nip44Decrypt).toBe("function");
      const warm = await signer.nip44Encrypt(peer, "warm");
      expect(spy.mock.calls.length).toBe(1);
      expect(spy.mock.calls[0]).toEqual([signer.keys.secretKey.bytes, peer]);
      expect(await signer.nip44Decrypt(peer, warm)).toBe("warm");
      expect(await signer.nip44Decrypt(peer, payload)).toBe(plaintext);
      expect(spy.mock.calls.length).toBe(1);
    });

    test("mixed-case peer hits the same cache entry", async () => {
      const a = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000001");
      const b = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000002");
      const peer = await b.getPublicKey();
      const spy = vi.spyOn(nip44, "getConversationKey");
      const cipher = await a.nip44Encrypt(peer.toUpperCase(), "cased");
      expect(await a.nip44Decrypt(peer, cipher)).toBe("cased");
      expect(spy.mock.calls.length).toBe(1);
      expect(spy.mock.calls[0]).toEqual([a.keys.secretKey.bytes, peer]);
    });

    test("failed derivation is not cached", async () => {
      const a = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000001");
      const spy = vi.spyOn(nip44, "getConversationKey");
      await expect(a.nip44Encrypt("gg".repeat(32), "hi")).rejects.toThrow(/invalid public key/);
      await expect(a.nip44Encrypt("not-a-pubkey", "hi")).rejects.toThrow(/invalid public key/);
      expect(spy.mock.calls.length).toBe(2);
      await expect(a.nip44Encrypt("gg".repeat(32), "again")).rejects.toThrow(/invalid public key/);
      expect(spy.mock.calls.length).toBe(3);
    });

    test("decrypt errors reuse the cached key and still throw", async () => {
      const a = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000001");
      const b = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000002");
      const c = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000003");
      const peerA = await b.getPublicKey();
      const peerB = await c.getPublicKey();
      const spy = vi.spyOn(nip44, "getConversationKey");
      const cipher = await a.nip44Encrypt(peerA, "ok");
      expect(spy.mock.calls.length).toBe(1);

      await expect(a.nip44Decrypt(peerA, "short")).rejects.toThrow(/invalid payload length/);
      expect(spy.mock.calls.length).toBe(1);

      await expect(a.nip44Encrypt(peerA, "")).rejects.toThrow(/invalid plaintext size/);
      expect(spy.mock.calls.length).toBe(1);

      await expect(a.nip44Decrypt(peerB, cipher)).rejects.toThrow(/invalid MAC/);
      expect(spy.mock.calls.length).toBe(2);
    });

    test("each KeysSigner instance keeps its own conversation-key cache", async () => {
      const a = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000001");
      const b = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000002");
      const c = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000003");
      const peer = await c.getPublicKey();
      const spy = vi.spyOn(nip44, "getConversationKey");
      const fromA = await a.nip44Encrypt(peer, "from a");
      const fromB = await b.nip44Encrypt(peer, "from b");
      expect(spy.mock.calls.length).toBe(2);
      expect(await c.nip44Decrypt(await a.getPublicKey(), fromA)).toBe("from a");
      expect(await c.nip44Decrypt(await b.getPublicKey(), fromB)).toBe("from b");
    });

    test("encryptToPubkey is independent of KeysSigner conversation-key cache", async () => {
      const a = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000001");
      const b = new KeysSigner("0000000000000000000000000000000000000000000000000000000000000002");
      const peer = await b.getPublicKey();
      const signed = await a.nip44Encrypt(peer, "cached");
      const first = nip44.encryptToPubkey("gift wrap", a.keys.secretKey.bytes, peer);
      const second = nip44.encryptToPubkey("gift wrap 2", a.keys.secretKey.bytes, peer);
      expect(first).not.toBe(second);
      expect(first).not.toBe(signed);
      expect(nip44.decryptFromPubkey(first, a.keys.secretKey.bytes, peer)).toBe("gift wrap");
      expect(nip44.decryptFromPubkey(second, a.keys.secretKey.bytes, peer)).toBe("gift wrap 2");
      expect(await a.nip44Decrypt(peer, signed)).toBe("cached");
    });
  });

  test("rejects conversation_key and nonce that are not 32 bytes", () => {
    const key = new Uint8Array(32);
    expect(() => nip44Encrypt("hi", key, new Uint8Array(16))).toThrow(/nonce must be 32 bytes/);
    expect(() => nip44Encrypt("hi", new Uint8Array(16))).toThrow(
      /conversation_key must be 32 bytes/,
    );
    expect(() => getConversationKey(new Uint8Array(16), "aa".repeat(32))).toThrow(
      /secret key length/,
    );
  });
});
