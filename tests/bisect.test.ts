import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BisectRangeError } from '../src/errors.ts';
import { DEFAULT_BRANCH, Repository } from '../src/repo.ts';
import type { TrajectoryEvent } from '../src/types.ts';

function step(i: number, poison = false): TrajectoryEvent {
  return { kind: 'tool_result', at: i, actor: 'bash', payload: { i, poison } };
}

async function poisonedHistory(length: number, poisonAt: number): Promise<{ repo: Repository; ids: string[] }> {
  const repo = Repository.inMemory();
  const ids: string[] = [];
  for (let i = 0; i < length; i++) {
    ids.push(await repo.append([step(i, i === poisonAt)], { label: `step ${i}` }));
  }
  return { repo, ids };
}

const isClean = (context: Array<{ event: TrajectoryEvent }>): boolean =>
  !context.some((m) => (m.event.payload as { poison: boolean }).poison);

test('bisect finds the exact step that poisoned the context', async () => {
  const { repo, ids } = await poisonedHistory(16, 9);
  const result = await repo.bisect(ids[0] as string, ids[15] as string, async (probe) =>
    isClean(await probe.context()),
  );
  assert.equal(result.firstBadId, ids[9]);
  assert.equal(result.firstBad.meta.label, 'step 9');
  assert.equal(result.introduced.length, 1);
  assert.deepEqual(result.introduced[0]?.event.payload, { i: 9, poison: true });
  assert.ok(result.probes <= 4, `expected ≤4 probes for 16 steps, ran ${result.probes}`);
});

test('bisect works when the culprit is adjacent to an endpoint', async () => {
  const { repo, ids } = await poisonedHistory(5, 1);
  const early = await repo.bisect(ids[0] as string, ids[4] as string, async (probe) =>
    isClean(await probe.context()),
  );
  assert.equal(early.firstBadId, ids[1]);

  const { repo: repo2, ids: ids2 } = await poisonedHistory(5, 4);
  const late = await repo2.bisect(ids2[0] as string, ids2[4] as string, async (probe) =>
    isClean(await probe.context()),
  );
  assert.equal(late.firstBadId, ids2[4]);
});

test('bisect accepts refs and prefixes as endpoints', async () => {
  const { repo, ids } = await poisonedHistory(8, 3);
  const result = await repo.bisect((ids[0] as string).slice(0, 12), DEFAULT_BRANCH, async (probe) =>
    isClean(await probe.context()),
  );
  assert.equal(result.firstBadId, ids[3]);
});

test('bisect rejects invalid ranges', async () => {
  const { repo, ids } = await poisonedHistory(4, 2);
  await assert.rejects(repo.bisect(ids[0] as string, ids[0] as string, () => true), BisectRangeError);

  // good must lie on bad's spine
  await repo.checkout(ids[0] as string);
  const offSpine = await repo.append([step(99)]);
  await assert.rejects(repo.bisect(offSpine, ids[3] as string, () => true), BisectRangeError);
});

test('bisect probes carry step metadata and chain position', async () => {
  const { repo, ids } = await poisonedHistory(8, 5);
  const seen: number[] = [];
  await repo.bisect(ids[0] as string, ids[7] as string, async (probe) => {
    seen.push(probe.index);
    assert.equal(probe.id, ids[probe.index]);
    assert.equal(probe.step.meta.label, `step ${probe.index}`);
    return isClean(await probe.context());
  });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((i) => i > 0 && i < 7), 'endpoints are trusted, never probed');
});
