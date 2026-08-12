export {
  EVENT_ID_BYTES,
  PUBLIC_KEY_BYTES,
  SECRET_KEY_BYTES,
  SIGNATURE_BYTES,
  SUBSCRIPTION_ID_MAX_CHARS,
} from "./limits.ts";

export {
  CryptoError,
  EventValidationError,
  HexError,
  MessageError,
  NostrError,
  UrlError,
} from "./error.ts";

export {
  assertHex32,
  assertSecretKeyBytes,
  bytesToHex,
  hexToBytes,
  isHex32,
  isHex64,
  normalizeURL,
  utf8Decoder,
  utf8Encoder,
} from "./util.ts";

export {
  Kind,
  classifyKind,
  isAddressableKind,
  isEphemeralKind,
  isRegularKind,
  isReplaceableKind,
  type KindClassification,
  type KindName,
  type KnownKind,
} from "./kind.ts";

export { Tag, getDTag, isTag, tagName, tagValue } from "./tag.ts";
export type { Tag as TagTuple, TagInput } from "./tag.ts";

export {
  getEventHash,
  isMarkedVerified,
  serializeEvent,
  sortEvents,
  sortedEvents,
  validateEvent,
  validateSignedEvent,
  type Event,
  type EventTemplate,
  type UnsignedEvent,
} from "./event.ts";

// verification cache helpers — available under @qntx/nostr/core for advanced use
export { isMarkedFailed, markUnverified, markVerified } from "./event.ts";

export {
  Keys,
  SecretKey,
  finalizeEvent,
  getPublicKey,
  publicKeyFromHex,
  signEvent,
  verifyEvent,
  type PublicKey,
} from "./key.ts";

export { EventBuilder, type ProfileMetadata } from "./builder.ts";

export {
  cloneFilter,
  getFilterLimit,
  matchFilter,
  matchFilters,
  mergeFilters,
  type Filter,
} from "./filter.ts";

export {
  createSubscriptionId,
  encodeClientMessage,
  encodeRelayMessage,
  parseClientMessage,
  parseRelayMessage,
  type ClientMessage,
  type RelayMessage,
  type SubscriptionId,
} from "./message.ts";
