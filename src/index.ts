export { DEFAULT_BRANCH, Repository } from './repo.ts';
export type {
  AppendOptions,
  BisectPredicate,
  BisectProbe,
  BisectResult,
  Diff,
  LogEntry,
  MergeKind,
  MergeManyOptions,
  MergeOptions,
  MergeResult,
} from './repo.ts';

export {
  builtinManyStrategies,
  builtinStrategies,
  championStrategy,
  conclusionsStrategy,
  interleaveAllStrategy,
  interleaveStrategy,
  oursStrategy,
  pickTailStrategy,
  theirsStrategy,
} from './merge.ts';
export type {
  BuiltinManyStrategyName,
  BuiltinStrategyName,
  MergeInput,
  MergeManyInput,
  MergeManyStrategy,
  MergeStrategy,
} from './merge.ts';

export {
  EVENT_KINDS,
  assertObjectId,
  assertStep,
  assertStepMeta,
  assertTrajectoryEvent,
  isObjectId,
} from './types.ts';
export type { EventKind, MaterializedEvent, ObjectId, Step, StepMeta, TrajectoryEvent } from './types.ts';

export { canonicalJson, decodeObject, encodeObject, sha256Hex } from './hash.ts';
export type { ObjectType } from './hash.ts';

export { MemoryObjectStore } from './store/object-store.ts';
export type { ObjectStore } from './store/object-store.ts';
export { FsObjectStore } from './store/fs-store.ts';

export { MemoryRefStore, assertRefName } from './refs/ref-store.ts';
export type { Head, RefStore } from './refs/ref-store.ts';
export { FsRefStore } from './refs/fs-ref-store.ts';
export type { FsRefStoreOptions } from './refs/fs-ref-store.ts';

export {
  AmbiguousRefError,
  BisectRangeError,
  CanonicalJsonError,
  CorruptObjectError,
  InvalidObjectError,
  InvalidRefNameError,
  LockTimeoutError,
  MergeError,
  ObjectNotFoundError,
  RefNotFoundError,
  RepositoryExistsError,
  RepositoryNotFoundError,
  AgentMergeError,
} from './errors.ts';
