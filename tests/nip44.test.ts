import { describe, expect, test } from "vite-plus/test";
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
    const cipher = await a.nip44Encrypt!(pkB, "hello nip44");
    expect(await b.nip44Decrypt!(pkA, cipher)).toBe("hello nip44");
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
