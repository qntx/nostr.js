import { describe, expect, test } from "vite-plus/test";
import { sha256 } from "@noble/hashes/sha2.js";
import { Kind, finalizeEvent } from "../src/index.ts";
import {
  Nip98Error,
  getToken,
  unpackEventFromToken,
  validateAuthEvent,
} from "../src/nips/nip98.ts";
import { bytesToHex, utf8Encoder } from "../src/core/util.ts";

const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";
const URL = "https://api.example.com/upload?x=1";
const METHOD = "POST";

function sign(template: Parameters<typeof finalizeEvent>[0]) {
  return finalizeEvent(template, SK);
}

describe("nip98", () => {
  test("round-trip token: kind 27235, u/method tags, standard base64", async () => {
    const token = await getToken(URL, METHOD, sign);
    expect(token.startsWith("Nostr ")).toBe(false);
    expect(/^[A-Za-z0-9+/]+=*$/.test(token)).toBe(true);

    const event = unpackEventFromToken(token);
    expect(event.kind).toBe(Kind.HttpAuth);
    expect(event.kind).toBe(27235);
    expect(event.content).toBe("");
    expect(event.tags).toEqual([
      ["u", URL],
      ["method", METHOD],
    ]);
    expect(validateAuthEvent(event, URL, METHOD)).toBe(true);
    expect(validateAuthEvent(event, URL, "post")).toBe(true);
  });

  test("includeAuthorizationScheme prefixes Nostr and still unpacks", async () => {
    const token = await getToken(URL, METHOD, sign, { includeAuthorizationScheme: true });
    expect(token.startsWith("Nostr ")).toBe(true);
    const raw = token.slice("Nostr ".length);
    expect(/^[A-Za-z0-9+/]+=*$/.test(raw)).toBe(true);
    expect(raw.includes("-") || raw.includes("_")).toBe(false);

    const event = unpackEventFromToken(token);
    expect(validateAuthEvent(event, URL, METHOD)).toBe(true);
  });

  test("content option is stored on the event", async () => {
    const token = await getToken(URL, METHOD, sign, { content: "Uploading media file" });
    expect(unpackEventFromToken(token).content).toBe("Uploading media file");
  });

  test("u/method mismatch fails", async () => {
    const event = unpackEventFromToken(await getToken(URL, METHOD, sign));
    expect(validateAuthEvent(event, "https://other.example/upload?x=1", METHOD)).toBe(false);
    expect(validateAuthEvent(event, URL, "GET")).toBe(false);
  });

  test("timestamp skew fails unless maxSkewSec covers it", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = unpackEventFromToken(await getToken(URL, METHOD, sign, { now: now - 120 }));
    expect(validateAuthEvent(stale, URL, METHOD)).toBe(false);
    expect(validateAuthEvent(stale, URL, METHOD, { maxSkewSec: 180 })).toBe(true);

    const future = unpackEventFromToken(await getToken(URL, METHOD, sign, { now: now + 120 }));
    expect(validateAuthEvent(future, URL, METHOD)).toBe(false);
  });

  test("payload tag hashes objects via JSON.stringify; string/bytes as raw body", async () => {
    const payload = { name: "file.png", size: 12 };
    const expected = bytesToHex(sha256(utf8Encoder.encode(JSON.stringify(payload))));
    const event = unpackEventFromToken(await getToken(URL, METHOD, sign, { payload }));
    expect(event.tags).toEqual([
      ["u", URL],
      ["method", METHOD],
      ["payload", expected],
    ]);
    expect(validateAuthEvent(event, URL, METHOD, { payload })).toBe(true);
    expect(validateAuthEvent(event, URL, METHOD, { payload: { name: "other" } })).toBe(false);
    expect(validateAuthEvent(event, URL, METHOD)).toBe(true);

    const raw = "raw-body";
    const rawEvent = unpackEventFromToken(await getToken(URL, METHOD, sign, { payload: raw }));
    expect(rawEvent.tags[2]).toEqual(["payload", bytesToHex(sha256(utf8Encoder.encode(raw)))]);
    expect(rawEvent.tags[2]?.[1]).not.toBe(
      bytesToHex(sha256(utf8Encoder.encode(JSON.stringify(raw)))),
    );

    const bytes = new Uint8Array([1, 2, 3]);
    const bytesEvent = unpackEventFromToken(await getToken(URL, METHOD, sign, { payload: bytes }));
    expect(bytesEvent.tags[2]).toEqual(["payload", bytesToHex(sha256(bytes))]);
  });

  test("wrong kind or bad signature fails validation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const note = finalizeEvent(
      {
        kind: Kind.TextNote,
        tags: [
          ["u", URL],
          ["method", METHOD],
        ],
        content: "",
        created_at: now,
      },
      SK,
    );
    expect(validateAuthEvent(note, URL, METHOD)).toBe(false);

    const event = unpackEventFromToken(await getToken(URL, METHOD, sign));
    const badSig = { ...event, sig: "00".repeat(64) };
    expect(validateAuthEvent(badSig, URL, METHOD)).toBe(false);
  });

  test("unpackEventFromToken throws Nip98Error on garbage", () => {
    expect(() => unpackEventFromToken("")).toThrow(Nip98Error);
    expect(() => unpackEventFromToken("%")).toThrow(Nip98Error);
    expect(() => unpackEventFromToken("bm90LWFuLWV2ZW50")).toThrow(Nip98Error);
  });

  test("unpacks unpadded standard base64 (NIP-98 spec example)", () => {
    // 98.md Authorization example: unpadded, len % 4 === 2, alphabet +/ not -_
    const spec =
      "eyJpZCI6ImZlOTY0ZTc1ODkwMzM2MGYyOGQ4NDI0ZDA5MmRhODQ5NGVkMjA3Y2JhODIzMTEwYmUzYTU3ZGZlNGI1Nzg3MzQiLCJwdWJrZXkiOiI2M2ZlNjMxOGRjNTg1ODNjZmUxNjgxMGY4NmRkMDllMThiZmQ3NmFhYmMyNGEwMDgxY2UyODU2ZjMzMDUwNGVkIiwiY29udGVudCI6IiIsImtpbmQiOjI3MjM1LCJjcmVhdGVkX2F0IjoxNjgyMzI3ODUyLCJ0YWdzIjpbWyJ1IiwiaHR0cHM6Ly9hcGkuc25vcnQuc29jaWFsL2FwaS92MS9uNXNwL2xpc3QiXSxbIm1ldGhvZCIsIkdFVCJdXSwic2lnIjoiNWVkOWQ4ZWM5NThiYzg1NGY5OTdiZGMyNGFjMzM3ZDAwNWFmMzcyMzI0NzQ3ZWZlNGEwMGUyNGY0YzMwNDM3ZmY0ZGQ4MzA4Njg0YmVkNDY3ZDlkNmJlM2U1YTUxN2JiNDNiMTczMmNjN2QzMzk0OWEzYWFmODY3MDVjMjIxODQifQ";
    expect(spec.length % 4).toBe(2);
    expect(spec.includes("=")).toBe(false);

    const event = unpackEventFromToken(spec);
    expect(event.id).toBe("fe964e758903360f28d8424d092da8494ed207cba823110be3a57dfe4b578734");
    expect(event.kind).toBe(Kind.HttpAuth);
    expect(event.tags).toEqual([
      ["u", "https://api.snort.social/api/v1/n5sp/list"],
      ["method", "GET"],
    ]);

    expect(unpackEventFromToken(`nostr ${spec}`).id).toBe(event.id);
    expect(unpackEventFromToken(`NOSTR ${spec}`).id).toBe(event.id);
  });

  test("strips padding from this library's tokens and still unpacks", async () => {
    const token = await getToken(URL, METHOD, sign);
    const unpadded = token.replace(/=+$/, "");
    expect(unpadded.length % 4).not.toBe(0);
    expect(unpackEventFromToken(unpadded).id).toBe(unpackEventFromToken(token).id);
  });

  test("scheme strip is case-insensitive", async () => {
    const raw = await getToken(URL, METHOD, sign);
    const event = unpackEventFromToken(`Nostr ${raw}`);
    expect(unpackEventFromToken(`nostr ${raw}`).id).toBe(event.id);
    expect(unpackEventFromToken(`NOSTR ${raw}`).id).toBe(event.id);
  });
});
