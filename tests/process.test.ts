import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProcess } from '../src/orchestration/process.ts';

test('runProcess terminates a command after its timeout', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    cwd: process.cwd(),
    timeoutMs: 50,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.notEqual(result.status, 0);
});

test('runProcess responds to AbortSignal', async () => {
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    cwd: process.cwd(),
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.notEqual(result.status, 0);
});
