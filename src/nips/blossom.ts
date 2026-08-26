/**
 * Blossom BUD-01/02/04/06 HTTP helpers, NIP-B7 kind 10063 server lists, and URL healing.
 * Auth is kind 24242, not NIP-98; the Authorization value is base64url.
 *
 * @see https://github.com/hzrd149/blossom
 * @see https://github.com/nostr-protocol/nips/blob/master/B7.md
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import { EventBuilder } from "../core/builder.ts";
import { EventValidationError, NostrError } from "../core/error.ts";
import type { Event, EventTemplate } from "../core/event.ts";
import { Kind } from "../core/kind.ts";
import type { Tag } from "../core/tag.ts";
import { assertHex32, bytesToHex, utf8Encoder } from "../core/util.ts";
import { fetchManual, requireGlobalFetch, sendManual, type ManualFetch } from "./http.ts";

export type BlobDescriptor = {
  url: string;
  sha256: string;
  size: number;
  type?: string;
  uploaded?: number;
};

export type BlossomFetch = ManualFetch;

/** Signs a kind 24242 auth template (draft; pubkey is filled by the signer). */
export type BlossomSign = (template: EventTemplate) => Promise<Event>;

/** BUD-11 `t` verbs. Mirror reuses `upload`; there is no `t=mirror`. */
export type BlossomAuthVerb = "upload" | "delete" | "list" | "get" | "media";

const AUTH_VERBS = new Set<BlossomAuthVerb>(["upload", "delete", "list", "get", "media"]);

/** Default BUD-11 expiration: now + 1h. Servers 401 when the tag is missing. */
const AUTH_EXPIRATION_SECS = 3600;

export class BlossomError extends NostrError {
  readonly status?: number;

  constructor(message: string, options?: ErrorOptions & { status?: number }) {
    const { status, ...rest } = options ?? {};
    super(message, rest);
    this.status = status;
  }
}

/** Last 64-char hex in the URL path (extension ignored). Null if none or the URL is invalid. */
export function getHashFromURL(url: string | URL): string | null {
  let path: string;
  try {
    path = (url instanceof URL ? url : new URL(url)).pathname;
  } catch {
    return null;
  }
  const matches = path.match(/[0-9a-f]{64}/gi);
  if (!matches?.length) return null;
  return matches[matches.length - 1]!.toLowerCase();
}

export async function sha256Blob(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = new Uint8Array(await data.arrayBuffer());
  }
  return bytesToHex(sha256(bytes));
}

/** True when `sha256Blob(data)` equals the expected hex (any case). */
export async function verifyBlob(
  data: Blob | ArrayBuffer | Uint8Array,
  sha256Hex: string,
): Promise<boolean> {
  const expected = assertHex32(sha256Hex, "blob sha256");
  return (await sha256Blob(data)) === expected;
}

/**
 * `Nostr ` + base64url(utf8 JSON), padding stripped.
 * NIP-98 uses standard base64; mixing them is a 401.
 */
export function encodeAuthorizationHeader(event: Event): string {
  return `Nostr ${base64urlnopad.encode(utf8Encoder.encode(JSON.stringify(event)))}`;
}

export function createAuthTemplate(
  verb: BlossomAuthVerb,
  opts?: { sha256?: string; expiration?: number; message?: string },
): EventTemplate {
  if (!AUTH_VERBS.has(verb)) {
    throw new BlossomError(`invalid blossom auth verb: ${verb}`);
  }
  const expiration = opts?.expiration ?? Math.floor(Date.now() / 1000) + AUTH_EXPIRATION_SECS;
  const tags: Tag[] = [
    ["t", verb],
    ["expiration", String(expiration)],
  ];
  if (opts?.sha256 !== undefined) {
    tags.push(["x", assertHex32(opts.sha256, "blob sha256")]);
  }
  return {
    kind: Kind.BlobsAuth,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: opts?.message ?? "",
  };
}

export async function createUploadAuth(
  sign: BlossomSign,
  file: Blob,
  opts?: { message?: string; expiration?: number },
): Promise<Event> {
  const hash = await sha256Blob(file);
  return sign(createAuthTemplate("upload", { sha256: hash, ...opts }));
}

export async function upload(
  server: string,
  file: Blob,
  auth: Event,
  opts?: { fetch?: BlossomFetch; signal?: AbortSignal },
): Promise<BlobDescriptor> {
  const hash = await sha256Blob(file);
  const headers: Record<string, string> = {
    Authorization: encodeAuthorizationHeader(auth),
    "X-SHA-256": hash,
  };
  if (file.type) headers["Content-Type"] = file.type;
  const res = await blossomRequest(opts?.fetch, blossomUrl(server, "/upload"), {
    method: "PUT",
    headers,
    body: file,
    signal: opts?.signal,
  });
  return requireDescriptorHash(parseBlobDescriptor(await readJson(res)), hash);
}

export async function listBlobs(
  server: string,
  pubkey: string,
  auth: Event | undefined,
  opts?: { fetch?: BlossomFetch; signal?: AbortSignal },
): Promise<BlobDescriptor[]> {
  const pk = assertHex32(pubkey, "pubkey");
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = encodeAuthorizationHeader(auth);
  const res = await blossomRequest(opts?.fetch, blossomUrl(server, `/list/${pk}`), {
    method: "GET",
    headers,
    signal: opts?.signal,
  });
  const json = await readJson(res);
  if (!Array.isArray(json)) {
    throw new BlossomError("blossom list response must be a JSON array", { status: res.status });
  }
  return json.map(parseBlobDescriptor);
}

export async function deleteBlob(
  server: string,
  sha256Hex: string,
  auth: Event,
  opts?: { fetch?: BlossomFetch; signal?: AbortSignal },
): Promise<void> {
  const hash = assertHex32(sha256Hex, "blob sha256");
  await blossomRequest(opts?.fetch, blossomUrl(server, `/${hash}`), {
    method: "DELETE",
    headers: { Authorization: encodeAuthorizationHeader(auth) },
    signal: opts?.signal,
  });
}

export async function mirrorBlob(
  server: string,
  blob: BlobDescriptor,
  opts: { auth: Event; fetch?: BlossomFetch; signal?: AbortSignal },
): Promise<BlobDescriptor> {
  const hash = assertHex32(blob.sha256, "blob sha256");
  const headers: Record<string, string> = {
    Authorization: encodeAuthorizationHeader(opts.auth),
    "Content-Type": "application/json",
    "X-SHA-256": hash,
    "X-Content-Length": String(blob.size),
  };
  if (blob.type) headers["X-Content-Type"] = blob.type;
  const res = await blossomRequest(opts.fetch, blossomUrl(server, "/mirror"), {
    method: "PUT",
    headers,
    body: JSON.stringify({ url: blob.url }),
    signal: opts.signal,
  });
  return requireDescriptorHash(parseBlobDescriptor(await readJson(res)), hash);
}

/** BUD-06 preflight. Does not PUT the body. */
export async function checkUpload(
  server: string,
  file: Blob,
  auth: Event,
  opts?: { fetch?: BlossomFetch; signal?: AbortSignal },
): Promise<void> {
  const hash = await sha256Blob(file);
  const headers: Record<string, string> = {
    Authorization: encodeAuthorizationHeader(auth),
    "X-SHA-256": hash,
    "X-Content-Length": String(file.size),
  };
  if (file.type) headers["X-Content-Type"] = file.type;
  await blossomRequest(opts?.fetch, blossomUrl(server, "/upload"), {
    method: "HEAD",
    headers,
    signal: opts?.signal,
  });
}

/** Strict HEAD probe. 2xx → true. 404 → false. Other HTTP (including 405) / network → throw BlossomError. AbortError propagates. No GET fallback. */
export async function blobExists(
  server: string,
  sha256Hex: string,
  opts?: { fetch?: BlossomFetch; signal?: AbortSignal },
): Promise<boolean> {
  const hash = assertHex32(sha256Hex, "blob sha256");
  const url = blossomUrl(server, `/${hash}`);
  const res = await blossomFetch(opts?.fetch, url, { method: "HEAD", signal: opts?.signal });
  if (res.status === 404) return false;
  if (res.ok) return true;
  throw blossomHttpError("HEAD", url, res);
}

/** GET body, then verifyBlob. Non-2xx or sha256 mismatch → throw BlossomError. */
export async function getBlob(
  server: string,
  sha256Hex: string,
  opts?: { fetch?: BlossomFetch; signal?: AbortSignal },
): Promise<Uint8Array> {
  const hash = assertHex32(sha256Hex, "blob sha256");
  const url = blossomUrl(server, `/${hash}`);
  const res = await blossomFetch(opts?.fetch, url, { method: "GET", signal: opts?.signal });
  if (!res.ok) throw blossomHttpError("GET", url, res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!(await verifyBlob(bytes, hash))) {
    throw new BlossomError("blob sha256 mismatch");
  }
  return bytes;
}

/**
 * If `url` is not available, try `servers` for the same hash (NIP-B7 SHOULD).
 * Never throws on HTTP status. AbortError still throws.
 * Returns the original URL when no hash, original still available, or nothing else responds.
 */
export async function healBlobUrl(
  url: string,
  servers: readonly string[],
  opts?: { fetch?: BlossomFetch; signal?: AbortSignal },
): Promise<string> {
  const hash = getHashFromURL(url);
  if (!hash) return url;

  const ext = extensionFromHashUrl(url, hash);
  const fetchImpl = opts?.fetch ?? requireGlobalFetch(missingBlossomFetch);

  const originalStatus = await headStatus(fetchImpl, url, opts?.signal);
  // 2xx/3xx: still available. NIP-B7 only heals URLs that are not.
  if (originalStatus !== undefined && originalStatus >= 200 && originalStatus < 400) {
    return url;
  }

  for (const server of servers) {
    const base = parseHttpUrl(server);
    if (!base) continue;
    const candidate = `${base}/${hash}${ext}`;
    const status = await headStatus(fetchImpl, candidate, opts?.signal);
    if (status !== undefined && status >= 200 && status < 300) return candidate;
  }
  return url;
}

/** PUT /upload to each server in order until one descriptor succeeds. */
export async function uploadToServers(
  servers: readonly string[],
  file: Blob,
  auth: Event,
  opts?: { fetch?: BlossomFetch; signal?: AbortSignal },
): Promise<BlobDescriptor> {
  if (servers.length === 0) {
    throw new BlossomError("no servers");
  }
  let last: BlossomError | undefined;
  for (const server of servers) {
    try {
      return await upload(server, file, auth, opts);
    } catch (err) {
      if (isAbortError(err)) throw err;
      last =
        err instanceof BlossomError
          ? err
          : new BlossomError("blossom upload failed", {
              cause: err instanceof Error ? err : undefined,
            });
    }
  }
  throw last ?? new BlossomError("no servers");
}

export function blossomServerListEventBuilder(servers: readonly string[]): EventBuilder {
  const tags: Tag[] = [];
  const seen = new Set<string>();
  for (const raw of servers) {
    const url = parseHttpUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    tags.push(["server", url]);
  }
  return new EventBuilder(Kind.BlossomServerList, "").tags(tags);
}

export function parseBlossomServerList(event: Pick<Event, "kind" | "tags">): string[] {
  if (event.kind !== Kind.BlossomServerList) {
    throw new EventValidationError(`expected kind ${Kind.BlossomServerList}, got ${event.kind}`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "server" || !tag[1]) continue;
    const url = parseHttpUrl(tag[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function parseHttpUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.origin}${path}`;
  } catch {
    return undefined;
  }
}

/** Join `/upload` etc. onto the stored server, keeping a path prefix (`/v1/upload`). */
function blossomUrl(server: string, path: string): string {
  const base = parseHttpUrl(server);
  if (!base) {
    throw new BlossomError(`invalid blossom server URL: ${server}`);
  }
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Path suffix after the last 64-hex segment (`HASH.png` → `.png`). */
function extensionFromHashUrl(url: string, hash: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }
  const i = pathname.toLowerCase().lastIndexOf(hash);
  if (i < 0) return "";
  const m = pathname.slice(i + 64).match(/^\.[^/]+/);
  return m?.[0] ?? "";
}

function missingBlossomFetch(): BlossomError {
  return new BlossomError("no fetch implementation available; pass opts.fetch");
}

type ManualResponse = Awaited<ReturnType<ManualFetch>>;

function blossomHttpError(method: string, url: string, res: ManualResponse): BlossomError {
  let reason: string | undefined;
  try {
    reason = res.headers.get("x-reason") ?? undefined;
  } catch {
    reason = undefined;
  }
  return new BlossomError(reason?.trim() || `blossom ${method} ${url} failed (${res.status})`, {
    status: res.status,
  });
}

async function blossomFetch(
  fetchImpl: BlossomFetch | undefined,
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: Blob | string | null;
    signal?: AbortSignal;
  },
): Promise<ManualResponse> {
  return fetchManual(
    fetchImpl ?? requireGlobalFetch(missingBlossomFetch),
    url,
    init,
    (err) =>
      new BlossomError(`blossom ${init.method} ${url} failed`, {
        cause: err instanceof Error ? err : undefined,
      }),
  );
}

/** HEAD with redirect:manual. Network → undefined. AbortError propagates. Never throws on HTTP status. */
async function headStatus(
  fetchImpl: ManualFetch,
  url: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const res = await sendManual(fetchImpl, url, { method: "HEAD", signal });
    return res.status;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return undefined;
  }
}

async function blossomRequest(
  fetchImpl: BlossomFetch | undefined,
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: Blob | string | null;
    signal?: AbortSignal;
  },
): Promise<ManualResponse> {
  const res = await blossomFetch(fetchImpl, url, init);
  if (res.ok) return res;
  throw blossomHttpError(init.method, url, res);
}

async function readJson(res: ManualResponse): Promise<unknown> {
  try {
    return await res.json();
  } catch (cause) {
    throw new BlossomError("invalid blossom JSON response", {
      cause: cause instanceof Error ? cause : undefined,
      status: res.status,
    });
  }
}

function parseBlobDescriptor(json: unknown): BlobDescriptor {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new BlossomError("invalid blob descriptor");
  }
  const raw = json as Record<string, unknown>;
  if (typeof raw.url !== "string" || !raw.url) {
    throw new BlossomError("blob descriptor missing url");
  }
  if (typeof raw.sha256 !== "string") {
    throw new BlossomError("blob descriptor missing sha256");
  }
  const hash = assertHex32(raw.sha256, "blob sha256");
  if (typeof raw.size !== "number" || !Number.isInteger(raw.size) || raw.size < 0) {
    throw new BlossomError("blob descriptor missing size");
  }
  const desc: BlobDescriptor = { url: raw.url, sha256: hash, size: raw.size };
  if (typeof raw.type === "string") desc.type = raw.type;
  if (typeof raw.uploaded === "number" && Number.isInteger(raw.uploaded) && raw.uploaded >= 0) {
    desc.uploaded = raw.uploaded;
  }
  return desc;
}

function requireDescriptorHash(desc: BlobDescriptor, expected: string): BlobDescriptor {
  if (desc.sha256 !== expected) {
    throw new BlossomError("blob descriptor sha256 mismatch");
  }
  return desc;
}
