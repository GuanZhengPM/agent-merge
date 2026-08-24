import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InvalidRefNameError } from '../src/errors.ts';
import { FsRefStore } from '../src/refs/fs-ref-store.ts';
import { DEFAULT_BRANCH, MemoryRefStore, assertRefName } from '../src/refs/ref-store.ts';
import type { RefStore } from '../src/refs/ref-store.ts';

const SOME_ID = 'a'.repeat(64);
const OTHER_ID = 'b'.repeat(64);

async function withFsRefStore(run: (refs: FsRefStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-merge-refs-'));
  try {
    await mkdir(join(root, 'refs', 'heads'), { recursive: true });
    const refs = new FsRefStore(root);
    await refs.writeHead({ kind: 'branch', name: DEFAULT_BRANCH });
    await run(refs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function exerciseRefStore(refs: RefStore): Promise<void> {
  assert.deepEqual(await refs.readHead(), { kind: 'branch', name: DEFAULT_BRANCH });
  assert.equal(await refs.readRef(DEFAULT_BRANCH), null); // unborn

  await refs.writeRef(DEFAULT_BRANCH, SOME_ID);
  assert.equal(await refs.readRef(DEFAULT_BRANCH), SOME_ID);

  await refs.writeRef('feature/nested/name', OTHER_ID);
  const listed = await refs.listRefs();
  assert.deepEqual(
    [...listed.entries()].sort(),
    [
      ['feature/nested/name', OTHER_ID],
      [DEFAULT_BRANCH, SOME_ID],
    ].sort(),
  );

  await refs.writeHead({ kind: 'detached', id: SOME_ID });
  assert.deepEqual(await refs.readHead(), { kind: 'detached', id: SOME_ID });
}

test('MemoryRefStore round-trips heads and refs', async () => {
  await exerciseRefStore(new MemoryRefStore());
});

test('FsRefStore round-trips heads and refs', async () => {
  await withFsRefStore(async (refs) => exerciseRefStore(refs));
});

test('assertRefName accepts sensible names', () => {
  for (const name of ['main', 'feature/x', 'a.b-c_d', 'v1.2.3', 'user/feature/deep']) {
    assert.doesNotThrow(() => assertRefName(name));
  }
});

test('assertRefName rejects hostile or ambiguous names', () => {
  const bad = ['', 'HEAD', '/x', 'x/', 'a//b', '..', 'a..b', '.hidden', '-flag', 'has space', 'f'.repeat(64)];
  for (const name of bad) {
    assert.throws(() => assertRefName(name), InvalidRefNameError, `expected ${JSON.stringify(name)} to be rejected`);
  }
});
