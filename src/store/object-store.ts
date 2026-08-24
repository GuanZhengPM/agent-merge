import { ObjectNotFoundError } from '../errors.ts';
import { sha256Hex } from '../hash.ts';
import type { ObjectId } from '../types.ts';

/**
 * Content-addressed blob storage. Ids are the SHA-256 of the stored bytes, so
 * `put` is idempotent and identical content is stored once.
 */
export interface ObjectStore {
  /** Store `bytes` and return their id. A no-op if the object already exists. */
  put(bytes: Uint8Array): Promise<ObjectId>;
  /** Fetch an object's bytes. Throws {@link ObjectNotFoundError} if absent. */
  get(id: ObjectId): Promise<Uint8Array>;
  has(id: ObjectId): Promise<boolean>;
  /** Enumerate every stored id, in no particular order. */
  list(): AsyncIterable<ObjectId>;
}

/** In-memory {@link ObjectStore}, used by `Repository.inMemory()` and tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<ObjectId, Uint8Array>();

  async put(bytes: Uint8Array): Promise<ObjectId> {
    const id = sha256Hex(bytes);
    if (!this.#objects.has(id)) {
      this.#objects.set(id, bytes.slice());
    }
    return id;
  }

  async get(id: ObjectId): Promise<Uint8Array> {
    const bytes = this.#objects.get(id);
    if (!bytes) throw new ObjectNotFoundError(id);
    return bytes.slice();
  }

  async has(id: ObjectId): Promise<boolean> {
    return this.#objects.has(id);
  }

  async *list(): AsyncIterable<ObjectId> {
    yield* this.#objects.keys();
  }
}
