/**
 * NIP-11: Relay Information Document
 * @see https://github.com/nostr-protocol/nips/blob/master/11.md
 */
import { NostrError } from "../core/error.ts";

const ACCEPT = "application/nostr+json";

const STRING_FIELDS = [
  "name",
  "description",
  "banner",
  "icon",
  "pubkey",
  "self",
  "contact",
  "software",
  "version",
  "payments_url",
] as const;

const LIMITATION_NUMBERS = [
  "max_message_length",
  "max_subscriptions",
  "max_filters",
  "max_limit",
  "min_pow_difficulty",
  "created_at_lower_limit",
  "created_at_upper_limit",
] as const;

const LIMITATION_BOOLEANS = ["auth_required", "payment_required", "restricted_writes"] as const;

/**
 * Minimal fetch surface used by NIP-11.
 * Callers should use `redirect: "manual"` / no-follow semantics.
 */
export type Nip11Fetch = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: "manual" | "error" | "follow";
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type RelayInformation = {
  name?: string;
  description?: string;
  banner?: string;
  icon?: string;
  pubkey?: string;
  self?: string;
  contact?: string;
  supported_nips?: number[];
  software?: string;
  version?: string;
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
    min_pow_difficulty?: number;
    created_at_lower_limit?: number;
    created_at_upper_limit?: number;
  };
  payments_url?: string;
  tags?: string[];
};

export class Nip11Error extends NostrError {}

/** Convert a relay websocket URL to the HTTP URL that serves the NIP-11 document. */
export function relayInfoHttpUrl(wsUrl: string): string {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch (cause) {
    throw new Nip11Error(`invalid relay URL: ${wsUrl}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }

  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Nip11Error(`unsupported relay URL scheme: ${url.protocol}`);
  }

  return url.toString();
}

function defaultFetch(): Nip11Fetch {
  if (typeof globalThis.fetch !== "function") {
    throw new Nip11Error("no fetch implementation available; pass opts.fetch");
  }
  return globalThis.fetch.bind(globalThis) as Nip11Fetch;
}

function parseRelayInformation(json: unknown): RelayInformation {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Nip11Error("relay information document must be a JSON object");
  }
  const raw = json as Record<string, unknown>;
  const info: RelayInformation = {};

  for (const key of STRING_FIELDS) {
    const value = raw[key];
    if (typeof value === "string") info[key] = value;
  }

  if (Array.isArray(raw.supported_nips)) {
    info.supported_nips = raw.supported_nips.filter(
      (n): n is number => typeof n === "number" && Number.isFinite(n),
    );
  }

  if (Array.isArray(raw.tags)) {
    info.tags = raw.tags.filter((t): t is string => typeof t === "string");
  }

  if (raw.limitation && typeof raw.limitation === "object" && !Array.isArray(raw.limitation)) {
    const rawLim = raw.limitation as Record<string, unknown>;
    const limitation: NonNullable<RelayInformation["limitation"]> = {};
    for (const key of LIMITATION_NUMBERS) {
      const value = rawLim[key];
      if (typeof value === "number" && Number.isFinite(value)) limitation[key] = value;
    }
    for (const key of LIMITATION_BOOLEANS) {
      const value = rawLim[key];
      if (typeof value === "boolean") limitation[key] = value;
    }
    if (Object.keys(limitation).length > 0) info.limitation = limitation;
  }

  return info;
}

export async function fetchRelayInformation(
  wsUrl: string,
  opts?: { fetch?: Nip11Fetch; signal?: AbortSignal },
): Promise<RelayInformation> {
  const httpUrl = relayInfoHttpUrl(wsUrl);
  const fetchImpl = opts?.fetch ?? defaultFetch();

  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await fetchImpl(httpUrl, {
      headers: { Accept: ACCEPT },
      signal: opts?.signal,
      redirect: "manual",
    });
  } catch (cause) {
    throw new Nip11Error(`relay information request failed: ${httpUrl}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }

  if (!res.ok) {
    throw new Nip11Error(`relay information request failed: HTTP ${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (cause) {
    throw new Nip11Error("relay information document is not valid JSON", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }

  return parseRelayInformation(json);
}
