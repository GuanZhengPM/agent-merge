import { mkdir, readFile, readdir, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CorruptObjectError, InvalidRefNameError, LockTimeoutError, AgentMergeError } from '../errors.ts';
import { isErrnoException, writeAtomic } from '../fsutil.ts';
import { assertObjectId, isObjectId } from '../types.ts';
import type { ObjectId } from '../types.ts';
import { assertRefName } from './ref-store.ts';
import type { Head, RefStore } from './ref-store.ts';

const HEAD_REF_RE = /^ref: refs\/heads\/(.+)$/;

/**
 * How long a writer may wait for the lock before giving up. Deliberately
 * LONGER than the stale threshold: a lock abandoned by a crashed process is
 * then healed within a single call (wait → stale → steal → proceed) instead
 * of surfacing a timeout error first.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
/** A lock older than this is presumed abandoned (crashed process) and stolen. */
const DEFAULT_LOCK_STALE_MS = 10_000;

/** Tuning knobs for {@link FsRefStore}'s advisory lock (mainly for tests). */
export interface FsRefStoreOptions {
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

/**
 * Filesystem {@link RefStore} rooted at the `.agent-merge` directory, mirroring
 * git's layout: `HEAD` holds `ref: refs/heads/<name>` or a raw step id;
 * each branch lives at `refs/heads/<name>`. All writes are atomic.
 */
export class FsRefStore implements RefStore {
  readonly #root: string;
  readonly #lockTimeoutMs: number;
  readonly #lockStaleMs: number;
  #queue: Promise<unknown> = Promise.resolve();

  /** @param root The `.agent-merge` directory. */
  constructor(root: string, options: FsRefStoreOptions = {}) {
    this.#root = root;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  }

  #headPath(): string {
    return join(this.#root, 'HEAD');
  }

  #lockPath(): string {
    return join(this.#root, 'lock');
  }

  /**
   * In-process queue plus an on-disk lock directory (`mkdir` is atomic), so
   * writers in this process and in other processes are both serialized. The
   * lock is advisory and self-healing: one left behind by a crashed process
   * goes stale after {@link DEFAULT_LOCK_STALE_MS} and is stolen. Lock
   * timing uses the wall clock; that never reaches stored content, so the
   * determinism rule holds.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => this.#locked(fn));
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #locked<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      await rmdir(this.#lockPath()).catch(() => undefined);
    }
  }

  async #acquire(): Promise<void> {
    const deadline = Date.now() + this.#lockTimeoutMs;
    for (;;) {
      try {
        await mkdir(this.#lockPath());
        return;
      } catch (err) {
        if (!isErrnoException(err, 'EEXIST')) throw err;
      }
      try {
        const held = await stat(this.#lockPath());
        if (Date.now() - held.mtimeMs > this.#lockStaleMs) {
          await rmdir(this.#lockPath()).catch(() => undefined);
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry immediately
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `could not acquire ${this.#lockPath()} within ${this.#lockTimeoutMs}ms — ` +
            `another process holds the repository lock`,
        );
      }
      await delay(25);
    }
  }

  #refPath(name: string): string {
    return join(this.#root, 'refs', 'heads', ...name.split('/'));
  }

  async readHead(): Promise<Head> {
    let text: string;
    try {
      text = await readFile(this.#headPath(), 'utf8');
    } catch (err) {
      if (isErrnoException(err, 'ENOENT')) {
        throw new AgentMergeError(`repository at ${this.#root} has no HEAD`);
      }
      throw err;
    }
    const trimmed = text.trim();
    const match = HEAD_REF_RE.exec(trimmed);
    if (match) {
      const name = match[1] as string;
      assertRefName(name);
      return { kind: 'branch', name };
    }
    if (isObjectId(trimmed)) {
      return { kind: 'detached', id: trimmed };
    }
    throw new CorruptObjectError(`corrupt HEAD: ${JSON.stringify(trimmed)}`);
  }

  async writeHead(head: Head): Promise<void> {
    let content: string;
    if (head.kind === 'branch') {
      assertRefName(head.name);
      content = `ref: refs/heads/${head.name}\n`;
    } else {
      assertObjectId(head.id);
      content = `${head.id}\n`;
    }
    await writeAtomic(this.#headPath(), content);
  }

  async readRef(name: string): Promise<ObjectId | null> {
    assertRefName(name);
    let text: string;
    try {
      text = await readFile(this.#refPath(name), 'utf8');
    } catch (err) {
      if (isErrnoException(err, 'ENOENT') || isErrnoException(err, 'ENOTDIR')) return null;
      throw err;
    }
    const trimmed = text.trim();
    if (!isObjectId(trimmed)) {
      throw new CorruptObjectError(`corrupt ref ${JSON.stringify(name)}: ${JSON.stringify(trimmed)}`);
    }
    return trimmed;
  }

  async writeRef(name: string, id: ObjectId): Promise<void> {
    assertRefName(name);
    assertObjectId(id);
    const path = this.#refPath(name);
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, `${id}\n`);
  }

  async listRefs(): Promise<ReadonlyMap<string, ObjectId>> {
    const refs = new Map<string, ObjectId>();
    const root = join(this.#root, 'refs', 'heads');
    await this.#collect(root, '', refs);
    return refs;
  }

  async #collect(dir: string, prefix: string, out: Map<string, ObjectId>): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isErrnoException(err, 'ENOENT')) return;
      throw err;
    }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Stray files (.tmp-*, .DS_Store, editor droppings) can never be valid
      // refs — skip them instead of letting one crash the whole listing.
      try {
        assertRefName(name);
      } catch (err) {
        if (err instanceof InvalidRefNameError) continue;
        throw err;
      }
      if (entry.isDirectory()) {
        await this.#collect(join(dir, entry.name), name, out);
      } else {
        const id = await this.readRef(name);
        if (id !== null) out.set(name, id);
      }
    }
  }
}
