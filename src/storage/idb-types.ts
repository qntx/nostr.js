export const EVENTS = "events";
export const TAG_REFS = "tag_refs";
export const ADDRESSES = "addresses";
export const TOMBSTONES = "tombstones";
export const OUTBOX_BOUNDS = "outbox_bounds";
export const WRITE_STORES = [EVENTS, TAG_REFS, ADDRESSES, TOMBSTONES];

export type IDBCursorDirectionLike = "next" | "prev";

export type IDBKeyRangeLike = {
  lower: unknown;
  upper: unknown;
  lowerOpen: boolean;
  upperOpen: boolean;
};

export type IDBCursorLike = {
  value?: unknown;
  key: unknown;
  primaryKey: unknown;
  continue(): void;
};

export type IDBIndexLike = {
  openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
  openKeyCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
};

export type IDBRequestLike = {
  result: unknown;
  error: Error | null;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type IDBObjectStoreLike = {
  put(value: unknown): unknown;
  get(key: string): IDBRequestLike;
  delete(key: string): unknown;
  clear(): unknown;
  getAll(): IDBRequestLike;
  createIndex(name: string, keyPath: string | string[]): IDBIndexLike;
  index(name: string): IDBIndexLike;
  openCursor(range?: IDBKeyRangeLike, direction?: IDBCursorDirectionLike): IDBRequestLike;
};

export type IDBTransactionLike = {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onabort: ((ev: unknown) => void) | null;
  error: Error | null;
  abort(): void;
};

export type IDBDatabaseLike = {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath?: string }): IDBObjectStoreLike;
  transaction(storeNames: string | string[], mode?: "readonly" | "readwrite"): IDBTransactionLike;
  close(): void;
};

export type IDBVersionChangeEventLike = {
  oldVersion: number;
  newVersion: number | null;
  target: { result: IDBDatabaseLike; transaction: IDBTransactionLike };
};

export type IDBFactoryLike = {
  open(name: string, version?: number): IDBOpenRequestLike;
};

export type IDBOpenRequestLike = IDBRequestLike & {
  onupgradeneeded: ((ev: IDBVersionChangeEventLike) => void) | null;
  result: IDBDatabaseLike;
};

export type TagRef = {
  key: string;
  name: string;
  value: string;
  id: string;
  created_at: number;
};

export type AddressRow = {
  address: string;
  id: string;
  created_at: number;
};

export type Tombstone =
  | { key: `id:${string}`; type: "id" }
  | { key: `pending:${string}`; type: "pending"; pubkey: string }
  | { key: `coord:${string}`; type: "coord"; until: number };

export type OutboxBoundRow = { key: string; oldest: number; newest: number };
