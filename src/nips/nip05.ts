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

export type Nip05Document = {
  names: Record<string, string>;
  relays?: Record<string, string[]>;
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

/** Parse and validate a nostr.json document body. */
export function parseNip05Document(json: unknown): Nip05Document {
  if (!json || typeof json !== "object") {
    throw new Nip05Error("NIP-05 document must be a JSON object");
  }
  const raw = json as { names?: unknown; relays?: unknown };
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
      if (!isHex32(pk) || !Array.isArray(list)) continue;
      const urls = list.filter((u): u is string => typeof u === "string" && u.length > 0);
      if (urls.length) relays[pk.toLowerCase()] = urls;
    }
  }

  return { names, relays };
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
 * Query `/.well-known/nostr.json` for an identifier.
 * Returns `null` on network/parse/lookup failure (does not throw for those).
 * Rejects HTTP redirects (non-200) per NIP-05 security constraints.
 */
export async function queryProfile(
  identifier: string,
  opts?: { fetch?: Nip05Fetch; signal?: AbortSignal },
): Promise<ProfilePointer | null> {
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
    const doc = parseNip05Document(json);
    return lookupFromDocument(doc, address) ?? null;
  } catch {
    return null;
  }
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
