/** NIP-01 regular: stored by relays. */
export function isRegularKind(kind: number): boolean {
  return kind === 1 || kind === 2 || (kind >= 4 && kind < 45) || (kind >= 1000 && kind < 10000);
}

/** Replaceable: latest per (pubkey, kind) wins. */
export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/** Ephemeral: not expected to be stored. */
export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

/** Addressable (parameterized replaceable): latest per (pubkey, kind, d-tag) wins. */
export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

export type KindClassification =
  | "regular"
  | "replaceable"
  | "ephemeral"
  | "addressable"
  | "unknown";

export function classifyKind(kind: number): KindClassification {
  if (isRegularKind(kind)) return "regular";
  if (isReplaceableKind(kind)) return "replaceable";
  if (isEphemeralKind(kind)) return "ephemeral";
  if (isAddressableKind(kind)) return "addressable";
  return "unknown";
}

/** Kind numbers used by this package. */
export const Kind = {
  Metadata: 0,
  TextNote: 1,
  Contacts: 3,
  EventDeletion: 5,
  Repost: 6,
  Reaction: 7,
  Seal: 13,
  PrivateDirectMessage: 14,
  GenericRepost: 16,
  GiftWrap: 1059,
  ZapRequest: 9734,
  Zap: 9735,
  MuteList: 10000,
  PinList: 10001,
  RelayList: 10002,
  BookmarkList: 10003,
  FavoriteRelays: 10012,
  UserEmojiList: 10030,
  DirectMessageRelaysList: 10050,
  BlossomServerList: 10063,
  GiftWrapEphemeral: 21059,
  ClientAuth: 22242,
  NostrConnect: 24133,
  BlobsAuth: 24242,
  HttpAuth: 27235,
  RelaySets: 30002,
  EmojiSet: 30030,
  StarterPack: 39089,
} as const;

export type KindName = keyof typeof Kind;
export type KnownKind = (typeof Kind)[KindName];
