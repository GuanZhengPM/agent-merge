import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/hash.ts';
import { hashText, recordValue, redactJson, redactText } from '../src/privacy.ts';

test('generic redaction removes common credentials and machine-specific home paths', () => {
  const text = redactText('Authorization: Bearer abc.def token=secret /Users/alice/project C:\\Users\\bob\\repo');
  assert.doesNotMatch(text, /abc\.def|token=secret|alice|bob/);
  assert.match(text, /Bearer \[REDACTED\]/);
  assert.match(text, /token=\[REDACTED\]/);
  assert.match(text, /\$HOME/);
});

test('structured redaction masks sensitive keys recursively', () => {
  assert.deepEqual(redactJson({ api_key: 'value', nested: { password: 'value', ok: 'kept' } }), {
    api_key: '[REDACTED]',
    nested: { password: '[REDACTED]', ok: 'kept' },
  });
});

test('summary recording keeps only a stable digest', () => {
  const value = { text: 'private output' };
  assert.deepEqual(recordValue(value, 'summary'), {
    omitted: true,
    sha256: hashText(canonicalJson(value)),
  });
  assert.deepEqual(recordValue(value, 'full'), value);
});
