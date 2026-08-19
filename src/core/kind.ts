/** Events are regular — expected to be stored by relays. */
export function isRegularKind(kind: number): boolean {
  return kind < 10000 && kind !== 0 && kind !== 3;
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

/** Common kind numbers. */
export const Kind = {
  Metadata: 0,
  TextNote: 1,
  RecommendRelay: 2,
  Contacts: 3,
  EncryptedDirectMessage: 4,
  EventDeletion: 5,
  Repost: 6,
  Reaction: 7,
  BadgeAward: 8,
  Seal: 13,
  PrivateDirectMessage: 14,
  GenericRepost: 16,
  ChannelCreation: 40,
  ChannelMetadata: 41,
  ChannelMessage: 42,
  ChannelHideMessage: 43,
  ChannelMuteUser: 44,
  GiftWrap: 1059,
  FileMetadata: 1063,
  LiveChatMessage: 1311,
  Report: 1984,
  Label: 1985,
  CommunityPostApproval: 4550,
  JobRequest: 5999,
  JobResult: 6999,
  JobFeedback: 7000,
  ZapRequest: 9734,
  Zap: 9735,
  MuteList: 10000,
  PinList: 10001,
  RelayList: 10002,
  BookmarkList: 10003,
  CommunitiesList: 10004,
  PublicChatsList: 10005,
  BlockedRelaysList: 10006,
  SearchRelaysList: 10007,
  InterestsList: 10015,
  UserEmojiList: 10030,
  DirectMessageRelaysList: 10050,
  FileServerPreference: 10096,
  NwcInfo: 13194,
  LightningPubRpc: 21000,
  GiftWrapEphemeral: 21059,
  ClientAuth: 22242,
  NwcRequest: 23194,
  NwcResponse: 23195,
  NostrConnect: 24133,
  HttpAuth: 27235,
  CategorizedPeopleList: 30000,
  CategorizedBookmarkList: 30001,
  ProfileBadges: 30008,
  BadgeDefinition: 30009,
  InterestSet: 30015,
  CreateOrUpdateStall: 30017,
  CreateOrUpdateProduct: 30018,
  LongFormContent: 30023,
  DraftLongFormContent: 30024,
  EmojiSet: 30030,
  Application: 30078,
  LiveEvent: 30311,
  UserStatuses: 30315,
  ClassifiedListing: 30402,
  DraftClassifiedListing: 30403,
  DateBasedCalendarEvent: 31922,
  TimeBasedCalendarEvent: 31923,
  Calendar: 31924,
  CalendarEventRsvp: 31925,
  HandlerRecommendation: 31989,
  HandlerInformation: 31990,
  CommunityDefinition: 34550,
} as const;

export type KindName = keyof typeof Kind;
export type KnownKind = (typeof Kind)[KindName];
