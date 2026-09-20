import { canonicalJson, sha256Hex } from './hash.ts';

export type RecordingMode = 'summary' | 'redacted' | 'full';
export type Redactor = (value: unknown) => unknown;

const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|credential|password|passwd|secret|token|api[_-]?key)(?:$|[_-])/i;

export function hashText(value: string): string {
  return sha256Hex(new TextEncoder().encode(value));
}

export function redactText(value: string, maxLength = 8_000): string {
  const redacted = value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\/Users\/[^/\s]+/g, '$HOME')
    .replace(/\/home\/[^/\s]+/g, '$HOME')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '$HOME');
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}\n… truncated …`;
}

/** Recursively remove common credentials and machine-specific paths from JSON-like values. */
export function redactJson(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactJson(item);
    }
    return output;
  }
  return value;
}

export function recordValue(value: unknown, mode: RecordingMode, redactor: Redactor = redactJson): unknown {
  if (mode === 'full') return value;
  if (mode === 'redacted') return redactor(value);
  return { omitted: true, sha256: hashText(canonicalJson(value)) };
}
