import { describe, expect, test } from "vite-plus/test";
import {
  Nip13Error,
  getEventHash,
  getPow,
  hexToBytes,
  minePow,
  type UnsignedEvent,
} from "../src/index.ts";

const NIP13_EXAMPLE_ID = "000006d8c378af1779d2feebc7603a125d99eca0ccf1085959b307f64e5dd358";

const UNSIGNED: UnsignedEvent = {
  kind: 1,
  tags: [["t", "pow"]],
  content: "It's just me mining my own business",
  created_at: 0,
  pubkey: "79c2cae114ea28a981e7559b4fe7854a473521a8d22a66bbab9fa248eb820ff6",
};

describe("nip13 getPow", () => {
  test("NIP-13 example id has at least 20 leading zero bits", () => {
    expect(getPow(NIP13_EXAMPLE_ID)).toBeGreaterThanOrEqual(20);
    expect(getPow(NIP13_EXAMPLE_ID)).toBe(21);
  });

  test("hex and raw bytes agree", () => {
    expect(getPow(hexToBytes(NIP13_EXAMPLE_ID))).toBe(getPow(NIP13_EXAMPLE_ID));
    expect(getPow("ac4f44bae06a45ebe88cfbd3c66358750159650a26c0d79e8ccaa92457fca4f6")).toBe(0);
    expect(getPow("0000000000000000006cfbd3c66358750159650a26c0d79e8ccaa92457fca4f6")).toBe(73);
  });
});

describe("nip13 minePow", () => {
  test("mines difficulty 8 without mutating input", async () => {
    const tags = [...UNSIGNED.tags];
    const unsigned: UnsignedEvent = { ...UNSIGNED, tags };
    const mined = await minePow(unsigned, 8);

    expect(getPow(mined.id)).toBeGreaterThanOrEqual(8);
    expect(mined.id).toBe(getEventHash(mined));
    expect(mined.pubkey).toBe(unsigned.pubkey);
    expect(mined.content).toBe(unsigned.content);
    expect(mined.kind).toBe(unsigned.kind);
    expect("sig" in mined).toBe(false);

    const nonce = mined.tags.find((tag) => tag[0] === "nonce");
    expect(nonce?.[2]).toBe("8");
    expect(nonce?.[1]).toMatch(/^\d+$/);
    expect(mined.tags).toContainEqual(["t", "pow"]);

    expect(unsigned.tags).toBe(tags);
    expect(unsigned.tags).toEqual([["t", "pow"]]);
    expect(unsigned.created_at).toBe(0);
  });

  test("abort throws Nip13Error", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(minePow(UNSIGNED, 32, { signal: controller.signal })).rejects.toBeInstanceOf(
      Nip13Error,
    );
  });
});
