import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { InvalidObjectError, LockTimeoutError } from '../src/errors.ts';
import { FsRefStore } from '../src/refs/fs-ref-store.ts';
import { DEFAULT_BRANCH, Repository } from '../src/repo.ts';
import type { TrajectoryEvent } from '../src/types.ts';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

function msg(text: string, at: number): TrajectoryEvent {
  return { kind: 'message', at, actor: 'user', payload: { text } };
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-conc-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('parallel appends in one process never lose steps (in-memory)', async () => {
  const repo = Repository.inMemory();
  const ids = await Promise.all(
    Array.from({ length: 20 }, (_, i) => repo.append([msg(`event-${i}`, i)])),
  );
  assert.equal(new Set(ids).size, 20, 'every append must create a distinct step');
  const log = await repo.log({ limit: Infinity });
  assert.equal(log.length, 20, 'no step may be orphaned by a lost HEAD update');
  const context = await repo.materialize();
  assert.equal(context.length, 20);
});

test('parallel appends through two handles on one fs store never lose steps', async () => {
  await withDir(async (dir) => {
    await Repository.init(dir);
    const a = await Repository.open(dir);
    const b = await Repository.open(dir);
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => a.append([msg(`a-${i}`, i)])),
      ...Array.from({ length: 8 }, (_, i) => b.append([msg(`b-${i}`, 100 + i)])),
    ]);
    const fresh = await Repository.open(dir);
    assert.equal((await fresh.log({ limit: Infinity })).length, 16);
  });
});

test('concurrent CLI processes serialize through the on-disk lock', async () => {
  await withDir(async (dir) => {
    const init = spawnSync(process.execPath, [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        import('node:child_process').then(({ execFile }) =>
          new Promise<number>((resolve) => {
            const child = execFile(
              process.execPath,
              [CLI, 'append', '--label', `p${i}`],
              { cwd: dir },
              () => resolve(child.exitCode ?? -1),
            );
            child.stdin?.end(JSON.stringify([msg(`proc-${i}`, i)]));
          }),
        ),
      ),
    );
    assert.deepEqual(results, [0, 0, 0, 0, 0]);
    const repo = await Repository.open(dir);
    assert.equal((await repo.log({ limit: Infinity })).length, 5);
  });
});

test('processes writing distinct branches via { branch } never cross-contaminate', async () => {
  await withDir(async (dir) => {
    await Repository.init(dir);
    const writers = await Promise.all(
      Array.from({ length: 4 }, (_, w) =>
        Repository.open(dir).then(async (repo) => {
          for (let i = 0; i < 6; i++) {
            await repo.append([msg(`w${w}-${i}`, w * 100 + i)], {}, { branch: `writer-${w}` });
          }
          return w;
        }),
      ),
    );
    assert.deepEqual(writers, [0, 1, 2, 3]);
    const fresh = await Repository.open(dir);
    for (let w = 0; w < 4; w++) {
      const context = await fresh.materialize(`writer-${w}`);
      assert.equal(context.length, 6, `writer-${w} must have exactly its own 6 events`);
      assert.ok(
        context.every((m) => ((m.event.payload as { text: string }).text ?? '').startsWith(`w${w}-`)),
        `writer-${w} must only contain its own events`,
      );
    }
  });
});

test('a fresh foreign lock times out; a stale one is stolen', async () => {
  await withDir(async (dir) => {
    const root = join(dir, 'locktest');
    await mkdir(join(root, 'refs', 'heads'), { recursive: true });
    const refs = new FsRefStore(root, { lockTimeoutMs: 150, lockStaleMs: 60_000 });
    await refs.writeHead({ kind: 'branch', name: DEFAULT_BRANCH });

    await mkdir(join(root, 'lock')); // someone else holds the lock
    await assert.rejects(refs.withLock(async () => undefined), LockTimeoutError);

    // age the lock past the stale threshold — it must be stolen, not waited on
    const stealing = new FsRefStore(root, { lockTimeoutMs: 500, lockStaleMs: 100 });
    const old = (Date.now() - 3_600_000) / 1000;
    await utimes(join(root, 'lock'), old, old);
    const ran = await stealing.withLock(async () => 'ran');
    assert.equal(ran, 'ran');
  });
});

test('a crashed writer heals within one call when timeout exceeds staleness', async () => {
  await withDir(async (dir) => {
    const root = join(dir, 'healtest');
    await mkdir(join(root, 'refs', 'heads'), { recursive: true });
    // timeout > stale: a fresh abandoned lock is out-waited and stolen
    const refs = new FsRefStore(root, { lockTimeoutMs: 600, lockStaleMs: 150 });
    await refs.writeHead({ kind: 'branch', name: DEFAULT_BRANCH });
    await mkdir(join(root, 'lock')); // "crashed" writer left this behind
    const ran = await refs.withLock(async () => 'healed');
    assert.equal(ran, 'healed');
  });
});

test('the write lock is released after a failing operation', async () => {
  const repo = Repository.inMemory();
  await assert.rejects(repo.checkout('does-not-exist'));
  await repo.append([msg('still works', 1)]); // would hang forever if the lock leaked
  assert.equal((await repo.log()).length, 1);
});

test('stray files in refs/ (e.g. .DS_Store) do not break listings', async () => {
  await withDir(async (dir) => {
    const repo = await Repository.init(dir);
    await repo.append([msg('x', 1)]);
    await writeFile(join(dir, '.agent-merge', 'refs', 'heads', '.DS_Store'), 'junk');
    await writeFile(join(dir, '.agent-merge', 'refs', 'heads', 'main.swp~'), 'junk');
    const branches = await repo.listBranches();
    assert.deepEqual([...branches.keys()], [DEFAULT_BRANCH]);
    await repo.checkout(DEFAULT_BRANCH); // resolution keeps working too
  });
});

test('HEAD and branches can never point at an event object', async () => {
  const repo = Repository.inMemory();
  const stepId = await repo.append([msg('only', 1)]);
  const eventId = (await repo.getStep(stepId)).step.events[0] as string;

  await assert.rejects(repo.checkout(eventId), InvalidObjectError);
  await assert.rejects(repo.branch('bad', eventId), InvalidObjectError);
  // repository must remain healthy afterwards
  await repo.append([msg('after', 2)]);
  assert.equal((await repo.materialize()).length, 2);
});
