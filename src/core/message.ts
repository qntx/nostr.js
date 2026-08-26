import { MessageError } from "./error.ts";
import type { Event } from "./event.ts";
import { validateSignedEvent } from "./event.ts";
import type { Filter } from "./filter.ts";
import { SUBSCRIPTION_ID_MAX_CHARS } from "./limits.ts";
import { bytesToHex, hexToBytes } from "./util.ts";

export type SubscriptionId = string;

export function assertSubscriptionId(id: string): SubscriptionId {
  if (id.length === 0 || id.length > SUBSCRIPTION_ID_MAX_CHARS) {
    throw new MessageError(`subscription id length must be 1..${SUBSCRIPTION_ID_MAX_CHARS}`);
  }
  return id;
}

export function createSubscriptionId(id?: string): SubscriptionId {
  if (id !== undefined) return assertSubscriptionId(id);
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Client → relay messages (NIP-01 + NIP-42 AUTH + NIP-45 COUNT + NIP-77). */
export type ClientMessage =
  | ["EVENT", Event]
  | ["REQ", SubscriptionId, ...Filter[]]
  | ["CLOSE", SubscriptionId]
  | ["AUTH", Event]
  | ["COUNT", SubscriptionId, ...Filter[]]
  | ["NEG-OPEN", SubscriptionId, Filter, string]
  | ["NEG-MSG", SubscriptionId, string]
  | ["NEG-CLOSE", SubscriptionId];

/** Relay → client messages. */
export type RelayMessage =
  | ["EVENT", SubscriptionId, Event]
  | ["OK", string, boolean, string]
  | ["EOSE", SubscriptionId]
  | ["CLOSED", SubscriptionId, string]
  | ["NOTICE", string]
  | ["AUTH", string]
  | ["COUNT", SubscriptionId, CountResult]
  | ["NEG-MSG", SubscriptionId, string]
  | ["NEG-ERR", SubscriptionId, string];

/** NIP-45 COUNT reply payload. */
export type CountResult = {
  count: number;
  approximate?: boolean;
  /**
   * Optional 512-char hex HyperLogLog sketch (256 registers).
   * Merge sketches with `mergeCountHll`. Estimation is unspecified by NIP-45 and not provided.
   */
  hll?: string;
};

const HLL_BYTES = 256; // 512 hex chars (NIP-45; hex only, not base64)
const HLL_HEX_LEN = HLL_BYTES * 2;
const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Register-wise max of NIP-45 HyperLogLog sketches.
 * Output is always lowercase 512 hex. Empty input is the zero sketch (identity).
 */
export function mergeCountHll(hexes: readonly string[]): string {
  const merged = new Uint8Array(HLL_BYTES);
  for (const hex of hexes) {
    if (hex.length !== HLL_HEX_LEN || !HEX_RE.test(hex)) {
      throw new MessageError("invalid NIP-45 HLL sketch: expected 512-char hex");
    }
    const bytes = hexToBytes(hex);
    for (let i = 0; i < HLL_BYTES; i++) {
      const b = bytes[i]!;
      if (b > merged[i]!) merged[i] = b;
    }
  }
  return bytesToHex(merged);
}

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

export function encodeRelayMessage(message: RelayMessage): string {
  return JSON.stringify(message);
}

export function parseClientMessage(raw: string): ClientMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new MessageError("client message is not valid JSON");
  }
  if (!Array.isArray(data) || data.length < 1 || typeof data[0] !== "string") {
    throw new MessageError("client message must be a non-empty JSON array");
  }
  const type = data[0];
  switch (type) {
    case "EVENT": {
      if (data.length !== 2 || !validateSignedEvent(data[1])) {
        throw new MessageError("invalid EVENT client message");
      }
      return ["EVENT", data[1]];
    }
    case "REQ": {
      if (data.length < 3 || typeof data[1] !== "string") {
        throw new MessageError("invalid REQ client message");
      }
      const filters = data.slice(2) as Filter[];
      if (filters.length === 0) throw new MessageError("REQ requires at least one filter");
      return ["REQ", data[1], ...filters];
    }
    case "CLOSE": {
      if (data.length !== 2 || typeof data[1] !== "string") {
        throw new MessageError("invalid CLOSE client message");
      }
      return ["CLOSE", data[1]];
    }
    case "AUTH": {
      if (data.length !== 2 || !validateSignedEvent(data[1])) {
        throw new MessageError("invalid AUTH client message");
      }
      return ["AUTH", data[1]];
    }
    case "COUNT": {
      if (data.length < 3 || typeof data[1] !== "string") {
        throw new MessageError("invalid COUNT client message");
      }
      return ["COUNT", data[1], ...(data.slice(2) as Filter[])];
    }
    case "NEG-OPEN": {
      if (data.length === 5) {
        throw new MessageError("obsolete 5-element NEG-OPEN; expected [NEG-OPEN, id, filter, hex]");
      }
      if (
        data.length !== 4 ||
        typeof data[1] !== "string" ||
        !isFilterObject(data[2]) ||
        !isNegHex(data[3])
      ) {
        throw new MessageError("invalid NEG-OPEN client message");
      }
      return ["NEG-OPEN", data[1], data[2], data[3].toLowerCase()];
    }
    case "NEG-MSG": {
      if (data.length !== 3 || typeof data[1] !== "string" || !isNegHex(data[2])) {
        throw new MessageError("invalid NEG-MSG client message");
      }
      return ["NEG-MSG", data[1], data[2].toLowerCase()];
    }
    case "NEG-CLOSE": {
      if (data.length !== 2 || typeof data[1] !== "string") {
        throw new MessageError("invalid NEG-CLOSE client message");
      }
      return ["NEG-CLOSE", data[1]];
    }
    default:
      throw new MessageError(`unknown client message type: ${type}`);
  }
}

export function parseRelayMessage(raw: string): RelayMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new MessageError("relay message is not valid JSON");
  }
  if (!Array.isArray(data) || data.length < 1 || typeof data[0] !== "string") {
    throw new MessageError("relay message must be a non-empty JSON array");
  }
  const type = data[0];
  switch (type) {
    case "EVENT": {
      if (data.length !== 3 || typeof data[1] !== "string" || !validateSignedEvent(data[2])) {
        throw new MessageError("invalid EVENT relay message");
      }
      return ["EVENT", data[1], data[2]];
    }
    case "OK": {
      if (
        data.length !== 4 ||
        typeof data[1] !== "string" ||
        typeof data[2] !== "boolean" ||
        typeof data[3] !== "string"
      ) {
        throw new MessageError("invalid OK relay message");
      }
      return ["OK", data[1], data[2], data[3]];
    }
    case "EOSE": {
      if (data.length !== 2 || typeof data[1] !== "string") {
        throw new MessageError("invalid EOSE relay message");
      }
      return ["EOSE", data[1]];
    }
    case "CLOSED": {
      if (data.length !== 3 || typeof data[1] !== "string" || typeof data[2] !== "string") {
        throw new MessageError("invalid CLOSED relay message");
      }
      return ["CLOSED", data[1], data[2]];
    }
    case "NOTICE": {
      if (data.length !== 2 || typeof data[1] !== "string") {
        throw new MessageError("invalid NOTICE relay message");
      }
      return ["NOTICE", data[1]];
    }
    case "AUTH": {
      if (data.length !== 2 || typeof data[1] !== "string") {
        throw new MessageError("invalid AUTH relay message");
      }
      return ["AUTH", data[1]];
    }
    case "COUNT": {
      if (
        data.length !== 3 ||
        typeof data[1] !== "string" ||
        typeof data[2] !== "object" ||
        data[2] === null ||
        typeof (data[2] as { count?: unknown }).count !== "number"
      ) {
        throw new MessageError("invalid COUNT relay message");
      }
      const payload = data[2] as { count: number; approximate?: unknown; hll?: unknown };
      const result: CountResult = { count: payload.count };
      if (typeof payload.approximate === "boolean") result.approximate = payload.approximate;
      const hll = parseCountHll(payload.hll);
      if (hll !== undefined) result.hll = hll;
      return ["COUNT", data[1], result];
    }
    case "NEG-MSG": {
      if (data.length !== 3 || typeof data[1] !== "string" || !isNegHex(data[2])) {
        throw new MessageError("invalid NEG-MSG relay message");
      }
      return ["NEG-MSG", data[1], data[2].toLowerCase()];
    }
    case "NEG-ERR": {
      if (
        (data.length !== 3 && data.length !== 4) ||
        typeof data[1] !== "string" ||
        typeof data[2] !== "string"
      ) {
        throw new MessageError("invalid NEG-ERR relay message");
      }
      return ["NEG-ERR", data[1], data[2]];
    }
    default:
      throw new MessageError(`unknown relay message type: ${type}`);
  }
}

function parseCountHll(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length !== HLL_HEX_LEN || !HEX_RE.test(value)) {
    return undefined;
  }
  return value.toLowerCase();
}

function isFilterObject(value: unknown): value is Filter {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNegHex(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length % 2 === 0 && HEX_RE.test(value)
  );
}
