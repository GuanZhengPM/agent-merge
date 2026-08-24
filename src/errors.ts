/** Base class for every error thrown by agent-merge. */
export class AgentMergeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A value could not be serialized to canonical JSON (cycle, undefined, NaN, …). */
export class CanonicalJsonError extends AgentMergeError {}

/** The object store has no object with the requested id. */
export class ObjectNotFoundError extends AgentMergeError {
  readonly id: string;

  constructor(id: string) {
    super(`object not found: ${id}`);
    this.id = id;
  }
}

/** Stored bytes do not match their id, or an object fails to decode. */
export class CorruptObjectError extends AgentMergeError {}

/** A decoded object does not satisfy the schema for its type. */
export class InvalidObjectError extends AgentMergeError {}

/** A ref name contains characters or segments agent-merge does not allow. */
export class InvalidRefNameError extends AgentMergeError {}

/** A ref, id, or id prefix could not be resolved. */
export class RefNotFoundError extends AgentMergeError {}

/** An id prefix matches more than one object. */
export class AmbiguousRefError extends AgentMergeError {}

/** No `.agent-merge` repository exists at or above the given directory. */
export class RepositoryNotFoundError extends AgentMergeError {}

/** `Repository.init` was called where a repository already exists. */
export class RepositoryExistsError extends AgentMergeError {}

/** A merge cannot be performed or a strategy misbehaved. */
export class MergeError extends AgentMergeError {}

/** The good/bad endpoints handed to bisect do not form a valid range. */
export class BisectRangeError extends AgentMergeError {}

/** The repository's advisory write lock could not be acquired in time. */
export class LockTimeoutError extends AgentMergeError {}
