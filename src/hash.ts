import { createHash } from 'node:crypto';
import { CanonicalJsonError, CorruptObjectError } from './errors.ts';

/** The two object types agent-merge stores: trajectory events and DAG steps. */
export type ObjectType = 'event' | 'step';

const HEADER_RE = /^agent-merge (event|step)$/;

/** Hex-encoded SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Serialize a JSON value deterministically: object keys sorted, no
 * insignificant whitespace, `-0` normalized to `0`.
 *
 * Values that JSON cannot represent faithfully are rejected rather than
 * silently coerced, because the result feeds a content hash: `undefined`,
 * functions, symbols, bigints, non-finite numbers, non-plain objects
 * (Date, Map, class instances), and circular references all throw
 * {@link CanonicalJsonError}.
 */
export function canonicalJson(value: unknown): string {
  return writeValue(value, new Set(), '$');
}

function writeValue(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number at ${path}`);
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      // A lone surrogate cannot survive UTF-8 encoding — TextEncoder would
      // silently replace it with U+FFFD, mutating the stored payload. Fail
      // loud instead; callers that must accept arbitrary strings can
      // normalize with String.prototype.toWellFormed() first.
      if (!value.isWellFormed()) {
        throw new CanonicalJsonError(`ill-formed string (lone surrogate) at ${path}`);
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value} at ${path}`);
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalJsonError(`circular reference at ${path}`);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item, i) => writeValue(item, seen, `${path}[${i}]`));
      return `[${parts.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(`non-plain object at ${path}`);
    }
    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) {
        throw new CanonicalJsonError(`undefined value for key ${JSON.stringify(key)} at ${path}`);
      }
      parts.push(`${JSON.stringify(key)}:${writeValue(item, seen, `${path}.${key}`)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Encode an object for storage: a one-line `agent-merge <type>` header followed by
 * the canonical JSON body. The object's id is the SHA-256 of these bytes, so
 * identical content always produces the same id.
 */
export function encodeObject(type: ObjectType, body: unknown): Uint8Array {
  return new TextEncoder().encode(`agent-merge ${type}\n${canonicalJson(body)}`);
}

/** Decode bytes produced by {@link encodeObject}. */
export function decodeObject(bytes: Uint8Array): { type: ObjectType; body: unknown } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new CorruptObjectError('object is not valid UTF-8', { cause });
  }
  const newline = text.indexOf('\n');
  if (newline < 0) {
    throw new CorruptObjectError('object is missing its header line');
  }
  const header = text.slice(0, newline);
  const match = HEADER_RE.exec(header);
  if (!match) {
    throw new CorruptObjectError(`unrecognized object header: ${JSON.stringify(header)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text.slice(newline + 1));
  } catch (cause) {
    throw new CorruptObjectError('object body is not valid JSON', { cause });
  }
  return { type: match[1] as ObjectType, body };
}
