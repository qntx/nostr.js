/**
 * NIP-13: Proof of Work.
 * Does not import signer, relay, or client. Does not sign.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/13.md
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { NostrError } from "../core/error.ts";
import { serializeEvent, type UnsignedEvent } from "../core/event.ts";
import { bytesToHex, utf8Encoder } from "../core/util.ts";

export class Nip13Error extends NostrError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type MinePowOptions = {
  /** Yield to the event loop after this many hashes. Default 1000. */
  yieldEvery?: number;
  signal?: AbortSignal;
};

/** Leading zero bits of a hex event id or raw sha256 bytes. */
export function getPow(idOrHash: string | Uint8Array): number {
  if (typeof idOrHash === "string") {
    let count = 0;
    for (let i = 0; i < idOrHash.length; i += 8) {
      const chunk = Number.parseInt(idOrHash.substring(i, i + 8), 16);
      if (chunk === 0) {
        count += 32;
      } else {
        count += Math.clz32(chunk);
        break;
      }
    }
    return count;
  }

  let count = 0;
  for (let i = 0; i < idOrHash.length; i++) {
    const byte = idOrHash[i]!;
    if (byte === 0) {
      count += 8;
    } else {
      count += Math.clz32(byte) - 24;
      break;
    }
  }
  return count;
}

/**
 * Returns a new unsigned event with nonce tag and computed id.
 * Does not mutate input. Yields every `yieldEvery` hashes.
 */
export async function minePow(
  unsigned: UnsignedEvent,
  difficulty: number,
  opts?: MinePowOptions,
): Promise<UnsignedEvent & { id: string }> {
  const signal = opts?.signal;
  const yieldEvery = Math.max(1, opts?.yieldEvery ?? 1000);

  const nonce: [string, string, string] = ["nonce", "0", String(difficulty)];
  const mined = {
    kind: unsigned.kind,
    tags: [...unsigned.tags, nonce],
    content: unsigned.content,
    created_at: unsigned.created_at,
    pubkey: unsigned.pubkey,
  };

  let count = 0;
  let iterations = 0;

  while (true) {
    if (signal?.aborted) {
      throw new Nip13Error("mining aborted", { cause: signal.reason });
    }

    const now = Math.floor(Date.now() / 1000);
    if (now !== mined.created_at) {
      count = 0;
      mined.created_at = now;
    }

    nonce[1] = String(++count);
    const hash = sha256(utf8Encoder.encode(serializeEvent(mined)));
    if (getPow(hash) >= difficulty) {
      return { ...mined, id: bytesToHex(hash) };
    }

    iterations++;
    if (iterations >= yieldEvery) {
      iterations = 0;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }
}
