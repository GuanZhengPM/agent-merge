import { Repository, RepositoryNotFoundError } from '@guanzhengpm/agent-merge';
import type { ObjectId, StepMeta, TrajectoryEvent } from '@guanzhengpm/agent-merge';

/**
 * One shared agent-merge repository for the whole harness process.
 *
 * Every operation — recorder appends and tool calls alike — runs through a
 * single promise chain, because `Repository` tracks "which branch is
 * current" as repository state (like git's HEAD): two interleaved
 * checkout-then-append sequences would race. Serializing keeps each
 * checkout+append atomic. Session logs flush in small batches, so the queue
 * stays short.
 */
export class TimelineStore {
  readonly #dir: string;
  readonly #allowNested: boolean;
  #repo: Promise<Repository> | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  /** @param dir Directory whose `.agent-merge/` store is used (created on demand). */
  constructor(dir: string, options: { allowNested?: boolean } = {}) {
    this.#dir = dir;
    this.#allowNested = options.allowNested ?? false;
  }

  #open(): Promise<Repository> {
    if (this.#repo === null) {
      const attempt = Repository.openExact(this.#dir).catch((err) => {
        if (err instanceof RepositoryNotFoundError) {
          return Repository.init(this.#dir, { allowNested: this.#allowNested });
        }
        throw err;
      });
      this.#repo = attempt;
      // A failed open (e.g. transient permission problem) must not poison
      // every later operation — drop the cached attempt so the next call retries.
      attempt.catch(() => {
        if (this.#repo === attempt) this.#repo = null;
      });
    }
    return this.#repo;
  }

  /** Run `fn` with the repository, serialized after all earlier operations. */
  run<T>(fn: (repo: Repository) => Promise<T>): Promise<T> {
    const next = this.#chain.then(() => this.#open()).then(fn);
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** The branch name a dsh session's timeline is recorded on. */
  static branchFor(sessionId: string): string {
    let safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '-');
    if (!/^[A-Za-z0-9]/.test(safe)) safe = `s${safe}`;
    return `dsh/${safe}`;
  }

  /** Append one step of events onto `branch`, creating the branch on first use. */
  recordStep(branch: string, events: readonly TrajectoryEvent[], meta: StepMeta): Promise<ObjectId> {
    // Targeted append never touches HEAD, so recording cannot interfere with
    // whatever branch the timeline tools (or a human with the CLI) are on.
    return this.run(async (repo) => repo.append(events, meta, { branch }));
  }
}
