/**
 * NIP-05: Mapping Nostr keys to DNS-based internet identifiers
 * @see https://github.com/nostr-protocol/nips/blob/master/05.md
 */
import { NostrError } from "../core/error.ts";
import { isHex32 } from "../core/util.ts";
import type { ProfilePointer } from "./nip19.ts";

/** Root local-part (`_@domain` rendered as just the domain). */
export const NIP05_ROOT_LOCAL = "_";

export const WELL_KNOWN_PATH = "/.well-known/nostr.json";

/**
 * NIP-05 identifier string.
 * - Full: `name@domain`
 * - Root: `domain` or `_@domain`
 */
export type Nip05 = string;

export type Nip05Address = {
  /** Local part (lowercased). `_` for domain-only identifiers. */
  local: string;
  /** Domain (lowercased). */
  domain: string;
};

/**
 * nostr.json `nip46` object. One structural type: mixed documents may set both
 * the jumble/nostr-tools pubkey map and the current 46.md `{relays, nostrconnect_url}`.
 */
export type Nip05Nip46 = {
  /** nostr-tools / jumble: hex pubkey → bunker relays */
  relaysByPubkey?: Record<string, string[]>;
  /** current 46.md appendix */
  relays?: string[];
  nostrconnectUrl?: string;
};

export type Nip05Document = {
  names: Record<string, string>;
  /** NIP-05 profile hints — never used as bunker relays */
  relays?: Record<string, string[]>;
  nip46?: Nip05Nip46;
};

/**
 * Minimal fetch surface used by NIP-05.
 * Callers should use `redirect: "manual"` / no-follow semantics.
 */
export type Nip05Fetch = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: "manual" | "error" | "follow" },
) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export class Nip05Error extends NostrError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Matches optional local@domain.
 * Groups: 1=local (optional), 2=domain.
 */
export const NIP05_REGEX = /^(?:([\w.+-]+)@)?([\w-]+(?:\.[\w-]+)+)$/;

export function isNip05(value: unknown): value is string {
  return typeof value === "string" && NIP05_REGEX.test(value);
}

/**
 * Parse an identifier into local + domain.
 * Accepts `name@domain`, `_@domain`, or bare `domain` (local becomes `_`).
 */
export function parseNip05(input: string): Nip05Address {
  const match = input.trim().match(NIP05_REGEX);
  if (!match?.[2]) {
    throw new Nip05Error(`invalid NIP-05 identifier: ${input}`);
  }
  const localRaw = match[1] ?? NIP05_ROOT_LOCAL;
  const local = localRaw.toLowerCase();
  const domain = match[2].toLowerCase();

  // NIP-05 local-part: a-z0-9-_.
  if (!/^[a-z0-9._-]+$/.test(local)) {
    throw new Nip05Error(`invalid NIP-05 local-part: ${localRaw}`);
  }
  if (!domain) {
    throw new Nip05Error("NIP-05 domain must not be empty");
  }

  return { local, domain };
}

/** Build the well-known HTTPS URL for an address. */
export function wellKnownUrl(address: Nip05Address): string {
  const url = new URL(`https://${address.domain}${WELL_KNOWN_PATH}`);
  url.searchParams.set("name", address.local);
  return url.toString();
}

function stringUrls(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.filter((u): u is string => typeof u === "string" && u.length > 0);
}

/**
 * Parse nostr.json `nip46`: spec `{relays, nostrconnect_url}` plus jumble hex-pubkey maps.
 * Hex-64 keys are never confused with `relays` (not 64 hex chars).
 */
export function parseNip05Nip46(raw: unknown): Nip05Nip46 | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: Nip05Nip46 = {};

  if (Array.isArray(obj.relays)) {
    result.relays = stringUrls(obj.relays) ?? [];
  }

  if (typeof obj.nostrconnect_url === "string" && obj.nostrconnect_url.length > 0) {
    result.nostrconnectUrl = obj.nostrconnect_url;
  }

  const relaysByPubkey: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "relays" || k === "nostrconnect_url") continue;
    if (!isHex32(k)) continue;
    const urls = stringUrls(v);
    if (urls?.length) relaysByPubkey[k.toLowerCase()] = urls;
  }
  if (Object.keys(relaysByPubkey).length) result.relaysByPubkey = relaysByPubkey;

  if (
    result.relays === undefined &&
    result.nostrconnectUrl === undefined &&
    result.relaysByPubkey === undefined
  ) {
    return undefined;
  }
  return result;
}

/** Bunker relays from `nip46`: per-pubkey map wins over spec `relays`. Never uses profile `doc.relays`. */
export function bunkerRelaysFromNip46(nip46: Nip05Nip46 | undefined, pubkey: string): string[] {
  if (!nip46) return [];
  const byPubkey = nip46.relaysByPubkey?.[pubkey.toLowerCase()];
  if (byPubkey?.length) return [...byPubkey];
  if (nip46.relays?.length) return [...nip46.relays];
  return [];
}

/** Parse and validate a nostr.json document body. */
export function parseNip05Document(json: unknown): Nip05Document {
  if (!json || typeof json !== "object") {
    throw new Nip05Error("NIP-05 document must be a JSON object");
  }
  const raw = json as { names?: unknown; relays?: unknown; nip46?: unknown };
  if (!raw.names || typeof raw.names !== "object" || Array.isArray(raw.names)) {
    throw new Nip05Error("NIP-05 document missing names map");
  }

  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.names as Record<string, unknown>)) {
    if (typeof v !== "string" || !isHex32(v)) continue;
    names[k.toLowerCase()] = v.toLowerCase();
  }

  let relays: Record<string, string[]> | undefined;
  if (raw.relays && typeof raw.relays === "object" && !Array.isArray(raw.relays)) {
    relays = {};
    for (const [pk, list] of Object.entries(raw.relays as Record<string, unknown>)) {
      if (!isHex32(pk)) continue;
      const urls = stringUrls(list);
      if (urls?.length) relays[pk.toLowerCase()] = urls;
    }
  }

  return { names, relays, nip46: parseNip05Nip46(raw.nip46) };
}

/** Resolve local name from an already-parsed document. */
export function lookupFromDocument(
  doc: Nip05Document,
  address: Nip05Address,
): ProfilePointer | undefined {
  const pubkey = doc.names[address.local];
  if (!pubkey) return undefined;
  const relays = doc.relays?.[pubkey];
  return relays?.length ? { pubkey, relays: [...relays] } : { pubkey };
}

function defaultFetch(): Nip05Fetch {
  if (typeof globalThis.fetch !== "function") {
    throw new Nip05Error("no fetch implementation available; pass opts.fetch");
  }
  return globalThis.fetch.bind(globalThis) as Nip05Fetch;
}

/**
 * Fetch and parse `/.well-known/nostr.json`.
 * Returns `null` on network/parse failure (does not throw for those).
 * Rejects HTTP redirects (non-200) per NIP-05 security constraints.
 */
export async function queryNip05Document(
  identifier: string,
  opts?: { fetch?: Nip05Fetch; signal?: AbortSignal },
): Promise<{ address: Nip05Address; doc: Nip05Document } | null> {
  let address: Nip05Address;
  try {
    address = parseNip05(identifier);
  } catch {
    return null;
  }

  const url = wellKnownUrl(address);
  const fetchImpl = opts?.fetch ?? defaultFetch();

  try {
    const res = await fetchImpl(url, { signal: opts?.signal, redirect: "manual" });
    // Redirects and errors must not be trusted (NIP-05 security).
    if (res.status !== 200) return null;
    const json = await res.json();
    return { address, doc: parseNip05Document(json) };
  } catch {
    return null;
  }
}

/**
 * Query `/.well-known/nostr.json` for an identifier.
 * Returns `null` on network/parse/lookup failure (does not throw for those).
 * Profile `relays` only — bunker relays live on `nip46`.
 */
export async function queryProfile(
  identifier: string,
  opts?: { fetch?: Nip05Fetch; signal?: AbortSignal },
): Promise<ProfilePointer | null> {
  const fetched = await queryNip05Document(identifier, opts);
  if (!fetched) return null;
  return lookupFromDocument(fetched.doc, fetched.address) ?? null;
}

/** True when the identifier resolves to exactly `pubkey`. */
export async function verifyNip05(
  pubkey: string,
  identifier: string,
  opts?: { fetch?: Nip05Fetch; signal?: AbortSignal },
): Promise<boolean> {
  if (!isHex32(pubkey)) return false;
  const profile = await queryProfile(identifier, opts);
  return profile !== null && profile.pubkey === pubkey.toLowerCase();
}
