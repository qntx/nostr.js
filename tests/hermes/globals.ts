/**
 * Test-only globals installed before the library modules evaluate, for the raw
 * Hermes CLI (`hermes`, no RN host). Each shim mirrors what an Expo / React
 * Native runtime provides in production — the library documents these as
 * runtime requirements and ships no fallbacks.
 */

import { Buffer as BufferPolyfill } from "buffer";
import { URL as WhatwgURL, URLSearchParams as WhatwgURLSearchParams } from "whatwg-url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

/**
 * Referenced by smoke.ts so bundlers keep this module (and its ordering):
 * package.json whitelists only `*.wasm` in `sideEffects`, so bun/esbuild would
 * tree-shake a pure side-effect module and skip installation entirely.
 */
export const hermesGlobalsInstalled: boolean = true;

// crypto.getRandomValues — production: react-native-quick-crypto / expo-crypto
// polyfill. xorshift PRNG: test-grade only, not cryptographic.
if (typeof g.crypto === "undefined") g.crypto = {};
if (typeof g.crypto.getRandomValues !== "function") {
  let s0 = 0x9e3779b9 ^ Date.now();
  g.crypto.getRandomValues = <T extends { length: number; [k: number]: number }>(arr: T): T => {
    for (let i = 0; i < arr.length; i++) {
      s0 ^= s0 << 13;
      s0 ^= s0 >>> 17;
      s0 ^= s0 << 5;
      arr[i] = s0 >>> 0;
    }
    return arr;
  };
}

// TextDecoder — production: Expo ships a UTF-8 TextDecoder on native (Hermes
// itself ships TextEncoder only). Minimal UTF-8 decoder: invalid, truncated,
// overlong, surrogate, and out-of-range sequences each decode to U+FFFD,
// consuming the longest well-formed prefix of the ill-formed subpart.
if (typeof g.TextDecoder === "undefined") {
  g.TextDecoder = class {
    readonly encoding = "utf-8";
    decode(input?: ArrayBuffer | ArrayBufferView | null): string {
      if (!input) return "";
      const bytes =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = "";
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i]!;
        if (b0 < 0x80) {
          out += String.fromCharCode(b0);
          i += 1;
          continue;
        }
        // Sequence length and valid range for the second byte (the range also
        // encodes the overlong / surrogate / >U+10FFFF restrictions).
        let len: number;
        let lo = 0x80;
        let hi = 0xbf;
        if (b0 >= 0xc2 && b0 <= 0xdf) len = 2;
        else if (b0 === 0xe0) {
          len = 3;
          lo = 0xa0;
        } else if (b0 === 0xed) {
          len = 3;
          hi = 0x9f;
        } else if (b0 >= 0xe1 && b0 <= 0xef) len = 3;
        else if (b0 === 0xf0) {
          len = 4;
          lo = 0x90;
        } else if (b0 === 0xf4) {
          len = 4;
          hi = 0x8f;
        } else if (b0 >= 0xf1 && b0 <= 0xf3) len = 4;
        else {
          // C0/C1, F5..FF, or a stray continuation byte.
          out += "\uFFFD";
          i += 1;
          continue;
        }
        const b1 = bytes[i + 1];
        if (b1 === undefined || b1 < lo || b1 > hi) {
          out += "\uFFFD";
          i += 1;
          continue;
        }
        let cp: number;
        if (len === 2) {
          cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
        } else {
          const b2 = bytes[i + 2];
          if (b2 === undefined || b2 < 0x80 || b2 > 0xbf) {
            out += "\uFFFD";
            i += 2;
            continue;
          }
          if (len === 3) {
            cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
          } else {
            const b3 = bytes[i + 3];
            if (b3 === undefined || b3 < 0x80 || b3 > 0xbf) {
              out += "\uFFFD";
              i += 3;
              continue;
            }
            cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
          }
        }
        if (cp > 0xffff) {
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
          out += String.fromCharCode(cp);
        }
        i += len;
      }
      return out;
    }
  };
}

// queueMicrotask — production: React Native. Mapped onto the promise job
// queue: identical microtask semantics.
if (typeof g.queueMicrotask !== "function") {
  g.queueMicrotask = (fn: () => void): void => {
    void Promise.resolve().then(fn);
  };
}

// URL / URLSearchParams — production: Expo ships spec-compliant globals built
// on its whatwg-url fork; this shim uses the upstream `whatwg-url` package.
// Pinned to 7.x: whatwg-url >= 8 ships webidl2js-built sources that parse
// `async function*`, which Hermes V1 rejects at parse time.
if (typeof g.URL === "undefined") g.URL = WhatwgURL;
if (typeof g.URLSearchParams === "undefined") g.URLSearchParams = WhatwgURLSearchParams;

// Buffer — not a documented runtime requirement; only whatwg-url's host
// parser touches it (`Buffer.from`/`alloc`/`toString`). Installed solely to
// satisfy the test shim above, via the browser `buffer` package.
if (typeof g.Buffer === "undefined") g.Buffer = BufferPolyfill;
