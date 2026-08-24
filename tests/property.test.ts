import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Repository } from '../src/repo.ts';
import type { TrajectoryEvent } from '../src/types.ts';

/**
 * Property test: drive a repository with a seeded pseudo-random script of
 * appends, forks, checkouts, and merges, and check the invariants that the
 * whole design rests on:
 *
 * 1. Determinism — replaying the identical script in a fresh repository
 *    produces identical step ids everywhere (content addressing is total).
 * 2. Materialization is stable — reading the same step twice gives the same
 *    events.
 * 3. A merge step's context extends its recorded base's context.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Op =
  | { op: 'append'; events: TrajectoryEvent[] }
  | { op: 'fork'; name: string }
  | { op: 'checkout'; index: number }
  | { op: 'merge'; index: number };

function script(seed: number, length: number): Op[] {
  const rand = mulberry32(seed);
  const ops: Op[] = [{ op: 'append', events: [event(rand, 0)] }];
  let branches = 1;
  let clock = 1;
  for (let i = 1; i < length; i++) {
    const roll = rand();
    if (roll < 0.55) {
      const events = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => event(rand, clock++));
      ops.push({ op: 'append', events });
    } else if (roll < 0.7) {
      ops.push({ op: 'fork', name: `b${branches++}` });
    } else if (roll < 0.85) {
      ops.push({ op: 'checkout', index: Math.floor(rand() * branches) });
    } else {
      ops.push({ op: 'merge', index: Math.floor(rand() * branches) });
    }
  }
  return ops;
}

function event(rand: () => number, at: number): TrajectoryEvent {
  return {
    kind: 'message',
    at,
    actor: 'assistant',
    payload: { n: Math.floor(rand() * 1_000_000), text: `payload-${Math.floor(rand() * 1000)}` },
  };
}

const branchName = (index: number): string => (index === 0 ? 'main' : `b${index}`);

async function run(ops: Op[]): Promise<Repository> {
  const repo = Repository.inMemory();
  for (const op of ops) {
    switch (op.op) {
      case 'append':
        await repo.append(op.events);
        break;
      case 'fork':
        await repo.fork(op.name);
        break;
      case 'checkout':
        await repo.checkout(branchName(op.index));
        break;
      case 'merge': {
        const target = branchName(op.index);
        if (target === (await repo.currentBranch())) break;
        await repo.merge(target);
        break;
      }
    }
  }
  return repo;
}

for (const seed of [7, 42, 20260824]) {
  test(`random script (seed ${seed}) upholds the core invariants`, async () => {
    const ops = script(seed, 60);
    const first = await run(ops);
    const second = await run(ops);

    // 1. determinism: identical scripts produce identical ids everywhere
    const firstBranches = await first.listBranches();
    const secondBranches = await second.listBranches();
    assert.deepEqual(
      [...firstBranches.entries()].sort(),
      [...secondBranches.entries()].sort(),
      'every branch tip must be byte-identical across replays',
    );
    assert.equal(await first.head(), await second.head());

    for (const [branch] of firstBranches) {
      // 2. stable materialization
      const once = await first.materialize(branch);
      const twice = await first.materialize(branch);
      assert.deepEqual(once, twice);

      // 3. every merge step's context extends its base's context
      for (const { id, step } of await first.log({ from: branch, limit: Infinity })) {
        if (step.parents.length > 1 && step.base != null) {
          const context = await first.materialize(id);
          const baseContext = await first.materialize(step.base);
          assert.deepEqual(
            context.slice(0, baseContext.length).map((m) => m.id),
            baseContext.map((m) => m.id),
            `merge step ${id} must extend its base`,
          );
        }
      }
    }
  });
}
