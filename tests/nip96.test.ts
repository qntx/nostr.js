import { describe, expect, test } from "vite-plus/test";
import {
  Nip96Error,
  fetchNip96Info,
  parseNip96UploadResponse,
  uploadNip96,
  type Nip96Fetch,
} from "../src/index.ts";

const SERVICE = "https://files.example";
const INFO_URL = "https://files.example/.well-known/nostr/nip96.json";
const API_URL = "https://files.example/upload";
const FILE_URL = "https://cdn.example/719171db.png";
const OX = "719171db19525d9d08dd69cb716a18158a249b7b3b3ec4bbdec5698dca104b7b";

const SUCCESS_BODY = {
  status: "success",
  message: "Upload successful.",
  nip94_event: {
    tags: [
      ["url", FILE_URL],
      ["ox", OX],
      ["m", "image/png"],
    ],
    content: "",
  },
};

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<Nip96Fetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function redirectOf(init: unknown): string | undefined {
  if (!init || typeof init !== "object" || !("redirect" in init)) return undefined;
  const value = (init as { redirect?: unknown }).redirect;
  return typeof value === "string" ? value : undefined;
}

describe("nip96 server info", () => {
  test("fetches well-known JSON and ignores extra fields", async () => {
    const calls: { url: string; init?: Parameters<Nip96Fetch>[1] }[] = [];
    const fetchImpl: Nip96Fetch = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        api_url: API_URL,
        download_url: "https://cdn.example",
        delegated_to_url: "https://other.example",
        content_types: ["image/jpeg", "video/webm"],
        supported_nips: [60],
        plans: { free: { name: "Free" } },
      });
    };

    const info = await fetchNip96Info(`${SERVICE}/`, { fetch: fetchImpl });
    expect(info).toEqual({
      api_url: API_URL,
      download_url: "https://cdn.example",
      delegated_to_url: "https://other.example",
      content_types: ["image/jpeg", "video/webm"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(INFO_URL);
    expect(calls[0]?.init?.signal).toBeUndefined();
    expect(redirectOf(calls[0]?.init)).toBe("manual");
  });

  test("network TypeError wraps Nip96Error", async () => {
    const net = new TypeError("fetch failed");
    const fetchImpl: Nip96Fetch = async () => {
      throw net;
    };
    try {
      await fetchNip96Info(SERVICE, { fetch: fetchImpl });
      throw new Error("expected reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Nip96Error);
      expect((err as Nip96Error).cause).toBe(net);
      expect(err).not.toBe(net);
    }
  });

  test("AbortError is not wrapped into Nip96Error", async () => {
    const aborted = abortError();
    const fetchImpl: Nip96Fetch = async () => {
      throw aborted;
    };
    await expect(fetchNip96Info(SERVICE, { fetch: fetchImpl })).rejects.toBe(aborted);
  });

  test("missing api_url throws", async () => {
    const fetchImpl: Nip96Fetch = async () =>
      jsonResponse(200, { download_url: "https://cdn.example" });
    await expect(fetchNip96Info(SERVICE, { fetch: fetchImpl })).rejects.toThrow(Nip96Error);
    await expect(fetchNip96Info(SERVICE, { fetch: fetchImpl })).rejects.toThrow(/missing api_url/);
  });

  test("non-OK including redirects throws", async () => {
    const fetchImpl: Nip96Fetch = async () => jsonResponse(302, { api_url: API_URL });
    await expect(fetchNip96Info(SERVICE, { fetch: fetchImpl })).rejects.toThrow(Nip96Error);
  });

  test("empty api_url is valid for delegated documents", async () => {
    const fetchImpl: Nip96Fetch = async () =>
      jsonResponse(200, { api_url: "", delegated_to_url: "https://other.example" });
    await expect(fetchNip96Info(SERVICE, { fetch: fetchImpl })).resolves.toEqual({
      api_url: "",
      delegated_to_url: "https://other.example",
    });
  });

  test("non-OK info includes JSON message", async () => {
    const fetchImpl: Nip96Fetch = async () =>
      jsonResponse(404, { status: "error", message: "not found" });
    await expect(fetchNip96Info(SERVICE, { fetch: fetchImpl })).rejects.toThrow(
      /^NIP-96 server info HTTP 404: not found$/,
    );
  });
});

describe("nip96 upload parse", () => {
  test("parseNip96UploadResponse reads url tag and tags", () => {
    expect(parseNip96UploadResponse(SUCCESS_BODY)).toEqual({
      url: FILE_URL,
      tags: [
        ["url", FILE_URL],
        ["ox", OX],
        ["m", "image/png"],
      ],
    });
  });

  test("upload response without url throws", () => {
    expect(() => parseNip96UploadResponse({ status: "success" })).toThrow(Nip96Error);
    expect(() => parseNip96UploadResponse({ status: "error", message: "nope" })).toThrow(
      /upload response without url/,
    );
    expect(() =>
      parseNip96UploadResponse({ status: "success", nip94_event: { tags: [["ox", OX]] } }),
    ).toThrow(/upload response without url/);
    expect(() =>
      parseNip96UploadResponse({ status: "success", nip94_event: { tags: [["url", ""]] } }),
    ).toThrow(/upload response without url/);
  });

  test("uploadNip96 posts multipart file with authorization and extra fields", async () => {
    const calls: { url: string; init?: Parameters<Nip96Fetch>[1] }[] = [];
    const fetchImpl: Nip96Fetch = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(201, SUCCESS_BODY);
    };
    const file = new Blob(["hello"], { type: "text/plain" });
    const result = await uploadNip96(API_URL, file, "Nostr tok", {
      fetch: fetchImpl,
      extraFields: { caption: "hi", no_transform: "true" },
    });

    expect(result.url).toBe(FILE_URL);
    expect(result.tags[0]).toEqual(["url", FILE_URL]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(API_URL);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(redirectOf(calls[0]?.init)).toBe("manual");
    expect(calls[0]?.init?.headers).toEqual({ Authorization: "Nostr tok" });
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
    const body = calls[0]?.init?.body as FormData;
    expect(body.get("caption")).toBe("hi");
    expect(body.get("no_transform")).toBe("true");
    expect(body.get("file")).toBeInstanceOf(Blob);
  });

  test("uploadNip96 without url tag throws", async () => {
    const fetchImpl: Nip96Fetch = async () =>
      jsonResponse(200, { status: "success", nip94_event: { tags: [] } });
    await expect(
      uploadNip96(API_URL, new Blob(["x"]), "Nostr tok", { fetch: fetchImpl }),
    ).rejects.toThrow(/upload response without url/);
  });

  test("non-OK upload includes JSON message and does not require url", async () => {
    const fetchImpl: Nip96Fetch = async () =>
      jsonResponse(403, { status: "error", message: "User is not allowed to upload" });
    await expect(
      uploadNip96(API_URL, new Blob(["x"]), "Nostr tok", { fetch: fetchImpl }),
    ).rejects.toThrow(/^NIP-96 upload HTTP 403: User is not allowed to upload$/);
  });

  test("upload network TypeError wraps Nip96Error", async () => {
    const net = new TypeError("fetch failed");
    const fetchImpl: Nip96Fetch = async () => {
      throw net;
    };
    try {
      await uploadNip96(API_URL, new Blob(["x"]), "Nostr tok", { fetch: fetchImpl });
      throw new Error("expected reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Nip96Error);
      expect((err as Nip96Error).cause).toBe(net);
      expect(err).not.toBe(net);
    }
  });

  test("upload AbortError is not wrapped into Nip96Error", async () => {
    const aborted = abortError();
    const fetchImpl: Nip96Fetch = async () => {
      throw aborted;
    };
    await expect(
      uploadNip96(API_URL, new Blob(["x"]), "Nostr tok", { fetch: fetchImpl }),
    ).rejects.toBe(aborted);
  });

  test("non-OK upload without message falls back to status", async () => {
    const fetchImpl: Nip96Fetch = async () => jsonResponse(413, { status: "error" });
    await expect(
      uploadNip96(API_URL, new Blob(["x"]), "Nostr tok", { fetch: fetchImpl }),
    ).rejects.toThrow(/^NIP-96 upload HTTP 413$/);
  });
});
