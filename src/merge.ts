import { MergeError } from './errors.ts';
import type { MaterializedEvent, TrajectoryEvent } from './types.ts';

/**
 * What a merge strategy sees: the full context at the merge base, plus each
 * side's divergent tail (the events added since the base).
 */
export interface MergeInput {
  readonly base: readonly MaterializedEvent[];
  readonly ours: readonly MaterializedEvent[];
  readonly theirs: readonly MaterializedEvent[];
}

/**
 * Resolves two divergent tails into the single event sequence that will
 * extend the base context. Strategies return plain events; content
 * addressing takes care of identity, so returning an event that already
 * exists reuses its id and returning new content (e.g. an LLM-written
 * summary) creates a new event.
 */
export type MergeStrategy = (
  input: MergeInput,
) => readonly TrajectoryEvent[] | Promise<readonly TrajectoryEvent[]>;

/** Keep our tail, discard theirs. */
export const oursStrategy: MergeStrategy = ({ ours }) => ours.map((m) => m.event);

/** Keep their tail, discard ours. */
export const theirsStrategy: MergeStrategy = ({ theirs }) => theirs.map((m) => m.event);

/**
 * Weave both tails into one timeline ordered by each event's `at`, keeping
 * the original order within each side (ours wins ties). Events present in
 * BOTH tails — same content, therefore same id — represent the same work
 * done on both sides and collapse: for an id occurring m times in ours and n
 * times in theirs, the result keeps max(m, n) copies, so deliberate repeats
 * within one side are preserved. Two-way case of the shared weaving core.
 */
export const interleaveStrategy: MergeStrategy = ({ ours, theirs }) => weave([ours, theirs]);

export const builtinStrategies = {
  ours: oursStrategy,
  theirs: theirsStrategy,
  interleave: interleaveStrategy,
} as const;

export type BuiltinStrategyName = keyof typeof builtinStrategies;

// ── N-way merges ────────────────────────────────────────────────────────────

/**
 * What an N-way merge strategy sees: the full context at the common fork
 * point, plus every branch's divergent tail. `tails[0]` is the receiving
 * branch (HEAD); the rest follow the order the targets were given in.
 */
export interface MergeManyInput {
  readonly base: readonly MaterializedEvent[];
  readonly tails: ReadonlyArray<readonly MaterializedEvent[]>;
}

/**
 * Resolves N divergent tails into the single event sequence that extends the
 * base context. Same contract as {@link MergeStrategy}, generalized: return
 * existing events to keep them (content addressing reuses their ids), or
 * brand-new events (a judge's verdict, an LLM-written synthesis) to create
 * them. This is the extension point for smart multi-agent merges — judge
 * panels, synthesis, tournaments — which are plain functions over this input.
 */
export type MergeManyStrategy = (
  input: MergeManyInput,
) => readonly TrajectoryEvent[] | Promise<readonly TrajectoryEvent[]>;

/**
 * The weaving core shared by the N-way strategies: merge all tails into one
 * timeline ordered by `at` (earlier tail index wins ties, order within each
 * tail preserved). For an id occurring in several tails, the result keeps
 * max-across-tails copies — work every branch did identically collapses to
 * one copy, deliberate repeats within one branch survive.
 */
function weave(tails: ReadonlyArray<readonly MaterializedEvent[]>): TrajectoryEvent[] {
  const allowance = new Map<string, number>();
  for (const tail of tails) {
    const counts = new Map<string, number>();
    for (const m of tail) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
    for (const [id, count] of counts) allowance.set(id, Math.max(allowance.get(id) ?? 0, count));
  }

  const pointers = tails.map(() => 0);
  const emitted = new Map<string, number>();
  const merged: TrajectoryEvent[] = [];
  for (;;) {
    let best = -1;
    for (let t = 0; t < tails.length; t++) {
      const tail = tails[t] as readonly MaterializedEvent[];
      const p = pointers[t] as number;
      if (p >= tail.length) continue;
      if (
        best === -1 ||
        (tail[p] as MaterializedEvent).event.at <
          ((tails[best] as readonly MaterializedEvent[])[pointers[best] as number] as MaterializedEvent).event.at
      ) {
        best = t;
      }
    }
    if (best === -1) break;
    const tail = tails[best] as readonly MaterializedEvent[];
    const next = tail[(pointers[best] as number)] as MaterializedEvent;
    pointers[best] = (pointers[best] as number) + 1;
    const done = emitted.get(next.id) ?? 0;
    if (done < (allowance.get(next.id) ?? 0)) {
      emitted.set(next.id, done + 1);
      merged.push(next.event);
    }
  }
  return merged;
}

const onlyConclusions = (tail: readonly MaterializedEvent[]): MaterializedEvent[] =>
  tail.filter((m) => m.event.kind === 'annotation');

function tailAt(tails: MergeManyInput['tails'], index: number): readonly MaterializedEvent[] {
  const tail = tails[index];
  if (tail === undefined) {
    throw new MergeError(`no tail at index ${index} (merge has ${tails.length})`);
  }
  return tail;
}

/** N-way "keep everything": weave every tail into one timeline. */
export const interleaveAllStrategy: MergeManyStrategy = ({ tails }) => weave(tails);

/**
 * N-way "merge conclusions, not raw history": keep only each tail's
 * `annotation` events — the distilled findings agents wrote down — woven by
 * time. Raw messages and tool traffic stay on their branches for later
 * inspection, so the merged context stays small and never pretends N agents'
 * interleaved histories happened as one linear session. The recommended
 * default for multi-agent fan-in.
 */
export const conclusionsStrategy: MergeManyStrategy = ({ tails }) => weave(tails.map(onlyConclusions));

/**
 * Keep exactly one tail and discard the rest — for when a judge (the calling
 * agent, a heuristic, or an LLM) has already decided which exploration won.
 * Index 0 is the receiving branch.
 */
export function pickTailStrategy(index: number): MergeManyStrategy {
  return ({ tails }) => tailAt(tails, index).map((m) => m.event);
}

/**
 * Winner takes the timeline, the rest still get heard: the chosen tail is
 * kept in full, and every other tail contributes only its `annotation`
 * conclusions, appended after the winner in time order. Use when one
 * exploration clearly won but the losers' findings are worth salvaging.
 */
export function championStrategy(index: number): MergeManyStrategy {
  return ({ tails }) => {
    const winner = tailAt(tails, index).map((m) => m.event);
    const notes = weave(tails.map((tail, t) => (t === index ? [] : onlyConclusions(tail))));
    return [...winner, ...notes];
  };
}

export const builtinManyStrategies = {
  interleave: interleaveAllStrategy,
  conclusions: conclusionsStrategy,
} as const;

export type BuiltinManyStrategyName = keyof typeof builtinManyStrategies;
