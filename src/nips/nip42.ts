import type { EventTemplate } from "../core/event.ts";
import { Kind } from "../core/kind.ts";

/**
 * Build an unsigned NIP-42 AUTH event template for the given relay challenge.
 * Caller must sign with their `NostrSigner` / keys.
 */
export function makeAuthEvent(relayURL: string, challenge: string): EventTemplate {
  return {
    kind: Kind.ClientAuth,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["relay", relayURL],
      ["challenge", challenge],
    ],
    content: "",
  };
}

/** True when a CLOSED reason requests NIP-42 authentication. */
export function isAuthRequired(reason: string): boolean {
  return reason.startsWith("auth-required:");
}
