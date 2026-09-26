import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as bytesToHexNoble, hexToBytes } from "@noble/hashes/utils.js";
import { KeysSigner } from "../src/index.ts";
import { bytesToHex, utf8Encoder } from "../src/core/util.ts";
import * as nip44 from "../src/nips/nip44.ts";
import {
  DEFAULT_MAX_PAYLOAD_CHARS,
  calcPaddedLen,
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
  getConversationKey,
  getMessageKeys,
} from "../src/nips/nip44.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(dir, "fixtures/nip44.vectors.json"), "utf8")) as {
  v2: {
    valid: {
      get_conversation_key: Array<{ sec1: string; pub2: string; conversation_key: string }>;
      get_message_keys: {
        conversation_key: string;
        keys: Array<{
          nonce: string;
          chacha_key: string;
          chacha_nonce: string;
          hmac_key: string;
        }>;
      };
      calc_padded_len: Array<[number, number]>;
      encrypt_decrypt: Array<{
        sec1: string;
        sec2: string;
        conversation_key: string;
        nonce: string;
        plaintext: string;
        payload: string;
      }>;
      encrypt_decrypt_long_msg: Array<{
        conversation_key: string;
        nonce: string;
        pattern: string;
        repeat: number;
        plaintext_sha256: string;
        payload_sha256: string;
      }>;
    };
    invalid: {
      encrypt_msg_lengths: number[];
      get_conversation_key: Array<{ sec1: string; pub2: string; note: string }>;
      decrypt: Array<{
        conversation_key: string;
        nonce: string;
        plaintext: string;
        payload: string;
        note: string;
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

  test("get_message_keys vectors", () => {
    const { conversation_key, keys } = vectors.v2.valid.get_message_keys;
    const ck = hexToBytes(conversation_key);
    for (const row of keys) {
      const derived = getMessageKeys(ck, hexToBytes(row.nonce));
      expect(bytesToHex(derived.chacha_key)).toBe(row.chacha_key);
      expect(bytesToHex(derived.chacha_nonce)).toBe(row.chacha_nonce);
      expect(bytesToHex(derived.hmac_key)).toBe(row.hmac_key);
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

  test("encrypt_decrypt_long_msg vectors (payload too large to inline)", () => {
    for (const row of vectors.v2.valid.encrypt_decrypt_long_msg) {
      const plaintext = row.pattern.repeat(row.repeat);
      expect(bytesToHexNoble(sha256(utf8Encoder.encode(plaintext)))).toBe(row.plaintext_sha256);
      const ck = hexToBytes(row.conversation_key);
      const payload = nip44Encrypt(plaintext, ck, hexToBytes(row.nonce));
      expect(bytesToHexNoble(sha256(utf8Encoder.encode(payload)))).toBe(row.payload_sha256);
      expect(nip44Decrypt(payload, ck)).toBe(plaintext);
    }
  });

  // NIP-44 extended-prefix boundary vectors from the spec text (44.md): the
  // u16/u32 prefix switch happens at a plaintext length of 65536.
  test("extended length prefix boundary vectors", () => {
    const ck = hexToBytes("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    const nonce = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
    const cases: Array<[number, string, string]> = [
      [
        65535,
        "6e1bebca6a8229364a162a72ef064826c4cd7457bf54f190ef782bd9deff3e42",
        "6d8c2810d1e870fbaa1f0a0937126cca837a15f9260e27060c331d70a3c0bc84",
      ],
      [
        65536,
        "bf718b6f653bebc184e1479f1935b8da974d701b893afcf49e701f3e2f9f9c5a",
        "b7b4edb36ba92e267d322d56d9aebc22e7fa96ff52e3c12adc07f07a43cbc616",
      ],
      [
        65537,
        "008ffc88d3c96a9f307524eb361e47c5222a887fc45fa0c1fb8d429c5c23b430",
        "eeb7c7c5373894ea2c1547cfd3ccb15d5a0b2d619da852e5c79df792dcc9e435",
      ],
    ];
    for (const [len, plaintextSha, payloadSha] of cases) {
      const plaintext = "a".repeat(len);
      expect(bytesToHexNoble(sha256(utf8Encoder.encode(plaintext)))).toBe(plaintextSha);
      const payload = nip44Encrypt(plaintext, ck, nonce);
      expect(bytesToHexNoble(sha256(utf8Encoder.encode(payload)))).toBe(payloadSha);
      expect(nip44Decrypt(payload, ck)).toBe(plaintext);
    }
  });

  test("invalid.get_conversation_key vectors throw", () => {
    for (const row of vectors.v2.invalid.get_conversation_key) {
      expect(() => getConversationKey(hexToBytes(row.sec1), row.pub2)).toThrow();
    }
  });

  test("invalid.decrypt vectors throw", () => {
    for (const row of vectors.v2.invalid.decrypt) {
      expect(() => nip44Decrypt(row.payload, hexToBytes(row.conversation_key))).toThrow();
    }
  });

  test("invalid.encrypt_msg_lengths: 0 throws; >=65536 encrypt via u32 prefix", () => {
    const ck = hexToBytes("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    const lengths = vectors.v2.invalid.encrypt_msg_lengths;
    // The vector list predates the extended u32 length prefix: under the
    // current spec only sub-minimum lengths are invalid; >=65536 is valid.
    // Decrypting these oversized payloads needs a raised maxPayloadChars.
    expect(lengths[0]).toBe(0);
    expect(() => nip44Encrypt("", ck)).toThrow();
    for (const len of lengths.slice(1)) {
      const plaintext = "a".repeat(len);
      const payload = nip44Encrypt(plaintext, ck);
      expect(nip44Decrypt(payload, ck, { maxPayloadChars: payload.length })).toBe(plaintext);
    }
  });

  test("payload starting with # reports unknown version regardless of length", () => {
    const ck = hexToBytes("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    // The '#' check runs before the length check (spec pseudocode order).
    expect(() => nip44Decrypt("#", ck)).toThrow(/unknown encryption version/);
    expect(() => nip44Decrypt(`#${"A".repeat(200)}`, ck)).toThrow(/unknown encryption version/);
    expect(() => nip44Decrypt("A".repeat(131), ck)).toThrow(/invalid payload length/);
  });

  test("DEFAULT_MAX_PAYLOAD_CHARS covers exactly a 1 MiB plaintext", () => {
    const ck = hexToBytes("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    const oneMiB = "a".repeat(0x100000);
    const payload = nip44Encrypt(oneMiB, ck);
    // The cap is the base64 length of the payload for exactly 1 MiB of
    // plaintext, so a conforming 1 MiB payload decrypts with defaults.
    expect(payload.length).toBe(DEFAULT_MAX_PAYLOAD_CHARS);
    expect(nip44Decrypt(payload, ck)).toBe(oneMiB);

    const over = nip44Encrypt(`${oneMiB}a`, ck);
    expect(over.length).toBeGreaterThan(DEFAULT_MAX_PAYLOAD_CHARS);
    expect(() => nip44Decrypt(over, ck)).toThrow(/invalid payload length/);
    expect(nip44Decrypt(over, ck, { maxPayloadChars: over.length })).toBe(`${oneMiB}a`);
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
