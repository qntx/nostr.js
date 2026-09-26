import { NostrError } from "../core/error.ts";

/**
 * Thrown by a lazy NIP-42 AUTH sign function when no signer is configured at
 * challenge time. {@link import("../relay/relay.ts").Relay} catches it and
 * ignores the challenge: no AUTH frame is sent and the connection stays open.
 */
export class NoSignerError extends NostrError {}
