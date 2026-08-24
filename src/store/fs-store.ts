import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CorruptObjectError, ObjectNotFoundError } from '../errors.ts';
import { isErrnoException, pathExists, writeAtomic } from '../fsutil.ts';
import { sha256Hex } from '../hash.ts';
import { assertObjectId, isObjectId } from '../types.ts';
import type { ObjectId } from '../types.ts';
import type { ObjectStore } from './object-store.ts';

const PREFIX_RE = /^[0-9a-f]{2}$/;

/**
 * Filesystem {@link ObjectStore} laid out like git's loose objects:
 * `<root>/<id[0..2]>/<id[2..]>`. Writes are atomic (temp file + rename) and
 * reads verify the content hash, so a corrupted object is detected rather
 * than silently returned.
 */
export class FsObjectStore implements ObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #pathFor(id: ObjectId): string {
    return join(this.#root, id.slice(0, 2), id.slice(2));
  }

  async put(bytes: Uint8Array): Promise<ObjectId> {
    const id = sha256Hex(bytes);
    const path = this.#pathFor(id);
    if (await pathExists(path)) return id;
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, bytes);
    return id;
  }

  async get(id: ObjectId): Promise<Uint8Array> {
    assertObjectId(id);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.#pathFor(id));
    } catch (err) {
      if (isErrnoException(err, 'ENOENT') || isErrnoException(err, 'ENOTDIR')) {
        throw new ObjectNotFoundError(id);
      }
      throw err;
    }
    const actual = sha256Hex(bytes);
    if (actual !== id) {
      throw new CorruptObjectError(`object ${id} hashes to ${actual}; the store is corrupt`);
    }
    return bytes;
  }

  async has(id: ObjectId): Promise<boolean> {
    assertObjectId(id);
    return pathExists(this.#pathFor(id));
  }

  async *list(): AsyncIterable<ObjectId> {
    let prefixes: string[];
    try {
      prefixes = await readdir(this.#root);
    } catch (err) {
      if (isErrnoException(err, 'ENOENT')) return;
      throw err;
    }
    for (const prefix of prefixes) {
      if (!PREFIX_RE.test(prefix)) continue;
      for (const rest of await readdir(join(this.#root, prefix))) {
        const id = prefix + rest;
        if (isObjectId(id)) yield id;
      }
    }
  }
}
