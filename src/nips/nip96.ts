/**
 * NIP-96: HTTP file storage (unrecommended; NIP-B7 preferred).
 * Authorization is a prebuilt NIP-98 header — this module does not import nip98.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/96.md
 */
import { NostrError } from "../core/error.ts";
import { fetchManual, requireGlobalFetch, type ManualFetch } from "./http.ts";

const WELL_KNOWN_PATH = "/.well-known/nostr/nip96.json";

export type Nip96Fetch = ManualFetch;

export type Nip96ServerInfo = {
  api_url: string;
  download_url?: string;
  delegated_to_url?: string;
  content_types?: string[];
};

export type Nip96UploadResult =
  | { status: "success"; url: string; tags: string[][] }
  | { status: "processing"; processingUrl: string; tags: string[][] };

export class Nip96Error extends NostrError {}

function serverInfoUrl(serviceUrl: string): string {
  return `${serviceUrl.replace(/\/+$/, "")}${WELL_KNOWN_PATH}`;
}

function errorMessageFromBody(json: unknown): string | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const message = (json as { message?: unknown }).message;
  if (typeof message !== "string") return undefined;
  const text = message.trim();
  return text || undefined;
}

/** Non-OK: prefer NIP-96 JSON `message`; never require a `url` tag. */
async function throwHttpError(
  prefix: string,
  res: Awaited<ReturnType<Nip96Fetch>>,
): Promise<never> {
  let detail: string | undefined;
  try {
    detail = errorMessageFromBody(await res.json());
  } catch {
    // body is optional on error
  }
  throw new Nip96Error(
    detail ? `${prefix} HTTP ${res.status}: ${detail}` : `${prefix} HTTP ${res.status}`,
  );
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

function parseStatus(value: unknown): "success" | "error" | "processing" | undefined {
  return value === "success" || value === "error" || value === "processing" ? value : undefined;
}

/**
 * Parse `{ status, processing_url, nip94_event.tags }`.
 * A `url` tag is required unless the response reports delayed processing
 * (`status: "processing"` or HTTP 202 with `processing_url`).
 */
export function parseNip96UploadResponse(json: unknown, httpStatus = 200): Nip96UploadResult {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Nip96Error("NIP-96 upload response must be a JSON object");
  }
  const raw = json as { nip94_event?: unknown; status?: unknown; processing_url?: unknown };
  const status = parseStatus(raw.status);
  const processingUrl =
    typeof raw.processing_url === "string" && raw.processing_url ? raw.processing_url : undefined;
  const event = raw.nip94_event;
  const rawTags =
    event && typeof event === "object" && !Array.isArray(event)
      ? (event as { tags?: unknown }).tags
      : undefined;

  const tags: string[][] = [];
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (!Array.isArray(tag) || tag.some((item) => typeof item !== "string")) {
        throw new Nip96Error("invalid nip94_event.tags");
      }
      tags.push([...tag]);
    }
  }

  const url = tags.find((tag) => tag[0] === "url")?.[1];
  if (url) {
    return { status: "success", url, tags };
  }
  if ((httpStatus === 202 || status === "processing") && processingUrl) {
    return { status: "processing", processingUrl, tags };
  }
  throw new Nip96Error("upload response without url");
}

async function fetchServerInfo(
  fetchImpl: Nip96Fetch,
  url: string,
  signal?: AbortSignal,
): Promise<Nip96ServerInfo> {
  const res = await fetchManual(
    fetchImpl,
    url,
    { signal },
    (cause) =>
      new Nip96Error(`NIP-96 server info request failed: ${url}`, {
        cause: cause instanceof Error ? cause : undefined,
      }),
  );
  if (!res.ok) {
    await throwHttpError("NIP-96 server info", res);
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

/** GET `${service}/.well-known/nostr/nip96.json`; follows `delegated_to_url` one hop. */
export async function fetchNip96Info(
  serviceUrl: string,
  opts?: { fetch?: Nip96Fetch; signal?: AbortSignal },
): Promise<Nip96ServerInfo> {
  const fetchImpl =
    opts?.fetch ??
    requireGlobalFetch(() => new Nip96Error("no fetch implementation available; pass opts.fetch"));

  const info = await fetchServerInfo(fetchImpl, serverInfoUrl(serviceUrl), opts?.signal);
  if (!info.delegated_to_url) return info;

  const delegated = await fetchServerInfo(
    fetchImpl,
    serverInfoUrl(info.delegated_to_url),
    opts?.signal,
  );
  if (delegated.delegated_to_url) {
    throw new Nip96Error("NIP-96 delegation exceeded one hop");
  }
  return delegated;
}

/** POST `apiUrl` as multipart `file`. `authorization` is a prebuilt NIP-98 header. */
export async function uploadNip96(
  apiUrl: string,
  file: Blob,
  authorization: string,
  opts?: { fetch?: Nip96Fetch; signal?: AbortSignal; extraFields?: Record<string, string> },
): Promise<Nip96UploadResult> {
  const fetchImpl =
    opts?.fetch ??
    requireGlobalFetch(() => new Nip96Error("no fetch implementation available; pass opts.fetch"));
  const body = new FormData();
  body.append("file", file);
  if (opts?.extraFields) {
    for (const [name, value] of Object.entries(opts.extraFields)) {
      body.append(name, value);
    }
  }

  const res = await fetchManual(
    fetchImpl,
    apiUrl,
    {
      method: "POST",
      headers: { Authorization: authorization },
      body,
      signal: opts?.signal,
    },
    (cause) =>
      new Nip96Error(`NIP-96 upload request failed: ${apiUrl}`, {
        cause: cause instanceof Error ? cause : undefined,
      }),
  );
  if (!res.ok) {
    await throwHttpError("NIP-96 upload", res);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (cause) {
    throw new Nip96Error("invalid NIP-96 upload response JSON", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  return parseNip96UploadResponse(json, res.status);
}
