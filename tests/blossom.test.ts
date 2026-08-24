import { base64, base64urlnopad } from "@scure/base";
import { describe, expect, test } from "vite-plus/test";
import {
  BlossomError,
  EventValidationError,
  Kind,
  Keys,
  blobExists,
  blossomServerListEventBuilder,
  checkUpload,
  createAuthTemplate,
  createUploadAuth,
  deleteBlob,
  encodeAuthorizationHeader,
  finalizeEvent,
  getBlob,
  getHashFromURL,
  healBlobUrl,
  listBlobs,
  mirrorBlob,
  parseBlossomServerList,
  sha256Blob,
  upload,
  uploadToServers,
  utf8Encoder,
  verifyBlob,
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

  test("invalid or relative URL returns null", () => {
    expect(getHashFromURL("not a url")).toBeNull();
    expect(getHashFromURL(`/${HASH}.pdf`)).toBeNull();
  });
});

describe("sha256Blob", () => {
  test("known bytes", async () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    expect(await sha256Blob(bytes)).toBe(ABC_SHA256);
    expect(await sha256Blob(bytes.buffer)).toBe(ABC_SHA256);
    expect(await sha256Blob(new Blob(["abc"]))).toBe(ABC_SHA256);
  });

  test("verifyBlob matches known hash", async () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    expect(await verifyBlob(bytes, ABC_SHA256)).toBe(true);
    expect(await verifyBlob(bytes, ABC_SHA256.toUpperCase())).toBe(true);
    expect(await verifyBlob(bytes, HASH)).toBe(false);
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

  test("upload keeps 10063 path prefix when joining /upload", async () => {
    const file = new Blob(["abc"]);
    const auth = await createUploadAuth(async (t) => signAuth(t), file);
    const keys = Keys.fromSecretKey(SK);
    const event = blossomServerListEventBuilder(["https://cdn.example.com/v1/"]).signWithKeys(keys);
    const servers = parseBlossomServerList(event);
    expect(servers).toEqual(["https://cdn.example.com/v1"]);
    let seen: string | undefined;
    const fetchImpl: BlossomFetch = async (input) => {
      seen = String(input);
      return jsonResponse({
        url: `https://cdn.example.com/v1/${ABC_SHA256}.txt`,
        sha256: ABC_SHA256,
        size: 3,
      });
    };
    await upload(servers[0]!, file, auth, { fetch: fetchImpl });
    expect(seen).toBe("https://cdn.example.com/v1/upload");
  });

  test("upload rejects descriptor whose sha256 does not match the file", async () => {
    const file = new Blob(["abc"]);
    const auth = await createUploadAuth(async (t) => signAuth(t), file);
    const fetchImpl: BlossomFetch = async () =>
      jsonResponse({
        url: `https://cdn.example.com/${HASH}.txt`,
        sha256: HASH,
        size: 3,
      });
    await expect(
      upload("https://cdn.example.com", file, auth, { fetch: fetchImpl }),
    ).rejects.toThrow(BlossomError);
    await expect(
      upload("https://cdn.example.com", file, auth, { fetch: fetchImpl }),
    ).rejects.toThrow(/sha256 mismatch/);
  });

  test("listBlobs rejects non-integer size", async () => {
    const keys = Keys.fromSecretKey(SK);
    const fetchImpl: BlossomFetch = async () =>
      jsonResponse([
        { url: `https://cdn.example.com/${ABC_SHA256}`, sha256: ABC_SHA256, size: 1.5 },
      ]);
    await expect(
      listBlobs("https://cdn.example.com", keys.publicKey, undefined, { fetch: fetchImpl }),
    ).rejects.toThrow(BlossomError);
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

  test("mirrorBlob rejects descriptor whose sha256 does not match the source blob", async () => {
    const blob: BlobDescriptor = {
      url: `https://origin.example.com/${ABC_SHA256}.txt`,
      sha256: ABC_SHA256,
      size: 3,
    };
    const auth = signAuth(createAuthTemplate("upload", { sha256: ABC_SHA256 }));
    const fetchImpl: BlossomFetch = async () =>
      jsonResponse({ url: `https://cdn.example.com/${HASH}.txt`, sha256: HASH, size: 3 });
    await expect(
      mirrorBlob("https://cdn.example.com", blob, { auth, fetch: fetchImpl }),
    ).rejects.toThrow(/sha256 mismatch/);
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

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

describe("blobExists", () => {
  test("HEAD 2xx is true; 404 is false", async () => {
    const fetch200: BlossomFetch = async (input, init) => {
      expect(String(input)).toBe(`https://cdn.example.com/${ABC_SHA256}`);
      expect(init?.method).toBe("HEAD");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 200 });
    };
    expect(await blobExists("https://cdn.example.com/", ABC_SHA256, { fetch: fetch200 })).toBe(
      true,
    );

    const fetch404: BlossomFetch = async () => new Response(null, { status: 404 });
    expect(await blobExists("https://cdn.example.com", ABC_SHA256, { fetch: fetch404 })).toBe(
      false,
    );
  });

  test("HEAD 500 throws", async () => {
    const fetchImpl: BlossomFetch = async () => new Response(null, { status: 500 });
    await expect(
      blobExists("https://cdn.example.com", ABC_SHA256, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: "BlossomError", status: 500 });
  });

  test("HEAD 405 throws and does not retry GET", async () => {
    const methods: string[] = [];
    const fetchImpl: BlossomFetch = async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(null, { status: 405 });
    };
    await expect(
      blobExists("https://cdn.example.com", ABC_SHA256, { fetch: fetchImpl }),
    ).rejects.toThrow(BlossomError);
    expect(methods).toEqual(["HEAD"]);
  });

  test("HEAD 3xx throws", async () => {
    const fetchImpl: BlossomFetch = async () =>
      new Response(null, { status: 302, headers: { Location: "https://other.example/x" } });
    await expect(
      blobExists("https://cdn.example.com", ABC_SHA256, { fetch: fetchImpl }),
    ).rejects.toThrow(BlossomError);
  });

  test("network error throws BlossomError; AbortError propagates", async () => {
    const net: BlossomFetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(blobExists("https://cdn.example.com", ABC_SHA256, { fetch: net })).rejects.toThrow(
      BlossomError,
    );

    const aborted = abortError();
    const abortFetch: BlossomFetch = async () => {
      throw aborted;
    };
    await expect(
      blobExists("https://cdn.example.com", ABC_SHA256, { fetch: abortFetch }),
    ).rejects.toBe(aborted);
  });
});

describe("getBlob", () => {
  test("GET 2xx returns bytes when sha256 matches", async () => {
    const body = new Uint8Array([0x61, 0x62, 0x63]);
    const fetchImpl: BlossomFetch = async (input, init) => {
      expect(String(input)).toBe(`https://cdn.example.com/${ABC_SHA256}`);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return new Response(body, { status: 200 });
    };
    expect(await getBlob("https://cdn.example.com", ABC_SHA256, { fetch: fetchImpl })).toEqual(
      body,
    );
  });

  test("sha256 mismatch throws", async () => {
    const fetchImpl: BlossomFetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    await expect(
      getBlob("https://cdn.example.com", ABC_SHA256, { fetch: fetchImpl }),
    ).rejects.toThrow(BlossomError);
    await expect(
      getBlob("https://cdn.example.com", ABC_SHA256, { fetch: fetchImpl }),
    ).rejects.toThrow(/sha256 mismatch/);
  });

  test("non-2xx throws", async () => {
    const fetchImpl: BlossomFetch = async () => new Response(null, { status: 404 });
    await expect(
      getBlob("https://cdn.example.com", ABC_SHA256, { fetch: fetchImpl }),
    ).rejects.toThrow(BlossomError);
  });

  test("network error throws BlossomError; AbortError propagates", async () => {
    const net: BlossomFetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(getBlob("https://cdn.example.com", ABC_SHA256, { fetch: net })).rejects.toThrow(
      BlossomError,
    );
    const aborted = abortError();
    const abortFetch: BlossomFetch = async () => {
      throw aborted;
    };
    await expect(
      getBlob("https://cdn.example.com", ABC_SHA256, { fetch: abortFetch }),
    ).rejects.toBe(aborted);
  });
});

describe("healBlobUrl", () => {
  const originalPng = `https://broken.example/${HASH}.png`;
  const originalBare = `https://broken.example/${HASH}`;

  test("no hash returns the original URL without fetching", async () => {
    const fetchImpl: BlossomFetch = async () => {
      throw new Error("should not fetch");
    };
    expect(
      await healBlobUrl("https://cdn.example.com/photo.png", ["https://server.example"], {
        fetch: fetchImpl,
      }),
    ).toBe("https://cdn.example.com/photo.png");
  });

  test("original 302 stays original", async () => {
    const seen: string[] = [];
    const fetchImpl: BlossomFetch = async (input, init) => {
      seen.push(String(input));
      expect(init?.method).toBe("HEAD");
      expect(init?.redirect).toBe("manual");
      if (String(input) === originalPng) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://other.example/x" },
        });
      }
      throw new Error(`unexpected ${String(input)}`);
    };
    expect(await healBlobUrl(originalPng, ["https://server.example"], { fetch: fetchImpl })).toBe(
      originalPng,
    );
    expect(seen).toEqual([originalPng]);
  });

  test("original 200 stays original; HEAD is the URL as given, not with a trailing slash", async () => {
    const seen: string[] = [];
    const fetchImpl: BlossomFetch = async (input) => {
      seen.push(String(input));
      return new Response(null, { status: 200 });
    };
    expect(await healBlobUrl(originalPng, ["https://server.example"], { fetch: fetchImpl })).toBe(
      originalPng,
    );
    expect(seen).toEqual([originalPng]);
    expect(seen[0]?.endsWith("/")).toBe(false);
  });

  test("original 404 + server 200 returns https://server/<hash>.ext", async () => {
    const fetchImpl: BlossomFetch = async (input) => {
      const url = String(input);
      if (url === originalPng) return new Response(null, { status: 404 });
      if (url === `https://server.example/${HASH}.png`) return new Response(null, { status: 200 });
      throw new Error(`unexpected ${url}`);
    };
    expect(await healBlobUrl(originalPng, ["https://server.example"], { fetch: fetchImpl })).toBe(
      `https://server.example/${HASH}.png`,
    );
  });

  test("original 404 without extension returns https://server/<hash>", async () => {
    const fetchImpl: BlossomFetch = async (input) => {
      const url = String(input);
      if (url === originalBare) return new Response(null, { status: 404 });
      if (url === `https://server.example/${HASH}`) return new Response(null, { status: 200 });
      throw new Error(`unexpected ${url}`);
    };
    expect(await healBlobUrl(originalBare, ["https://server.example"], { fetch: fetchImpl })).toBe(
      `https://server.example/${HASH}`,
    );
  });

  test("server 500 then next 200", async () => {
    const fetchImpl: BlossomFetch = async (input) => {
      const url = String(input);
      if (url === originalPng) return new Response(null, { status: 404 });
      if (url === `https://a.example/${HASH}.png`) return new Response(null, { status: 500 });
      if (url === `https://b.example/${HASH}.png`) return new Response(null, { status: 200 });
      throw new Error(`unexpected ${url}`);
    };
    expect(
      await healBlobUrl(originalPng, ["https://a.example", "https://b.example"], {
        fetch: fetchImpl,
      }),
    ).toBe(`https://b.example/${HASH}.png`);
  });

  test("candidate 3xx is skipped; nothing hit returns original", async () => {
    const fetchImpl: BlossomFetch = async (input) => {
      const url = String(input);
      if (url === originalPng) return new Response(null, { status: 404 });
      if (url === `https://a.example/${HASH}.png`) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://other.example/x" },
        });
      }
      if (url === `https://b.example/${HASH}.png`) return new Response(null, { status: 404 });
      throw new Error(`unexpected ${url}`);
    };
    expect(
      await healBlobUrl(originalPng, ["https://a.example", "https://b.example"], {
        fetch: fetchImpl,
      }),
    ).toBe(originalPng);
  });

  test("original network error then server 200; invalid servers skipped", async () => {
    const fetchImpl: BlossomFetch = async (input) => {
      const url = String(input);
      if (url === originalPng) throw new TypeError("fetch failed");
      if (url === `https://cdn.example.com/v1/${HASH}.png`)
        return new Response(null, { status: 200 });
      throw new Error(`unexpected ${url}`);
    };
    expect(
      await healBlobUrl(originalPng, ["wss://not-http.example", "https://cdn.example.com/v1/"], {
        fetch: fetchImpl,
      }),
    ).toBe(`https://cdn.example.com/v1/${HASH}.png`);
  });

  test("AbortError on original HEAD propagates and does not probe servers", async () => {
    const aborted = abortError();
    const seen: string[] = [];
    const fetchImpl: BlossomFetch = async (input) => {
      seen.push(String(input));
      throw aborted;
    };
    await expect(
      healBlobUrl(originalPng, ["https://server.example"], { fetch: fetchImpl }),
    ).rejects.toBe(aborted);
    expect(seen).toEqual([originalPng]);
  });

  test("AbortError on a candidate HEAD aborts remaining servers", async () => {
    const aborted = abortError();
    const seen: string[] = [];
    const fetchImpl: BlossomFetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url === originalPng) return new Response(null, { status: 404 });
      throw aborted;
    };
    await expect(
      healBlobUrl(originalPng, ["https://a.example", "https://b.example"], { fetch: fetchImpl }),
    ).rejects.toBe(aborted);
    expect(seen).toEqual([originalPng, `https://a.example/${HASH}.png`]);
  });
});

describe("uploadToServers", () => {
  test("empty servers throws", async () => {
    const file = new Blob(["abc"]);
    const auth = await createUploadAuth(async (t) => signAuth(t), file);
    const fetchImpl: BlossomFetch = async () => {
      throw new Error("should not fetch");
    };
    await expect(uploadToServers([], file, auth, { fetch: fetchImpl })).rejects.toThrow(
      BlossomError,
    );
    await expect(uploadToServers([], file, auth, { fetch: fetchImpl })).rejects.toThrow(
      /no servers/,
    );
  });

  test("first success returns and does not PUT later servers", async () => {
    const file = new Blob(["abc"]);
    const auth = await createUploadAuth(async (t) => signAuth(t), file);
    const desc: BlobDescriptor = {
      url: `https://a.example/${ABC_SHA256}.txt`,
      sha256: ABC_SHA256,
      size: 3,
    };
    const seen: string[] = [];
    const fetchImpl: BlossomFetch = async (input) => {
      seen.push(String(input));
      return jsonResponse(desc, 201);
    };
    expect(
      await uploadToServers(["https://a.example", "https://b.example"], file, auth, {
        fetch: fetchImpl,
      }),
    ).toEqual(desc);
    expect(seen).toEqual(["https://a.example/upload"]);
  });

  test("first failure then next success", async () => {
    const file = new Blob(["abc"]);
    const auth = await createUploadAuth(async (t) => signAuth(t), file);
    const desc: BlobDescriptor = {
      url: `https://b.example/${ABC_SHA256}.txt`,
      sha256: ABC_SHA256,
      size: 3,
    };
    const seen: string[] = [];
    const fetchImpl: BlossomFetch = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https://a.example")) return jsonResponse({}, 500);
      return jsonResponse(desc, 201);
    };
    expect(
      await uploadToServers(["https://a.example", "https://b.example"], file, auth, {
        fetch: fetchImpl,
      }),
    ).toEqual(desc);
    expect(seen).toEqual(["https://a.example/upload", "https://b.example/upload"]);
  });

  test("all fail throws last BlossomError", async () => {
    const file = new Blob(["abc"]);
    const auth = await createUploadAuth(async (t) => signAuth(t), file);
    const fetchImpl: BlossomFetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://a.example")) return jsonResponse({}, 500);
      return jsonResponse({}, 503);
    };
    await expect(
      uploadToServers(["https://a.example", "https://b.example"], file, auth, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ name: "BlossomError", status: 503 });
  });

  test("AbortError aborts the loop", async () => {
    const file = new Blob(["abc"]);
    const auth = await createUploadAuth(async (t) => signAuth(t), file);
    const aborted = abortError();
    const seen: string[] = [];
    const fetchImpl: BlossomFetch = async (input) => {
      seen.push(String(input));
      throw aborted;
    };
    await expect(
      uploadToServers(["https://a.example", "https://b.example"], file, auth, { fetch: fetchImpl }),
    ).rejects.toBe(aborted);
    expect(seen).toEqual(["https://a.example/upload"]);
  });
});
