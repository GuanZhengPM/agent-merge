import { InvalidObjectError } from './errors.ts';

/** Hex-encoded SHA-256 digest identifying an object in the store. */
export type ObjectId = string;

const OBJECT_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Whether `value` is a well-formed object id. Deliberately not a type
 * predicate: `ObjectId` aliases `string`, so a predicate would narrow the
 * negated branch to `never` at string-typed call sites.
 */
export function isObjectId(value: unknown): boolean {
  return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

export function assertObjectId(value: unknown, what = 'object id'): asserts value is ObjectId {
  if (!isObjectId(value)) {
    throw new InvalidObjectError(`invalid ${what}: ${JSON.stringify(value)}`);
  }
}

export const EVENT_KINDS = ['message', 'tool_call', 'tool_result', 'annotation'] as const;

/** The kind of a trajectory event. */
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * The atomic unit of agent history: one message, tool call, tool result, or
 * out-of-band annotation. Events are immutable and content-addressed — two
 * events with identical content share one id, across branches and sessions.
 */
export interface TrajectoryEvent {
  kind: EventKind;
  /**
   * Caller-supplied ordering hint in milliseconds since the epoch. agent-merge never
   * reads the wall clock itself; determinism is the caller's to keep.
   */
  at: number;
  /** Message role (`user`, `assistant`, `system`) or tool name. */
  actor: string;
  /** Arbitrary JSON payload: message content, tool arguments, tool output, … */
  payload: unknown;
}

/** An event paired with its id, as returned by materialization. */
export interface MaterializedEvent {
  readonly id: ObjectId;
  readonly event: TrajectoryEvent;
}

/** Optional descriptive metadata attached to a step. */
export interface StepMeta {
  label?: string;
  author?: string;
}

/**
 * A step is agent-merge's commit: an immutable node in the session DAG.
 *
 * - 0 parents: root step.
 * - 1 parent: a normal step; `events` extend the parent's context.
 * - 2+ parents: a merge step; `events` hold the *resolved* segment that
 *   replaces everything after `base` on both sides, and `base` must be
 *   present (`null` when the histories share no ancestor).
 */
export interface Step {
  parents: ObjectId[];
  events: ObjectId[];
  meta: StepMeta;
  base?: ObjectId | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new InvalidObjectError(`unexpected key ${JSON.stringify(key)} in ${what}`);
    }
  }
}

export function assertTrajectoryEvent(value: unknown): asserts value is TrajectoryEvent {
  if (!isPlainObject(value)) {
    throw new InvalidObjectError('event must be a plain object');
  }
  assertOnlyKeys(value, ['kind', 'at', 'actor', 'payload'], 'event');
  if (!EVENT_KINDS.includes(value['kind'] as EventKind)) {
    throw new InvalidObjectError(
      `event kind must be one of ${EVENT_KINDS.join(', ')}; got ${JSON.stringify(value['kind'])}`,
    );
  }
  if (typeof value['at'] !== 'number' || !Number.isFinite(value['at'])) {
    throw new InvalidObjectError('event "at" must be a finite number');
  }
  if (typeof value['actor'] !== 'string' || value['actor'].length === 0) {
    throw new InvalidObjectError('event "actor" must be a non-empty string');
  }
  if (!('payload' in value) || value['payload'] === undefined) {
    throw new InvalidObjectError('event "payload" is required (use null for none)');
  }
}

export function assertStepMeta(value: unknown): asserts value is StepMeta {
  if (!isPlainObject(value)) {
    throw new InvalidObjectError('step meta must be a plain object');
  }
  assertOnlyKeys(value, ['label', 'author'], 'step meta');
  for (const key of ['label', 'author'] as const) {
    if (key in value && typeof value[key] !== 'string') {
      throw new InvalidObjectError(`step meta ${JSON.stringify(key)} must be a string`);
    }
  }
}

export function assertStep(value: unknown): asserts value is Step {
  if (!isPlainObject(value)) {
    throw new InvalidObjectError('step must be a plain object');
  }
  assertOnlyKeys(value, ['parents', 'events', 'meta', 'base'], 'step');
  const { parents, events } = value;
  if (!Array.isArray(parents)) {
    throw new InvalidObjectError('step "parents" must be an array');
  }
  parents.forEach((id) => assertObjectId(id, 'parent id'));
  if (new Set(parents).size !== parents.length) {
    throw new InvalidObjectError('step "parents" must not contain duplicates');
  }
  if (!Array.isArray(events)) {
    throw new InvalidObjectError('step "events" must be an array');
  }
  events.forEach((id) => assertObjectId(id, 'event id'));
  assertStepMeta(value['meta']);
  const isMerge = parents.length > 1;
  const hasBase = 'base' in value;
  if (isMerge && !hasBase) {
    throw new InvalidObjectError('merge step must record its "base" (null when histories are unrelated)');
  }
  if (!isMerge && hasBase) {
    throw new InvalidObjectError('non-merge step must not have a "base"');
  }
  if (hasBase && value['base'] !== null) {
    assertObjectId(value['base'], 'base id');
  }
}
