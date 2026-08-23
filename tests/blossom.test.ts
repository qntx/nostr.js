import { base64, base64urlnopad } from "@scure/base";
import { describe, expect, test } from "vite-plus/test";
import {
  EventValidationError,
  Kind,
  Keys,
  blossomServerListEventBuilder,
  checkUpload,
  createAuthTemplate,
  createUploadAuth,
  deleteBlob,
  encodeAuthorizationHeader,
  finalizeEvent,
  getHashFromURL,
  listBlobs,
  mirrorBlob,
  parseBlossomServerList,
  sha256Blob,
  upload,
  utf8Encoder,
  type BlobDescriptor,
  type BlossomFetch,
  type Event,
} from "../src/index.ts";

const HASH = "b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SK = "d217c1ff2f8a65c3e3a1740db3b9f58b8c848bb45e26d00ed4714e4a0f4ceecf";

function signAuth(template: Parameters<typeof finalizeEvent>[0]): Event {
  return finalizeEvent(template, Keys.fromSecretKey(SK).secretKey);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getHashFromURL", () => {
  test("last 64-char hex, extension ignored", () => {
    expect(getHashFromURL(`https://blossom.example.com/${HASH}.pdf`)).toBe(HASH);
    expect(getHashFromURL(`https://cdn.example.com/${HASH}`)).toBe(HASH);
  });

  test("nested path uses the last hash, not a parent hex segment", () => {
    expect(
      getHashFromURL(
        `https://cdn.example.com/user/ec4425ff5e9446080d2f70440188e3ca5d6da8713db7bdeef73d0ed54d9093f0/media/${HASH}.pdf`,
      ),
    ).toBe(HASH);
    expect(getHashFromURL(`http://media.example.com/documents/b1/67/${HASH}.png`)).toBe(HASH);
  });

  test("lowercases mixed-case hex; null when none", () => {
    expect(getHashFromURL(`https://cdn.example.com/${HASH.toUpperCase()}.bin`)).toBe(HASH);
    expect(getHashFromURL("https://cdn.example.com/media/photo.png")).toBeNull();
  });
});

describe("sha256Blob", () => {
  test("known bytes", async () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    expect(await sha256Blob(bytes)).toBe(ABC_SHA256);
    expect(await sha256Blob(bytes.buffer)).toBe(ABC_SHA256);
    expect(await sha256Blob(new Blob(["abc"]))).toBe(ABC_SHA256);
  });
});

describe("auth", () => {
  test("encodeAuthorizationHeader is Nostr + base64url, not standard base64", () => {
    const event = signAuth(
      createAuthTemplate("upload", { sha256: HASH, message: "Uploading media file" }),
    );
    const header = encodeAuthorizationHeader(event);
    expect(header.startsWith("Nostr ")).toBe(true);
    const token = header.slice("Nostr ".length);
    const json = utf8Encoder.encode(JSON.stringify(event));
    expect(token).toBe(base64urlnopad.encode(json));
    expect(token).not.toBe(base64.encode(json));
    expect(token.includes("+")).toBe(false);
    expect(token.includes("/")).toBe(false);
    expect(token.endsWith("=")).toBe(false);
    expect(token.includes("-") || token.includes("_") || token.length % 4 !== 0).toBe(true);
  });

  test("createAuthTemplate default expiration is ~now+3600", () => {
    const now = Math.floor(Date.now() / 1000);
    const template = createAuthTemplate("upload");
    expect(template.kind).toBe(Kind.BlobsAuth);
    const exp = template.tags.find((t) => t[0] === "expiration")?.[1];
    expect(exp).toBeDefined();
    const n = Number(exp);
    expect(n).toBeGreaterThanOrEqual(now + 3590);
    expect(n).toBeLessThanOrEqual(now + 3610);
  });

  test('createAuthTemplate("upload") never emits t=mirror', () => {
    const template = createAuthTemplate("upload", { sha256: HASH });
    const tValues = template.tags.filter((t) => t[0] === "t").map((t) => t[1]);
    expect(tValues).toEqual(["upload"]);
    expect(template.tags.some((t) => t[1] === "mirror")).toBe(false);
  });

  test("createUploadAuth hashes the file and signs kind 24242", async () => {
    const file = new Blob(["abc"], { type: "text/plain" });
    const event = await createUploadAuth(async (t) => signAuth(t), file, {
      message: "Uploading media file",
    });
    expect(event.kind).toBe(Kind.BlobsAuth);
    expect(event.content).toBe("Uploading media file");
    expect(event.tags).toContainEqual(["t", "upload"]);
    expect(event.tags).toContainEqual(["x", ABC_SHA256]);
  });
});

describe("http", () => {
  test("upload PUT /upload with Authorization, X-SHA-256, redirect manual", async () => {
    const file = new Blob(["abc"], { type: "text/plain" });
    const auth = await createUploadAuth(async (t) => signAuth(t), file);
    const desc: BlobDescriptor = {
      url: `https://cdn.example.com/${ABC_SHA256}.txt`,
      sha256: ABC_SHA256,
      size: 3,
      type: "text/plain",
      uploaded: 1_700_000_000,
    };
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl: BlossomFetch = async (input, init) => {
      seen = { url: String(input), init };
      return jsonResponse(desc, 201);
    };
    const got = await upload("https://cdn.example.com", file, auth, { fetch: fetchImpl });
    expect(got).toEqual(desc);
    expect(seen?.url).toBe("https://cdn.example.com/upload");
    expect(seen?.init?.method).toBe("PUT");
    expect(seen?.init?.redirect).toBe("manual");
    expect(seen?.init?.body).toBe(file);
    const headers = seen?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(encodeAuthorizationHeader(auth));
    expect(headers["X-SHA-256"]).toBe(ABC_SHA256);
  });

  test("checkUpload HEAD /upload", async () => {
    const file = new Blob(["abc"], { type: "text/plain" });
    const auth = await createUploadAuth(async (t) => signAuth(t), file);
    const fetchImpl: BlossomFetch = async (input, init) => {
      expect(String(input)).toBe("https://cdn.example.com/upload");
      expect(init?.method).toBe("HEAD");
      expect(init?.redirect).toBe("manual");
      const headers = init?.headers as Record<string, string>;
      expect(headers["X-SHA-256"]).toBe(ABC_SHA256);
      expect(headers["X-Content-Length"]).toBe(String(file.size));
      expect(headers["X-Content-Type"]).toBe(file.type);
      return new Response(null, { status: 200 });
    };
    await checkUpload("https://cdn.example.com/", file, auth, { fetch: fetchImpl });
  });

  test("listBlobs GET /list/<pubkey>; omit Authorization when auth is undefined", async () => {
    const keys = Keys.fromSecretKey(SK);
    const desc: BlobDescriptor = {
      url: `https://cdn.example.com/${ABC_SHA256}`,
      sha256: ABC_SHA256,
      size: 3,
    };
    const fetchImpl: BlossomFetch = async (input, init) => {
      expect(String(input)).toBe(`https://cdn.example.com/list/${keys.publicKey}`);
      expect(init?.method).toBe("GET");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      return jsonResponse([desc]);
    };
    expect(
      await listBlobs("https://cdn.example.com", keys.publicKey, undefined, { fetch: fetchImpl }),
    ).toEqual([desc]);
  });

  test("deleteBlob DELETE /<sha256>", async () => {
    const auth = signAuth(createAuthTemplate("delete", { sha256: ABC_SHA256 }));
    const fetchImpl: BlossomFetch = async (input, init) => {
      expect(String(input)).toBe(`https://cdn.example.com/${ABC_SHA256}`);
      expect(init?.method).toBe("DELETE");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 204 });
    };
    await deleteBlob("https://cdn.example.com", ABC_SHA256, auth, { fetch: fetchImpl });
  });

  test("mirrorBlob PUT /mirror JSON { url } with upload auth", async () => {
    const blob: BlobDescriptor = {
      url: `https://origin.example.com/${ABC_SHA256}.txt`,
      sha256: ABC_SHA256,
      size: 3,
      type: "text/plain",
    };
    const auth = signAuth(createAuthTemplate("upload", { sha256: ABC_SHA256 }));
    expect(auth.tags).toContainEqual(["t", "upload"]);
    const mirrored = { ...blob, url: `https://cdn.example.com/${ABC_SHA256}.txt` };
    const fetchImpl: BlossomFetch = async (input, init) => {
      expect(String(input)).toBe("https://cdn.example.com/mirror");
      expect(init?.method).toBe("PUT");
      expect(init?.redirect).toBe("manual");
      expect(init?.body).toBe(JSON.stringify({ url: blob.url }));
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(encodeAuthorizationHeader(auth));
      return jsonResponse(mirrored);
    };
    expect(await mirrorBlob("https://cdn.example.com", blob, { auth, fetch: fetchImpl })).toEqual(
      mirrored,
    );
  });
});

describe("kind 10063", () => {
  test("parseBlossomServerList reads server tags", () => {
    const keys = Keys.fromSecretKey(SK);
    const event = blossomServerListEventBuilder([
      "https://blossom.self.hosted/",
      "https://cdn.blossom.cloud",
      "https://cdn.blossom.cloud/",
      "wss://not-http.example",
    ]).signWithKeys(keys);
    expect(event.kind).toBe(Kind.BlossomServerList);
    expect(parseBlossomServerList(event)).toEqual([
      "https://blossom.self.hosted",
      "https://cdn.blossom.cloud",
    ]);
    expect(() => parseBlossomServerList({ kind: Kind.TextNote, tags: event.tags })).toThrow(
      EventValidationError,
    );
  });
});
