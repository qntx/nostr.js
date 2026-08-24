import { NostrError } from "../core/error.ts";

/** Event-store I/O failure. Message must not include event content. */
export class StorageError extends NostrError {}

export function toStorageError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  if (err instanceof Error) return new StorageError(err.message, { cause: err });
  return new StorageError(String(err));
}
