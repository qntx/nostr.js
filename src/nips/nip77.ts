/**
 * NIP-77: Negentropy Syncing.
 * Transport-free V1 algorithm. Does not import relay or client.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/77.md
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { NostrError } from "../core/error.ts";
import type { Event } from "../core/event.ts";
import { assertHex32, bytesToHex, hexToBytes } from "../core/util.ts";

export const PROTOCOL_VERSION = 0x61;
export const DEFAULT_FRAME_SIZE_LIMIT = 60_000;
export const MAX_NEG_ROUNDS = 1024;

const ID_SIZE = 32;
const FINGERPRINT_SIZE = 16;
const INFINITY = Number.MAX_VALUE;
const BUCKETS = 16;
const ID_LIST_THRESHOLD = BUCKETS * 2;

const Mode = {
  Skip: 0,
  Fingerprint: 1,
  IdList: 2,
} as const;

export class Nip77Error extends NostrError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type NegItem = {
  timestamp: number;
  id: Uint8Array;
};

export type ReconcileOutcome = {
  /** Event ids the local side holds that the peer does not. */
  have: string[];
  /** Event ids the peer holds that the local side does not. */
  need: string[];
  /** Next NEG-MSG hex, or null when the session converged. */
  nextMessage: string | null;
};

class EncodedBuf {
  #raw: Uint8Array;
  length: number;

  constructor(buffer?: Uint8Array | number) {
    if (typeof buffer === "number") {
      this.#raw = new Uint8Array(buffer);
      this.length = 0;
    } else if (buffer) {
      this.#raw = new Uint8Array(buffer);
      this.length = buffer.length;
    } else {
      this.#raw = new Uint8Array(512);
      this.length = 0;
    }
  }

  unwrap(): Uint8Array {
    return this.#raw.subarray(0, this.length);
  }

  get capacity(): number {
    return this.#raw.byteLength;
  }

  extend(buf: Uint8Array | EncodedBuf): void {
    const bytes = buf instanceof EncodedBuf ? buf.unwrap() : buf;
    const targetSize = bytes.length + this.length;
    if (this.capacity < targetSize) {
      const old = this.#raw;
      const next = new Uint8Array(Math.max(this.capacity * 2, targetSize));
      next.set(old);
      this.#raw = next;
    }
    this.#raw.set(bytes, this.length);
    this.length += bytes.length;
  }

  shift(): number {
    if (this.length === 0) throw new Nip77Error("parse ends prematurely");
    const first = this.#raw[0]!;
    this.#raw = this.#raw.subarray(1);
    this.length -= 1;
    return first;
  }

  shiftN(n: number): Uint8Array {
    if (this.length < n) throw new Nip77Error("parse ends prematurely");
    const head = this.#raw.subarray(0, n);
    this.#raw = this.#raw.subarray(n);
    this.length -= n;
    return head;
  }
}

function decodeVarInt(buf: EncodedBuf): number {
  let res = 0;
  for (;;) {
    const byte = buf.shift();
    res = (res << 7) | (byte & 127);
    if ((byte & 128) === 0) break;
  }
  return res;
}

function encodeVarInt(n: number): EncodedBuf {
  if (n === 0) return new EncodedBuf(new Uint8Array([0]));
  const digits: number[] = [];
  let value = n;
  while (value !== 0) {
    digits.push(value & 127);
    value >>>= 7;
  }
  digits.reverse();
  for (let i = 0; i < digits.length - 1; i++) digits[i] |= 128;
  return new EncodedBuf(new Uint8Array(digits));
}

function getBytes(buf: EncodedBuf, n: number): Uint8Array {
  return buf.shiftN(n);
}

class Accumulator {
  #buf: Uint8Array;

  constructor() {
    this.#buf = new Uint8Array(ID_SIZE);
  }

  add(other: Uint8Array): void {
    const view = new DataView(this.#buf.buffer, this.#buf.byteOffset, this.#buf.byteLength);
    const otherView = new DataView(other.buffer, other.byteOffset, other.byteLength);
    let carry = 0;
    for (let i = 0; i < 8; i++) {
      const offset = i * 4;
      const next = view.getUint32(offset, true) + carry + otherView.getUint32(offset, true);
      carry = next > 0xffffffff ? 1 : 0;
      view.setUint32(offset, next >>> 0, true);
    }
  }

  fingerprint(n: number): Uint8Array {
    const input = new EncodedBuf();
    input.extend(this.#buf);
    input.extend(encodeVarInt(n));
    return sha256(input.unwrap()).subarray(0, FINGERPRINT_SIZE);
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  if (a.byteLength > b.byteLength) return 1;
  if (a.byteLength < b.byteLength) return -1;
  return 0;
}

function compareNegItems(a: NegItem, b: NegItem): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return compareBytes(a.id, b.id);
}

/** Sort key for NIP-77 items: `created_at` ascending, then `id` lexicographically. */
export function itemCompare(
  a: { id: string; created_at: number },
  b: { id: string; created_at: number },
): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export class NegentropyStorageVector {
  #items: NegItem[] = [];
  #sealed = false;

  insert(timestamp: number, id: string): void {
    if (this.#sealed) throw new Nip77Error("already sealed");
    if (timestamp === INFINITY) throw new Nip77Error("timestamp is reserved infinity");
    const idb = hexToBytes(assertHex32(id, "event id"));
    this.#items.push({ timestamp, id: idb });
  }

  seal(): void {
    if (this.#sealed) throw new Nip77Error("already sealed");
    this.#sealed = true;
    this.#items.sort(compareNegItems);
    for (let i = 1; i < this.#items.length; i++) {
      if (compareNegItems(this.#items[i - 1]!, this.#items[i]!) === 0) {
        throw new Nip77Error("duplicate item inserted");
      }
    }
  }

  size(): number {
    this.#checkSealed();
    return this.#items.length;
  }

  iterate(begin: number, end: number, cb: (item: NegItem, i: number) => boolean): void {
    this.#checkSealed();
    this.#checkBounds(begin, end);
    for (let i = begin; i < end; i++) {
      if (!cb(this.#items[i]!, i)) break;
    }
  }

  findLowerBound(begin: number, end: number, bound: NegItem): number {
    this.#checkSealed();
    this.#checkBounds(begin, end);
    let first = begin;
    let count = end - begin;
    while (count > 0) {
      const step = Math.floor(count / 2);
      const it = first + step;
      if (compareNegItems(this.#items[it]!, bound) < 0) {
        first = it + 1;
        count -= step + 1;
      } else {
        count = step;
      }
    }
    return first;
  }

  fingerprint(begin: number, end: number): Uint8Array {
    const acc = new Accumulator();
    this.iterate(begin, end, (item) => {
      acc.add(item.id);
      return true;
    });
    return acc.fingerprint(end - begin);
  }

  #checkSealed(): void {
    if (!this.#sealed) throw new Nip77Error("not sealed");
  }

  #checkBounds(begin: number, end: number): void {
    if (begin > end || end > this.#items.length) throw new Nip77Error("bad range");
  }
}

export function storageFromItems(
  items: readonly { id: string; created_at: number }[],
): NegentropyStorageVector {
  const storage = new NegentropyStorageVector();
  const seen = new Set<string>();
  for (const item of items) {
    const id = item.id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    storage.insert(item.created_at, id);
  }
  storage.seal();
  return storage;
}

export function storageFromEvents(
  events: readonly Pick<Event, "id" | "created_at">[],
): NegentropyStorageVector {
  return storageFromItems(events);
}

type Bound = { timestamp: number; id: Uint8Array };

export class Negentropy {
  readonly #storage: NegentropyStorageVector;
  readonly #frameSizeLimit: number;
  #initiator = false;
  #lastTimestampIn = 0;
  #lastTimestampOut = 0;

  constructor(storage: NegentropyStorageVector, frameSizeLimit = DEFAULT_FRAME_SIZE_LIMIT) {
    if (frameSizeLimit !== 0 && frameSizeLimit < 4096) {
      throw new Nip77Error("frameSizeLimit too small");
    }
    this.#storage = storage;
    this.#frameSizeLimit = frameSizeLimit;
  }

  initiate(): string {
    this.#initiator = true;
    const output = new EncodedBuf();
    output.extend(new Uint8Array([PROTOCOL_VERSION]));
    this.#splitRange(0, this.#storage.size(), this.#bound(INFINITY), output);
    return bytesToHex(output.unwrap());
  }

  reconcile(queryMsg: string): ReconcileOutcome {
    const have: string[] = [];
    const need: string[] = [];
    const query = new EncodedBuf(hexToBytes(queryMsg));

    this.#lastTimestampIn = 0;
    this.#lastTimestampOut = 0;

    const fullOutput = new EncodedBuf();
    fullOutput.extend(new Uint8Array([PROTOCOL_VERSION]));

    const protocolVersion = query.shift();
    if (protocolVersion < 0x60 || protocolVersion > 0x6f) {
      throw new Nip77Error("invalid negentropy protocol version byte");
    }
    if (protocolVersion !== PROTOCOL_VERSION) {
      throw new Nip77Error(
        `unsupported negentropy protocol version requested: ${protocolVersion - 0x60}`,
      );
    }

    const storageSize = this.#storage.size();
    let prevBound = this.#bound(0);
    let prevIndex = 0;
    let skip = false;

    while (query.length !== 0) {
      const o = new EncodedBuf();
      const doSkip = (): void => {
        if (!skip) return;
        skip = false;
        o.extend(this.#encodeBound(prevBound));
        o.extend(encodeVarInt(Mode.Skip));
      };

      const currBound = this.#decodeBound(query);
      const mode = decodeVarInt(query);
      const lower = prevIndex;
      const upper = this.#storage.findLowerBound(prevIndex, storageSize, currBound);

      if (mode === Mode.Skip) {
        skip = true;
      } else if (mode === Mode.Fingerprint) {
        const theirFingerprint = getBytes(query, FINGERPRINT_SIZE);
        const ourFingerprint = this.#storage.fingerprint(lower, upper);
        if (compareBytes(theirFingerprint, ourFingerprint) !== 0) {
          doSkip();
          this.#splitRange(lower, upper, currBound, o);
        } else {
          skip = true;
        }
      } else if (mode === Mode.IdList) {
        const numIds = decodeVarInt(query);
        const theirElems = new Map<string, Uint8Array>();
        for (let i = 0; i < numIds; i++) {
          const e = getBytes(query, ID_SIZE);
          theirElems.set(bytesToHex(e), e);
        }

        if (this.#initiator) {
          skip = true;
          this.#storage.iterate(lower, upper, (item) => {
            const id = bytesToHex(item.id);
            if (!theirElems.has(id)) have.push(id);
            else theirElems.delete(id);
            return true;
          });
          for (const id of theirElems.keys()) need.push(id);
        } else {
          doSkip();
          o.extend(this.#encodeBound(currBound));
          o.extend(encodeVarInt(Mode.IdList));
          const ourIds: Uint8Array[] = [];
          this.#storage.iterate(lower, upper, (item) => {
            ourIds.push(item.id);
            return true;
          });
          o.extend(encodeVarInt(ourIds.length));
          for (const id of ourIds) o.extend(id);
        }
      } else {
        throw new Nip77Error("unexpected mode");
      }

      if (this.#exceededFrameSizeLimit(fullOutput.length + o.length)) {
        const remainingFingerprint = this.#storage.fingerprint(upper, storageSize);
        fullOutput.extend(this.#encodeBound(this.#bound(INFINITY)));
        fullOutput.extend(encodeVarInt(Mode.Fingerprint));
        fullOutput.extend(remainingFingerprint);
        break;
      }
      fullOutput.extend(o);
      prevIndex = upper;
      prevBound = currBound;
    }

    return {
      have,
      need,
      nextMessage: fullOutput.length === 1 ? null : bytesToHex(fullOutput.unwrap()),
    };
  }

  #bound(timestamp: number, id?: Uint8Array): Bound {
    return { timestamp, id: id ?? new Uint8Array(0) };
  }

  #splitRange(lower: number, upper: number, upperBound: Bound, o: EncodedBuf): void {
    const numElems = upper - lower;
    if (numElems < ID_LIST_THRESHOLD) {
      o.extend(this.#encodeBound(upperBound));
      o.extend(encodeVarInt(Mode.IdList));
      o.extend(encodeVarInt(numElems));
      this.#storage.iterate(lower, upper, (item) => {
        o.extend(item.id);
        return true;
      });
      return;
    }

    const itemsPerBucket = Math.floor(numElems / BUCKETS);
    const bucketsWithExtra = numElems % BUCKETS;
    let curr = lower;
    for (let i = 0; i < BUCKETS; i++) {
      const bucketSize = itemsPerBucket + (i < bucketsWithExtra ? 1 : 0);
      const ourFingerprint = this.#storage.fingerprint(curr, curr + bucketSize);
      curr += bucketSize;
      let nextBound: Bound;
      if (curr === upper) {
        nextBound = upperBound;
      } else {
        let prevItem: NegItem | undefined;
        let currItem: NegItem | undefined;
        this.#storage.iterate(curr - 1, curr + 1, (item, index) => {
          if (index === curr - 1) prevItem = item;
          else currItem = item;
          return true;
        });
        nextBound = this.#minimalBound(prevItem!, currItem!);
      }
      o.extend(this.#encodeBound(nextBound));
      o.extend(encodeVarInt(Mode.Fingerprint));
      o.extend(ourFingerprint);
    }
  }

  #exceededFrameSizeLimit(n: number): boolean {
    if (this.#frameSizeLimit === 0) return false;
    return n > this.#frameSizeLimit - 200;
  }

  #decodeTimestampIn(encoded: EncodedBuf): number {
    let timestamp = decodeVarInt(encoded);
    timestamp = timestamp === 0 ? INFINITY : timestamp - 1;
    if (this.#lastTimestampIn === INFINITY || timestamp === INFINITY) {
      this.#lastTimestampIn = INFINITY;
      return INFINITY;
    }
    timestamp += this.#lastTimestampIn;
    this.#lastTimestampIn = timestamp;
    return timestamp;
  }

  #decodeBound(encoded: EncodedBuf): Bound {
    const timestamp = this.#decodeTimestampIn(encoded);
    const len = decodeVarInt(encoded);
    if (len > ID_SIZE) throw new Nip77Error("bound key too long");
    return { timestamp, id: getBytes(encoded, len) };
  }

  #encodeTimestampOut(timestamp: number): EncodedBuf {
    if (timestamp === INFINITY) {
      this.#lastTimestampOut = INFINITY;
      return encodeVarInt(0);
    }
    const temp = timestamp;
    timestamp -= this.#lastTimestampOut;
    this.#lastTimestampOut = temp;
    return encodeVarInt(timestamp + 1);
  }

  #encodeBound(key: Bound): EncodedBuf {
    const output = new EncodedBuf();
    output.extend(this.#encodeTimestampOut(key.timestamp));
    output.extend(encodeVarInt(key.id.length));
    output.extend(key.id);
    return output;
  }

  #minimalBound(prev: NegItem, curr: NegItem): Bound {
    if (curr.timestamp !== prev.timestamp) return this.#bound(curr.timestamp);
    let shared = 0;
    for (let i = 0; i < ID_SIZE; i++) {
      if (curr.id[i] !== prev.id[i]) break;
      shared += 1;
    }
    return this.#bound(curr.timestamp, curr.id.subarray(0, shared + 1));
  }
}

/** Initiator session: produce the opening message, then fold each peer reply. */
export class Reconciliation {
  readonly #neg: Negentropy;
  readonly opening: string;

  constructor(storage: NegentropyStorageVector, frameSizeLimit = DEFAULT_FRAME_SIZE_LIMIT) {
    this.#neg = new Negentropy(storage, frameSizeLimit);
    this.opening = this.#neg.initiate();
  }

  reconcile(queryHex: string): ReconcileOutcome {
    return this.#neg.reconcile(queryHex);
  }
}

/** Responder session: fold each initiator message (does not call initiate). */
export class Responder {
  readonly #neg: Negentropy;

  constructor(storage: NegentropyStorageVector, frameSizeLimit = DEFAULT_FRAME_SIZE_LIMIT) {
    this.#neg = new Negentropy(storage, frameSizeLimit);
  }

  reconcile(queryHex: string): ReconcileOutcome {
    return this.#neg.reconcile(queryHex);
  }
}
