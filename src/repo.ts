import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  AmbiguousRefError,
  BisectRangeError,
  CorruptObjectError,
  InvalidObjectError,
  MergeError,
  ObjectNotFoundError,
  RefNotFoundError,
  RepositoryExistsError,
  RepositoryNotFoundError,
  AgentMergeError,
} from './errors.ts';
import { pathExists } from './fsutil.ts';
import { decodeObject, encodeObject } from './hash.ts';
import type { ObjectType } from './hash.ts';
import { builtinManyStrategies, builtinStrategies } from './merge.ts';
import type {
  BuiltinManyStrategyName,
  BuiltinStrategyName,
  MergeManyStrategy,
  MergeStrategy,
} from './merge.ts';
import { FsRefStore } from './refs/fs-ref-store.ts';
import { DEFAULT_BRANCH } from './refs/ref-store.ts';
import { MemoryRefStore, assertRefName } from './refs/ref-store.ts';
import type { Head, RefStore } from './refs/ref-store.ts';
import { FsObjectStore } from './store/fs-store.ts';
import { MemoryObjectStore } from './store/object-store.ts';
import type { ObjectStore } from './store/object-store.ts';
import { assertStep, assertTrajectoryEvent, isObjectId } from './types.ts';
import type { MaterializedEvent, ObjectId, Step, StepMeta, TrajectoryEvent } from './types.ts';

export { DEFAULT_BRANCH } from './refs/ref-store.ts';

const AGENT_MERGE_DIR = '.agent-merge';
const MIN_PREFIX = 4;

/** Options for {@link Repository.append}. */
export interface AppendOptions {
  /** Target branch (created if absent). Default: follow HEAD. */
  branch?: string;
}

/** One entry of `Repository.log()`. */
export interface LogEntry {
  readonly id: ObjectId;
  readonly step: Step;
}

/** The two divergent tails of a pair of steps, relative to their merge base. */
export interface Diff {
  readonly baseId: ObjectId | null;
  readonly ours: MaterializedEvent[];
  readonly theirs: MaterializedEvent[];
}

export interface MergeOptions {
  /** A builtin strategy name or a custom function. Default: `interleave`. */
  strategy?: MergeStrategy | BuiltinStrategyName;
  meta?: StepMeta;
  /** Move the branch pointer instead of creating a step when possible. Default: true. */
  allowFastForward?: boolean;
}

export type MergeKind = 'merge' | 'fast-forward' | 'already-up-to-date';

export interface MergeResult {
  readonly id: ObjectId;
  readonly kind: MergeKind;
}

export interface MergeManyOptions {
  /** A builtin N-way strategy name or a custom function. Default: `interleave`. */
  strategy?: MergeManyStrategy | BuiltinManyStrategyName;
  meta?: StepMeta;
}

/** Handed to a bisect predicate for each probed step. */
export interface BisectProbe {
  readonly id: ObjectId;
  readonly step: Step;
  /** Position on the good→bad chain (0 = good endpoint). */
  readonly index: number;
  /** Materialize the full context at this step. */
  context(): Promise<MaterializedEvent[]>;
}

/** Return `true` if the probed step is still good. */
export type BisectPredicate = (probe: BisectProbe) => boolean | Promise<boolean>;

export interface BisectResult {
  readonly firstBadId: ObjectId;
  readonly firstBad: Step;
  /** Position of the first bad step on the good→bad chain. */
  readonly index: number;
  /** The events that step introduced — the prime suspects. */
  readonly introduced: MaterializedEvent[];
  /** How many times the predicate ran. */
  readonly probes: number;
}

/**
 * A agent-merge repository: an append-only, content-addressed DAG of agent session
 * steps, plus mutable branch refs — git's object model, re-derived for agent
 * trajectories instead of file trees.
 *
 * The core invariant is deterministic materialization: the model-visible
 * context at any step is a pure function of the DAG. Linear steps concatenate
 * their events onto the parent's context; a merge step records the resolved
 * segment that extends its stored `base`.
 */
export class Repository {
  readonly #objects: ObjectStore;
  readonly #refs: RefStore;

  private constructor(objects: ObjectStore, refs: RefStore) {
    this.#objects = objects;
    this.#refs = refs;
  }

  /** A repository backed entirely by memory — for tests and embedding. */
  static inMemory(): Repository {
    return new Repository(new MemoryObjectStore(), new MemoryRefStore());
  }

  /** Create a new repository in `dir/.agent-merge`. */
  static async init(dir: string): Promise<Repository> {
    const root = join(resolvePath(dir), AGENT_MERGE_DIR);
    if (await pathExists(root)) {
      throw new RepositoryExistsError(`repository already exists at ${root}`);
    }
    await mkdir(join(root, 'objects'), { recursive: true });
    await mkdir(join(root, 'refs', 'heads'), { recursive: true });
    const refs = new FsRefStore(root);
    await refs.writeHead({ kind: 'branch', name: DEFAULT_BRANCH });
    return new Repository(new FsObjectStore(join(root, 'objects')), refs);
  }

  /** Open the repository at `dir` or the nearest ancestor containing `.agent-merge`. */
  static async open(dir: string): Promise<Repository> {
    let current = resolvePath(dir);
    for (;;) {
      const root = join(current, AGENT_MERGE_DIR);
      if (await pathExists(root)) {
        return new Repository(new FsObjectStore(join(root, 'objects')), new FsRefStore(root));
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new RepositoryNotFoundError(
          `no ${AGENT_MERGE_DIR} repository found in ${resolvePath(dir)} or any parent directory`,
        );
      }
      current = parent;
    }
  }

  // ── heads and refs ────────────────────────────────────────────────────────

  /** The step id HEAD points at, or `null` on an unborn branch. */
  async head(): Promise<ObjectId | null> {
    const head = await this.#refs.readHead();
    return head.kind === 'detached' ? head.id : this.#refs.readRef(head.name);
  }

  /** The current branch name, or `null` when HEAD is detached. */
  async currentBranch(): Promise<string | null> {
    const head = await this.#refs.readHead();
    return head.kind === 'branch' ? head.name : null;
  }

  async listBranches(): Promise<ReadonlyMap<string, ObjectId>> {
    return this.#refs.listRefs();
  }

  /** Create branch `name` at `at` (a ref, id, or prefix; default HEAD). */
  async branch(name: string, at?: string): Promise<ObjectId> {
    return this.#refs.withLock(async () => {
      assertRefName(name);
      if ((await this.#refs.readRef(name)) !== null) {
        throw new AgentMergeError(`branch already exists: ${name}`);
      }
      const id = at !== undefined ? await this.resolve(at) : await this.head();
      if (id === null) {
        throw new AgentMergeError('cannot create a branch from an empty history');
      }
      await this.#readStep(id); // a branch must point at a step, never an event
      await this.#refs.writeRef(name, id);
      return id;
    });
  }

  /** {@link branch} + {@link checkout} in one call. */
  async fork(name: string, at?: string): Promise<ObjectId> {
    const id = at !== undefined ? await this.branch(name, at) : await this.branch(name);
    await this.checkout(name);
    return id;
  }

  /**
   * Create a new branch with no history yet and switch to it. The next
   * {@link append} records a fresh root step, so the branch grows an
   * independent timeline (useful for recording unrelated sessions in one
   * repository; merging across roots is supported with a `null` base).
   */
  async checkoutNew(name: string): Promise<void> {
    return this.#refs.withLock(async () => {
      assertRefName(name);
      if ((await this.#refs.readRef(name)) !== null) {
        throw new AgentMergeError(`branch already exists: ${name}`);
      }
      await this.#refs.writeHead({ kind: 'branch', name });
    });
  }

  /**
   * Point HEAD at a branch (by exact name) or detach it at a step (by id or
   * unique prefix). Returns the step id now at HEAD.
   */
  async checkout(target: string): Promise<ObjectId | null> {
    return this.#refs.withLock(async () => {
      const refs = await this.#refs.listRefs();
      if (refs.has(target)) {
        await this.#refs.writeHead({ kind: 'branch', name: target });
        return refs.get(target) as ObjectId;
      }
      const id = await this.resolve(target);
      await this.#readStep(id); // HEAD must point at a step, never an event
      await this.#refs.writeHead({ kind: 'detached', id });
      return id;
    });
  }

  /**
   * Resolve `target` to a step or event id. Accepts `HEAD`, a full id, an
   * exact branch name, or a unique id prefix of at least four hex chars —
   * in that precedence order.
   */
  async resolve(target: string): Promise<ObjectId> {
    if (target === 'HEAD') {
      const id = await this.head();
      if (id === null) throw new RefNotFoundError('HEAD is unborn: no steps yet');
      return id;
    }
    if (isObjectId(target)) {
      if (await this.#objects.has(target)) return target;
      throw new ObjectNotFoundError(target);
    }
    const refs = await this.#refs.listRefs();
    const fromRef = refs.get(target);
    if (fromRef !== undefined) return fromRef;
    if (target.length >= MIN_PREFIX && /^[0-9a-f]+$/.test(target)) {
      const matches: ObjectId[] = [];
      for await (const id of this.#objects.list()) {
        if (id.startsWith(target)) {
          matches.push(id);
          if (matches.length > 1) break;
        }
      }
      if (matches.length === 1) return matches[0] as ObjectId;
      if (matches.length > 1) {
        throw new AmbiguousRefError(`prefix ${JSON.stringify(target)} matches multiple objects`);
      }
    }
    throw new RefNotFoundError(`cannot resolve ${JSON.stringify(target)}`);
  }

  // ── object io ─────────────────────────────────────────────────────────────

  async getStep(target: string): Promise<{ id: ObjectId; step: Step }> {
    const id = await this.resolve(target);
    return { id, step: await this.#readStep(id) };
  }

  async getEvent(id: ObjectId): Promise<TrajectoryEvent> {
    return this.#readEvent(id);
  }

  async #writeEvent(event: TrajectoryEvent): Promise<ObjectId> {
    assertTrajectoryEvent(event);
    return this.#objects.put(encodeObject('event', event));
  }

  async #readEvent(id: ObjectId): Promise<TrajectoryEvent> {
    const { type, body } = decodeObject(await this.#objects.get(id));
    if (type !== 'event') {
      throw new InvalidObjectError(`object ${id} is a ${type}, expected an event`);
    }
    assertTrajectoryEvent(body);
    return body;
  }

  async #writeStep(step: Step): Promise<ObjectId> {
    assertStep(step);
    // Verify every reference exists AND has the right type — a step whose
    // parent is an event blob would brick materialization later.
    for (const id of [...step.parents, ...(step.base ? [step.base] : [])]) {
      await this.#assertObjectType(id, 'step');
    }
    for (const id of step.events) {
      await this.#assertObjectType(id, 'event');
    }
    return this.#objects.put(encodeObject('step', step));
  }

  async #assertObjectType(id: ObjectId, expected: ObjectType): Promise<void> {
    const { type } = decodeObject(await this.#objects.get(id));
    if (type !== expected) {
      throw new InvalidObjectError(`object ${id} is a ${type}, expected a ${expected}`);
    }
  }

  async #readStep(id: ObjectId): Promise<Step> {
    const { type, body } = decodeObject(await this.#objects.get(id));
    if (type !== 'step') {
      throw new InvalidObjectError(`object ${id} is a ${type}, expected a step`);
    }
    assertStep(body);
    return body;
  }

  async #moveHead(id: ObjectId): Promise<void> {
    const head: Head = await this.#refs.readHead();
    if (head.kind === 'branch') {
      await this.#refs.writeRef(head.name, id);
    } else {
      await this.#refs.writeHead({ kind: 'detached', id });
    }
  }

  // ── history ───────────────────────────────────────────────────────────────

  /**
   * Append `events` as a new step and return the step's id.
   *
   * By default the step lands on HEAD. Passing `options.branch` targets that
   * branch directly — atomically, without touching HEAD — which is the safe
   * way for concurrent writers (multiple sessions, multiple processes) to
   * each grow their own branch: a checkout-then-append dance in two calls
   * could interleave with another writer's checkout. A `branch` that does
   * not exist yet is created with this step as its root.
   */
  async append(
    events: readonly TrajectoryEvent[],
    meta: StepMeta = {},
    options: AppendOptions = {},
  ): Promise<ObjectId> {
    if (events.length === 0) {
      throw new AgentMergeError('append requires at least one event');
    }
    if (options.branch !== undefined) assertRefName(options.branch);
    return this.#refs.withLock(async () => {
      const eventIds: ObjectId[] = [];
      for (const event of events) {
        eventIds.push(await this.#writeEvent(event));
      }
      const parent =
        options.branch !== undefined ? await this.#refs.readRef(options.branch) : await this.head();
      const step: Step = { parents: parent === null ? [] : [parent], events: eventIds, meta };
      const id = await this.#writeStep(step);
      if (options.branch !== undefined) {
        await this.#refs.writeRef(options.branch, id);
      } else {
        await this.#moveHead(id);
      }
      return id;
    });
  }

  /** Walk the spine backwards from `from` (default HEAD), newest first. */
  async log(options: { from?: string; limit?: number } = {}): Promise<LogEntry[]> {
    const limit = options.limit ?? Infinity;
    const entries: LogEntry[] = [];
    let current = options.from !== undefined ? await this.resolve(options.from) : await this.head();
    const guard = new Set<ObjectId>();
    while (current !== null && entries.length < limit) {
      if (guard.has(current)) {
        throw new CorruptObjectError(`cycle in step graph at ${current}`);
      }
      guard.add(current);
      const step = await this.#readStep(current);
      entries.push({ id: current, step });
      current = spineParent(step);
    }
    return entries;
  }

  /**
   * Reconstruct the model-visible context at `target` (default HEAD): the
   * ordered event sequence a harness would replay into the model.
   */
  async materialize(target?: string): Promise<MaterializedEvent[]> {
    const headId = target !== undefined ? await this.resolve(target) : await this.head();
    if (headId === null) return [];
    const segments: ObjectId[][] = [];
    let current: ObjectId | null = headId;
    const guard = new Set<ObjectId>();
    while (current !== null) {
      if (guard.has(current)) {
        throw new CorruptObjectError(`cycle in step graph at ${current}`);
      }
      guard.add(current);
      const step: Step = await this.#readStep(current);
      segments.push(step.events);
      current = spineParent(step);
    }
    segments.reverse();
    const context: MaterializedEvent[] = [];
    for (const segment of segments) {
      for (const id of segment) {
        context.push({ id, event: await this.#readEvent(id) });
      }
    }
    return context;
  }

  // ── fork points, diff, merge ──────────────────────────────────────────────

  /**
   * A best common ancestor of two steps: a common ancestor that is not an
   * ancestor of any other common ancestor. `null` when the histories are
   * unrelated. Ties (criss-cross histories) resolve deterministically by id.
   */
  async mergeBase(a: ObjectId, b: ObjectId): Promise<ObjectId | null> {
    return this.mergeBaseAll([a, b]);
  }

  /** {@link mergeBase} generalized to any number of steps. */
  async mergeBaseAll(ids: readonly ObjectId[]): Promise<ObjectId | null> {
    if (ids.length === 0) {
      throw new AgentMergeError('mergeBaseAll requires at least one step');
    }
    const sets: Array<Set<ObjectId>> = [];
    for (const id of ids) {
      sets.push(await this.#ancestors(id));
    }
    let common = [...(sets[0] as Set<ObjectId>)];
    for (const set of sets.slice(1)) {
      common = common.filter((id) => set.has(id));
    }
    if (common.length === 0) return null;

    // Discard every common ancestor that is a strict ancestor of another one.
    const excluded = new Set<ObjectId>();
    const queue: ObjectId[] = [];
    for (const id of common) {
      queue.push(...(await this.#readStep(id)).parents);
    }
    while (queue.length > 0) {
      const id = queue.pop() as ObjectId;
      if (excluded.has(id)) continue;
      excluded.add(id);
      queue.push(...(await this.#readStep(id)).parents);
    }
    const best = common.filter((id) => !excluded.has(id)).sort();
    return best[0] ?? (common.sort()[0] as ObjectId);
  }

  async #ancestors(start: ObjectId): Promise<Set<ObjectId>> {
    const seen = new Set<ObjectId>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const step = await this.#readStep(queue.pop() as ObjectId);
      for (const parent of step.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return seen;
  }

  /** The events unique to each side since the merge base. */
  async diff(oursTarget: string, theirsTarget: string): Promise<Diff> {
    const oursId = await this.resolve(oursTarget);
    const theirsId = await this.resolve(theirsTarget);
    return this.#tails(oursId, theirsId);
  }

  async #tails(oursId: ObjectId, theirsId: ObjectId): Promise<Diff> {
    const baseId = await this.mergeBase(oursId, theirsId);
    const baseContext = baseId === null ? [] : await this.materialize(baseId);
    const tail = (context: MaterializedEvent[]): MaterializedEvent[] =>
      context.slice(commonPrefixLength(baseContext, context));
    return {
      baseId,
      ours: tail(await this.materialize(oursId)),
      theirs: tail(await this.materialize(theirsId)),
    };
  }

  /**
   * Merge `theirs` into HEAD. Fast-forwards when HEAD is an ancestor of
   * `theirs` (unless disabled); otherwise runs the strategy over both tails
   * and records a merge step whose events are the resolved segment.
   */
  async merge(theirsTarget: string, options: MergeOptions = {}): Promise<MergeResult> {
    return this.#refs.withLock(() => this.#mergeLocked(theirsTarget, options));
  }

  async #mergeLocked(theirsTarget: string, options: MergeOptions): Promise<MergeResult> {
    const oursId = await this.head();
    if (oursId === null) {
      throw new MergeError('HEAD is unborn; nothing to merge into');
    }
    const theirsId = await this.resolve(theirsTarget);
    if (oursId === theirsId) {
      return { id: oursId, kind: 'already-up-to-date' };
    }
    const { baseId, ours, theirs } = await this.#tails(oursId, theirsId);
    if (baseId === theirsId) {
      return { id: oursId, kind: 'already-up-to-date' };
    }
    if (baseId === oursId && (options.allowFastForward ?? true)) {
      await this.#moveHead(theirsId);
      return { id: theirsId, kind: 'fast-forward' };
    }

    const strategy = resolveStrategy(options.strategy);
    const baseContext = baseId === null ? [] : await this.materialize(baseId);
    const resolved = await strategy({ base: baseContext, ours, theirs });
    const eventIds: ObjectId[] = [];
    for (const event of resolved) {
      eventIds.push(await this.#writeEvent(event));
    }
    const step: Step = {
      parents: [oursId, theirsId],
      events: eventIds,
      meta: options.meta ?? {},
      base: baseId,
    };
    const id = await this.#writeStep(step);
    await this.#moveHead(id);
    return { id, kind: 'merge' };
  }

  /**
   * Merge any number of branches into HEAD in one step — the N-way merge for
   * multi-agent exploration: fan out one branch per agent, then fold every
   * agent's findings back with a single strategy that sees all tails at
   * once. Targets that are duplicates, HEAD itself, or already merged are
   * skipped; the merge step's parents are HEAD plus every remaining target.
   * Unlike {@link merge} there is no fast-forward: a merge step is always
   * recorded (use `merge` for the two-way case when you want fast-forward).
   */
  async mergeMany(targets: readonly string[], options: MergeManyOptions = {}): Promise<MergeResult> {
    if (targets.length === 0) {
      throw new MergeError('mergeMany requires at least one target');
    }
    return this.#refs.withLock(async () => {
      const oursId = await this.head();
      if (oursId === null) {
        throw new MergeError('HEAD is unborn; nothing to merge into');
      }
      const resolved: ObjectId[] = [];
      for (const target of targets) {
        const id = await this.resolve(target);
        await this.#readStep(id); // targets must be steps
        if (id !== oursId && !resolved.includes(id)) resolved.push(id);
      }
      const oursAncestors = await this.#ancestors(oursId);
      const pending = resolved.filter((id) => !oursAncestors.has(id));
      if (pending.length === 0) {
        return { id: oursId, kind: 'already-up-to-date' as const };
      }

      const baseId = await this.mergeBaseAll([oursId, ...pending]);
      const baseContext = baseId === null ? [] : await this.materialize(baseId);
      const tails: MaterializedEvent[][] = [];
      for (const id of [oursId, ...pending]) {
        const context = await this.materialize(id);
        tails.push(context.slice(commonPrefixLength(baseContext, context)));
      }

      const strategy = resolveManyStrategy(options.strategy);
      const resolvedEvents = await strategy({ base: baseContext, tails });
      const eventIds: ObjectId[] = [];
      for (const event of resolvedEvents) {
        eventIds.push(await this.#writeEvent(event));
      }
      const step: Step = {
        parents: [oursId, ...pending],
        events: eventIds,
        meta: options.meta ?? {},
        base: baseId,
      };
      const id = await this.#writeStep(step);
      await this.#moveHead(id);
      return { id, kind: 'merge' as const };
    });
  }

  // ── bisect ────────────────────────────────────────────────────────────────

  /**
   * Binary-search the spine between a known-good ancestor and a known-bad
   * descendant for the first step whose context turns bad — `git bisect` for
   * context poisoning. The predicate returns `true` while things are good.
   * Endpoints are trusted, not probed.
   */
  async bisect(goodTarget: string, badTarget: string, predicate: BisectPredicate): Promise<BisectResult> {
    const goodId = await this.resolve(goodTarget);
    const badId = await this.resolve(badTarget);
    if (goodId === badId) {
      throw new BisectRangeError('good and bad are the same step');
    }

    const chain: Array<{ id: ObjectId; step: Step }> = [];
    let current: ObjectId | null = badId;
    let found = false;
    while (current !== null) {
      const step: Step = await this.#readStep(current);
      chain.push({ id: current, step });
      if (current === goodId) {
        found = true;
        break;
      }
      current = spineParent(step);
    }
    if (!found) {
      throw new BisectRangeError(`${goodId} is not on the spine of ${badId}`);
    }
    chain.reverse(); // chain[0] = good … chain[last] = bad

    let lo = 0;
    let hi = chain.length - 1;
    let probes = 0;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const { id, step } = chain[mid] as { id: ObjectId; step: Step };
      probes += 1;
      const good = await predicate({
        id,
        step,
        index: mid,
        context: () => this.materialize(id),
      });
      if (good) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    const { id: firstBadId, step: firstBad } = chain[hi] as { id: ObjectId; step: Step };
    const introduced: MaterializedEvent[] = [];
    for (const eventId of firstBad.events) {
      introduced.push({ id: eventId, event: await this.#readEvent(eventId) });
    }
    return { firstBadId, firstBad, index: hi, introduced, probes };
  }
}

/**
 * The parent a step's context builds on: the sole parent for linear steps,
 * the recorded base for merge steps (whose events are the resolved segment).
 */
function spineParent(step: Step): ObjectId | null {
  if (step.parents.length > 1) return step.base ?? null;
  return step.parents[0] ?? null;
}

function commonPrefixLength(a: readonly MaterializedEvent[], b: readonly MaterializedEvent[]): number {
  let i = 0;
  while (i < a.length && i < b.length && (a[i] as MaterializedEvent).id === (b[i] as MaterializedEvent).id) {
    i += 1;
  }
  return i;
}

function resolveManyStrategy(strategy: MergeManyOptions['strategy']): MergeManyStrategy {
  if (strategy === undefined) return builtinManyStrategies.interleave;
  if (typeof strategy === 'function') return strategy;
  const builtin = builtinManyStrategies[strategy];
  if (!builtin) {
    throw new MergeError(
      `unknown N-way merge strategy ${JSON.stringify(strategy)}; expected ` +
        `${Object.keys(builtinManyStrategies).join(', ')} or a function ` +
        `(ours/theirs are two-way only — use pickTailStrategy for N-way picks)`,
    );
  }
  return builtin;
}

function resolveStrategy(strategy: MergeOptions['strategy']): MergeStrategy {
  if (strategy === undefined) return builtinStrategies.interleave;
  if (typeof strategy === 'function') return strategy;
  const builtin = builtinStrategies[strategy];
  if (!builtin) {
    throw new MergeError(
      `unknown merge strategy ${JSON.stringify(strategy)}; expected ${Object.keys(builtinStrategies).join(', ')} or a function`,
    );
  }
  return builtin;
}
