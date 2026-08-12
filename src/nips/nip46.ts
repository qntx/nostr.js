/**
 * NIP-46 (Nostr Connect) protocol helpers: bunker URI, nostrconnect URI, RPC JSON.
 * Transport/signing live in {@link Nip46Signer}.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/46.md
 */
import { assertHex32, isHex32 } from "../core/util.ts";
import { NostrError } from "../core/error.ts";

export const BUNKER_REGEX = /^bunker:\/\/([0-9a-fA-F]{64})\??([?/\w:.=&%-]*)$/;

export type BunkerPointer = {
  /** Remote signer / bunker public key (hex). */
  pubkey: string;
  relays: string[];
  secret: string | null;
};

export type ClientMetadata = {
  name?: string;
  url?: string;
  image?: string;
};

export type NostrConnectParams = {
  clientPubkey: string;
  relays: string[];
  secret: string;
  perms?: string[];
} & ClientMetadata;

export type Nip46Request = {
  id: string;
  method: string;
  params: string[];
};

export type Nip46Response = {
  id: string;
  result?: string;
  error?: string;
};

export class Nip46Error extends NostrError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Encode a bunker pointer as `bunker://…`. */
export function toBunkerURL(pointer: BunkerPointer): string {
  const url = new URL(`bunker://${pointer.pubkey.toLowerCase()}`);
  for (const relay of pointer.relays) {
    url.searchParams.append("relay", relay);
  }
  if (pointer.secret) {
    url.searchParams.set("secret", pointer.secret);
  }
  return url.toString();
}

/**
 * Parse a `bunker://` URL into a pointer.
 * Returns null when the input is not a bunker URL (e.g. NIP-05 identifiers need async lookup).
 */
export function parseBunkerURL(input: string): BunkerPointer | null {
  const match = input.trim().match(BUNKER_REGEX);
  if (!match?.[1]) return null;
  try {
    const pubkey = assertHex32(match[1], "bunker pubkey");
    const qs = new URLSearchParams(match[2] ?? "");
    return {
      pubkey,
      relays: qs.getAll("relay"),
      secret: qs.get("secret"),
    };
  } catch {
    return null;
  }
}

/** Build a client-initiated `nostrconnect://` URI. */
export function createNostrConnectURI(params: NostrConnectParams): string {
  if (!isHex32(params.clientPubkey)) {
    throw new Nip46Error("invalid client pubkey");
  }
  if (!params.secret) {
    throw new Nip46Error("nostrconnect secret is required");
  }
  if (params.relays.length === 0) {
    throw new Nip46Error("at least one relay is required");
  }

  const query = new URLSearchParams();
  for (const relay of params.relays) {
    query.append("relay", relay);
  }
  query.set("secret", params.secret);
  if (params.perms && params.perms.length > 0) {
    query.set("perms", params.perms.join(","));
  }
  if (params.name) query.set("name", params.name);
  if (params.url) query.set("url", params.url);
  if (params.image) query.set("image", params.image);

  return `nostrconnect://${params.clientPubkey.toLowerCase()}?${query.toString()}`;
}

/** Parse a `nostrconnect://` URI. */
export function parseNostrConnectURI(uri: string): NostrConnectParams {
  let url: URL;
  try {
    url = new URL(uri);
  } catch (cause) {
    throw new Nip46Error(`invalid nostrconnect URI: ${uri}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (url.protocol !== "nostrconnect:") {
    throw new Nip46Error(`expected nostrconnect: scheme, got ${url.protocol}`);
  }
  const clientPubkey = url.hostname || url.pathname.replace(/^\/*/, "");
  if (!isHex32(clientPubkey)) {
    throw new Nip46Error("invalid client pubkey in nostrconnect URI");
  }
  const secret = url.searchParams.get("secret");
  if (!secret) throw new Nip46Error("missing secret in nostrconnect URI");
  const relays = url.searchParams.getAll("relay");
  if (relays.length === 0) throw new Nip46Error("missing relays in nostrconnect URI");
  const permsRaw = url.searchParams.get("perms");
  return {
    clientPubkey: clientPubkey.toLowerCase(),
    relays,
    secret,
    perms: permsRaw ? permsRaw.split(",").filter(Boolean) : undefined,
    name: url.searchParams.get("name") ?? undefined,
    url: url.searchParams.get("url") ?? undefined,
    image: url.searchParams.get("image") ?? undefined,
  };
}

export function encodeNip46Request(req: Nip46Request): string {
  return JSON.stringify({ id: req.id, method: req.method, params: req.params });
}

export function decodeNip46Request(json: string): Nip46Request {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (cause) {
    throw new Nip46Error("invalid NIP-46 request JSON", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (!isRecord(data) || typeof data.id !== "string" || typeof data.method !== "string") {
    throw new Nip46Error("invalid NIP-46 request shape");
  }
  if (!Array.isArray(data.params) || !data.params.every((p) => typeof p === "string")) {
    throw new Nip46Error("invalid NIP-46 request params");
  }
  return { id: data.id, method: data.method, params: data.params as string[] };
}

export function encodeNip46Response(res: Nip46Response): string {
  const body: Record<string, string> = { id: res.id };
  if (res.result !== undefined) body.result = res.result;
  if (res.error !== undefined) body.error = res.error;
  return JSON.stringify(body);
}

export function decodeNip46Response(json: string): Nip46Response {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (cause) {
    throw new Nip46Error("invalid NIP-46 response JSON", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (!isRecord(data) || typeof data.id !== "string") {
    throw new Nip46Error("invalid NIP-46 response shape");
  }
  if (data.result !== undefined && typeof data.result !== "string") {
    throw new Nip46Error("invalid NIP-46 response result");
  }
  if (data.error !== undefined && typeof data.error !== "string") {
    throw new Nip46Error("invalid NIP-46 response error");
  }
  return {
    id: data.id,
    result: data.result as string | undefined,
    error: data.error as string | undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
