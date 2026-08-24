import { InvalidRefNameError } from '../errors.ts';
import { assertObjectId, isObjectId } from '../types.ts';
import type { ObjectId } from '../types.ts';

/** The branch a new repository starts on. */
export const DEFAULT_BRANCH = 'main';

/** Where HEAD points: a named branch, or a specific step (detached). */
export type Head = { kind: 'branch'; name: string } | { kind: 'detached'; id: ObjectId };

/**
 * Mutable pointers into the DAG. Branch refs are the only mutable state in a
 * repository — everything else is content-addressed and immutable.
 */
export interface RefStore {
  readHead(): Promise<Head>;
  writeHead(head: Head): Promise<void>;
  /** Resolve a branch name to a step id, or `null` for an unborn branch. */
  readRef(name: string): Promise<ObjectId | null>;
  writeRef(name: string, id: ObjectId): Promise<void>;
  listRefs(): Promise<ReadonlyMap<string, ObjectId>>;
  /**
   * Run `fn` while holding the store's write lock. Every mutating repository
   * operation (append, merge, branch, checkout) runs inside this, so a
   * read-modify-write of HEAD can never interleave with another writer —
   * neither a concurrent call in this process nor another process on the
   * same store.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

const SEGMENT_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/**
 * Validate a branch name: slash-separated segments of letters (any script —
 * `方案A` is as valid as `plan-a`), digits, dots, and dashes, each starting
 * with a letter or digit. Names that could be mistaken for a step id
 * (`HEAD`, 64 hex chars) are rejected so resolution stays unambiguous.
 */
export function assertRefName(name: string): void {
  const valid =
    name.length > 0 &&
    name !== 'HEAD' &&
    !isObjectId(name) &&
    name.split('/').every((segment) => SEGMENT_RE.test(segment) && !segment.includes('..'));
  if (!valid) {
    throw new InvalidRefNameError(`invalid ref name: ${JSON.stringify(name)}`);
  }
}

/** In-memory {@link RefStore}, used by `Repository.inMemory()` and tests. */
export class MemoryRefStore implements RefStore {
  #head: Head = { kind: 'branch', name: DEFAULT_BRANCH };
  readonly #refs = new Map<string, ObjectId>();
  #queue: Promise<unknown> = Promise.resolve();

  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async readHead(): Promise<Head> {
    return this.#head;
  }

  async writeHead(head: Head): Promise<void> {
    if (head.kind === 'branch') {
      assertRefName(head.name);
    } else {
      assertObjectId(head.id);
    }
    this.#head = head;
  }

  async readRef(name: string): Promise<ObjectId | null> {
    assertRefName(name);
    return this.#refs.get(name) ?? null;
  }

  async writeRef(name: string, id: ObjectId): Promise<void> {
    assertRefName(name);
    assertObjectId(id);
    this.#refs.set(name, id);
  }

  async listRefs(): Promise<ReadonlyMap<string, ObjectId>> {
    return new Map(this.#refs);
  }
}
