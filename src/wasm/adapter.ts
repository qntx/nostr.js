import { NostrError } from "../core/error.ts";
import type { Event } from "../core/event.ts";
import {
  isMarkedFailed,
  isMarkedVerified,
  markUnverified,
  markVerified,
  serializeEvent,
  validateSignedEvent,
} from "../core/event.ts";
import { hexToBytes, utf8Encoder } from "../core/util.ts";

// Relay duck-types poison by name and must not import src/wasm.
export class WasmVerifyPoisonedError extends NostrError {
  override name = "WasmVerifyPoisonedError";
}

export type WasmSerializedVerify = {
  verifySerialized: (
    serializedUtf8: Uint8Array,
    id: Uint8Array,
    pubkey: Uint8Array,
    sig: Uint8Array,
  ) => boolean;
};

export function makeVerifyEvent(
  wasm: WasmSerializedVerify,
  poison: { error?: Error },
): (event: Event) => boolean {
  return (event: Event): boolean => {
    if (poison.error) throw poison.error;
    if (isMarkedVerified(event)) return true;
    if (isMarkedFailed(event)) return false;
    if (!validateSignedEvent(event)) {
      markUnverified(event);
      return false;
    }
    try {
      const serialized = utf8Encoder.encode(serializeEvent(event));
      const id = hexToBytes(event.id.toLowerCase());
      const pubkey = hexToBytes(event.pubkey.toLowerCase());
      const sig = hexToBytes(event.sig.toLowerCase());
      const ok = wasm.verifySerialized(serialized, id, pubkey, sig);
      if (ok) markVerified(event);
      else markUnverified(event);
      return ok;
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) {
        poison.error = new WasmVerifyPoisonedError("wasm verify aborted the instance", {
          cause: e,
        });
        throw poison.error;
      }
      markUnverified(event);
      return false;
    }
  };
}
