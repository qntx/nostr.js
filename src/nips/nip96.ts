/**
 * NIP-96: HTTP file storage (unrecommended; NIP-B7 preferred).
 * Authorization is a prebuilt NIP-98 header — this module does not import nip98.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/96.md
 */
import { NostrError } from "../core/error.ts";

const WELL_KNOWN_PATH = "/.well-known/nostr/nip96.json";

/**
 * Minimal fetch surface (NIP-11-shaped).
 * Callers must use `redirect: "manual"` / no-follow semantics.
 */
export type Nip96Fetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Blob | FormData;
    signal?: AbortSignal;
    redirect?: "manual" | "error" | "follow";
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type Nip96ServerInfo = {
  api_url: string;
  download_url?: string;
  delegated_to_url?: string;
  content_types?: string[];
};

export type Nip96UploadResult = {
  url: string;
  tags: string[][];
};

export class Nip96Error extends NostrError {}

function defaultFetch(): Nip96Fetch {
  if (typeof globalThis.fetch !== "function") {
    throw new Nip96Error("no fetch implementation available; pass opts.fetch");
  }
  return globalThis.fetch.bind(globalThis) as Nip96Fetch;
}

function serverInfoUrl(serviceUrl: string): string {
  return `${serviceUrl.replace(/\/+$/, "")}${WELL_KNOWN_PATH}`;
}

function parseNip96ServerInfo(json: unknown): Nip96ServerInfo {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Nip96Error("NIP-96 server info must be a JSON object");
  }
  const raw = json as Record<string, unknown>;
  if (typeof raw.api_url !== "string") {
    throw new Nip96Error("missing api_url");
  }

  const info: Nip96ServerInfo = { api_url: raw.api_url };
  if (typeof raw.download_url === "string") info.download_url = raw.download_url;
  if (typeof raw.delegated_to_url === "string") info.delegated_to_url = raw.delegated_to_url;
  if (Array.isArray(raw.content_types) && raw.content_types.every((t) => typeof t === "string")) {
    info.content_types = [...raw.content_types];
  }
  return info;
}

/** Parse `{ status, nip94_event.tags }` and require a `url` tag. */
export function parseNip96UploadResponse(json: unknown): Nip96UploadResult {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Nip96Error("NIP-96 upload response must be a JSON object");
  }
  const event = (json as { nip94_event?: unknown }).nip94_event;
  const rawTags =
    event && typeof event === "object" && !Array.isArray(event)
      ? (event as { tags?: unknown }).tags
      : undefined;
  if (!Array.isArray(rawTags)) {
    throw new Nip96Error("upload response without url");
  }

  const tags: string[][] = [];
  for (const tag of rawTags) {
    if (!Array.isArray(tag) || tag.some((item) => typeof item !== "string")) {
      throw new Nip96Error("invalid nip94_event.tags");
    }
    tags.push([...tag]);
  }

  const url = tags.find((tag) => tag[0] === "url")?.[1];
  if (!url) {
    throw new Nip96Error("upload response without url");
  }
  return { url, tags };
}

/** GET `${service}/.well-known/nostr/nip96.json` with `redirect: "manual"`. */
export async function fetchNip96Info(
  serviceUrl: string,
  opts?: { fetch?: Nip96Fetch; signal?: AbortSignal },
): Promise<Nip96ServerInfo> {
  const url = serverInfoUrl(serviceUrl);
  const fetchImpl = opts?.fetch ?? defaultFetch();

  let res: Awaited<ReturnType<Nip96Fetch>>;
  try {
    res = await fetchImpl(url, {
      signal: opts?.signal,
      redirect: "manual",
    });
  } catch (cause) {
    throw new Nip96Error(`NIP-96 server info request failed: ${url}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (!res.ok) {
    throw new Nip96Error(`NIP-96 server info HTTP ${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (cause) {
    throw new Nip96Error("invalid NIP-96 server info JSON", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  return parseNip96ServerInfo(json);
}

/** POST `apiUrl` as multipart `file`. `authorization` is a prebuilt NIP-98 header. */
export async function uploadNip96(
  apiUrl: string,
  file: Blob,
  authorization: string,
  opts?: { fetch?: Nip96Fetch; signal?: AbortSignal; extraFields?: Record<string, string> },
): Promise<Nip96UploadResult> {
  const fetchImpl = opts?.fetch ?? defaultFetch();
  const body = new FormData();
  body.append("file", file);
  if (opts?.extraFields) {
    for (const [name, value] of Object.entries(opts.extraFields)) {
      body.append(name, value);
    }
  }

  let res: Awaited<ReturnType<Nip96Fetch>>;
  try {
    res = await fetchImpl(apiUrl, {
      method: "POST",
      headers: { Authorization: authorization },
      body,
      signal: opts?.signal,
      redirect: "manual",
    });
  } catch (cause) {
    throw new Nip96Error(`NIP-96 upload request failed: ${apiUrl}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (!res.ok) {
    throw new Nip96Error(`NIP-96 upload HTTP ${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (cause) {
    throw new Nip96Error("invalid NIP-96 upload response JSON", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  return parseNip96UploadResponse(json);
}
