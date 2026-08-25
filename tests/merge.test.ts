import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MergeError } from '../src/errors.ts';
import { championStrategy, pickTailStrategy } from '../src/merge.ts';
import type { MergeManyStrategy, MergeStrategy } from '../src/merge.ts';
import { DEFAULT_BRANCH, Repository } from '../src/repo.ts';
import type { TrajectoryEvent } from '../src/types.ts';

function msg(text: string, at: number): TrajectoryEvent {
  return { kind: 'message', at, actor: 'user', payload: { text } };
}

function texts(materialized: Array<{ event: TrajectoryEvent }>): string[] {
  return materialized.map((m) => (m.event.payload as { text: string }).text);
}

async function forkedRepo(): Promise<{ repo: Repository; forkPoint: string }> {
  const repo = Repository.inMemory();
  const forkPoint = await repo.append([msg('root', 1)]);
  return { repo, forkPoint };
}

test('merging a descendant fast-forwards; merging an ancestor is a no-op', async () => {
  const { repo } = await forkedRepo();
  await repo.fork('feature');
  const featureTip = await repo.append([msg('feature-work', 2)]);

  await repo.checkout(DEFAULT_BRANCH);
  const ff = await repo.merge('feature');
  assert.equal(ff.kind, 'fast-forward');
  assert.equal(ff.id, featureTip);
  assert.equal(await repo.head(), featureTip);

  const noop = await repo.merge('feature');
  assert.equal(noop.kind, 'already-up-to-date');

  // merging an ancestor of HEAD is also up to date
  await repo.append([msg('later', 3)]);
  const ancestor = await repo.merge(featureTip);
  assert.equal(ancestor.kind, 'already-up-to-date');
});

test('interleave merge weaves both tails by timestamp above the base', async () => {
  const { repo, forkPoint } = await forkedRepo();
  await repo.append([msg('ours-10', 10), msg('ours-30', 30)]);

  await repo.branch('theirs-branch', forkPoint);
  await repo.checkout('theirs-branch');
  await repo.append([msg('theirs-20', 20)]);

  await repo.checkout(DEFAULT_BRANCH);
  const result = await repo.merge('theirs-branch', { meta: { label: 'weave' } });
  assert.equal(result.kind, 'merge');

  assert.deepEqual(texts(await repo.materialize()), ['root', 'ours-10', 'theirs-20', 'ours-30']);

  const { step } = await repo.getStep(result.id);
  assert.equal(step.parents.length, 2);
  assert.equal(step.base, forkPoint);
  assert.equal(step.meta.label, 'weave');
});

test('events present on both sides are kept once (content addressing)', async () => {
  const { repo, forkPoint } = await forkedRepo();
  const shared = msg('shared', 5);
  await repo.append([shared, msg('ours-only', 10)]);

  await repo.branch('twin', forkPoint);
  await repo.checkout('twin');
  await repo.append([shared, msg('theirs-only', 20)]);

  await repo.checkout(DEFAULT_BRANCH);
  await repo.merge('twin');
  assert.deepEqual(texts(await repo.materialize()), ['root', 'shared', 'ours-only', 'theirs-only']);
});

test('deliberate repeats within one side survive the merge', async () => {
  const { repo, forkPoint } = await forkedRepo();
  const repeated = msg('same command run twice', 10);
  // ours repeats an identical event twice; theirs does not have it at all
  await repo.append([repeated]);
  await repo.append([repeated]);

  await repo.branch('other', forkPoint);
  await repo.checkout('other');
  await repo.append([msg('theirs-only', 20)]);

  await repo.checkout(DEFAULT_BRANCH);
  await repo.merge('other');
  assert.deepEqual(texts(await repo.materialize()), [
    'root',
    'same command run twice',
    'same command run twice',
    'theirs-only',
  ]);
});

test('shared events collapse pairwise: min(m, n) copies are removed', async () => {
  const { repo, forkPoint } = await forkedRepo();
  const shared = msg('shared', 5);
  // ours has the shared event twice, theirs once → exactly one pair collapses
  await repo.append([shared, shared, msg('ours-only', 10)]);

  await repo.branch('twin', forkPoint);
  await repo.checkout('twin');
  await repo.append([shared, msg('theirs-only', 20)]);

  await repo.checkout(DEFAULT_BRANCH);
  await repo.merge('twin');
  assert.deepEqual(texts(await repo.materialize()), [
    'root',
    'shared',
    'shared',
    'ours-only',
    'theirs-only',
  ]);
});

test('ours / theirs strategies discard the other tail', async () => {
  for (const [strategy, expected] of [
    ['ours', ['root', 'mine']],
    ['theirs', ['root', 'yours']],
  ] as const) {
    const { repo, forkPoint } = await forkedRepo();
    await repo.append([msg('mine', 10)]);
    await repo.branch('other', forkPoint);
    await repo.checkout('other');
    await repo.append([msg('yours', 20)]);
    await repo.checkout(DEFAULT_BRANCH);
    const result = await repo.merge('other', { strategy });
    assert.equal(result.kind, 'merge');
    assert.deepEqual(texts(await repo.materialize()), expected);
  }
});

test('a custom strategy can synthesize brand-new events', async () => {
  const { repo, forkPoint } = await forkedRepo();
  await repo.append([msg('approach-a', 10)]);
  await repo.branch('b', forkPoint);
  await repo.checkout('b');
  await repo.append([msg('approach-b', 20)]);
  await repo.checkout(DEFAULT_BRANCH);

  const summarize: MergeStrategy = ({ base, ours, theirs }) => {
    assert.deepEqual(texts([...base]), ['root']);
    assert.deepEqual(texts([...ours]), ['approach-a']);
    assert.deepEqual(texts([...theirs]), ['approach-b']);
    return [
      {
        kind: 'annotation',
        at: 30,
        actor: 'merge-bot',
        payload: { text: 'both approaches agree' },
      },
    ];
  };
  await repo.merge('b', { strategy: summarize });
  assert.deepEqual(texts(await repo.materialize()), ['root', 'both approaches agree']);
});

test('merge continues correctly after a merge (base is the previous merge step)', async () => {
  const { repo, forkPoint } = await forkedRepo();
  await repo.append([msg('a1', 10)]);
  await repo.branch('side', forkPoint);
  await repo.checkout('side');
  await repo.append([msg('b1', 20)]);
  await repo.checkout(DEFAULT_BRANCH);
  const first = await repo.merge('side');

  // diverge again after the merge
  await repo.append([msg('a2', 40)]);
  await repo.branch('side2', first.id);
  await repo.checkout('side2');
  await repo.append([msg('b2', 30)]);
  await repo.checkout(DEFAULT_BRANCH);

  const second = await repo.merge('side2');
  assert.equal(second.kind, 'merge');
  const { step } = await repo.getStep(second.id);
  assert.equal(step.base, first.id);
  assert.deepEqual(texts(await repo.materialize()), ['root', 'a1', 'b1', 'b2', 'a2']);
});

test('merge rejects unknown builtin strategy names and unborn HEAD', async () => {
  const { repo, forkPoint } = await forkedRepo();
  await repo.branch('x', forkPoint);
  await repo.checkout('x');
  await repo.append([msg('diverge-x', 10)]);
  await repo.checkout(DEFAULT_BRANCH);
  await repo.append([msg('diverge-main', 20)]);
  await assert.rejects(
    repo.merge('x', { strategy: 'nonsense' as never }),
    MergeError,
  );

  const empty = Repository.inMemory();
  await assert.rejects(empty.merge('anything'), MergeError);
});

/** main + three agent branches forked at the same point, one finding each. */
async function explorationRepo(): Promise<{ repo: Repository; forkPoint: string }> {
  const repo = Repository.inMemory();
  const forkPoint = await repo.append([msg('task', 1)]);
  for (const [i, name] of ['agent-1', 'agent-2', 'agent-3'].entries()) {
    await repo.branch(name, forkPoint);
    await repo.checkout(name);
    await repo.append([
      { kind: 'message', at: 10 + i, actor: name, payload: { text: `${name}-raw` } },
      { kind: 'annotation', at: 20 + i, actor: name, payload: { text: `${name}-finding` } },
    ]);
  }
  await repo.checkout(DEFAULT_BRANCH);
  return { repo, forkPoint };
}

test('mergeMany folds three branches into one step with all parents recorded', async () => {
  const { repo, forkPoint } = await explorationRepo();
  const result = await repo.mergeMany(['agent-1', 'agent-2', 'agent-3'], { meta: { label: 'fan-in' } });
  assert.equal(result.kind, 'merge');

  const { step } = await repo.getStep(result.id);
  assert.equal(step.parents.length, 4, 'HEAD plus three targets');
  assert.equal(step.base, forkPoint);

  // interleave (default): everything woven by timestamp
  assert.deepEqual(texts(await repo.materialize()), [
    'task',
    'agent-1-raw',
    'agent-2-raw',
    'agent-3-raw',
    'agent-1-finding',
    'agent-2-finding',
    'agent-3-finding',
  ]);
});

test('mergeMany with conclusions keeps only annotations from every tail', async () => {
  const { repo } = await explorationRepo();
  await repo.mergeMany(['agent-1', 'agent-2', 'agent-3'], { strategy: 'conclusions' });
  assert.deepEqual(texts(await repo.materialize()), [
    'task',
    'agent-1-finding',
    'agent-2-finding',
    'agent-3-finding',
  ]);
});

test('pickTailStrategy keeps the winner only; championStrategy salvages conclusions', async () => {
  const picked = await explorationRepo();
  await picked.repo.mergeMany(['agent-1', 'agent-2', 'agent-3'], { strategy: pickTailStrategy(2) });
  assert.deepEqual(texts(await picked.repo.materialize()), ['task', 'agent-2-raw', 'agent-2-finding']);

  const champ = await explorationRepo();
  await champ.repo.mergeMany(['agent-1', 'agent-2', 'agent-3'], { strategy: championStrategy(2) });
  assert.deepEqual(texts(await champ.repo.materialize()), [
    'task',
    'agent-2-raw',
    'agent-2-finding',
    'agent-1-finding',
    'agent-3-finding',
  ]);

  const bad = await explorationRepo();
  await assert.rejects(bad.repo.mergeMany(['agent-1'], { strategy: pickTailStrategy(9) }), MergeError);
});

test('mergeMany fast-forwards a lone descendant target with the default strategy', async () => {
  const { repo } = await forkedRepo();
  await repo.fork('feature');
  const tip = await repo.append([msg('feature-work', 2)]);
  await repo.checkout(DEFAULT_BRANCH);

  const ff = await repo.mergeMany(['feature']);
  assert.equal(ff.kind, 'fast-forward');
  assert.equal(ff.id, tip);
  assert.equal(await repo.head(), tip);

  // allowFastForward: false records a merge step with the same context
  await repo.branch('feature-2');
  await repo.append([msg('more', 3)], {}, { branch: 'feature-2' });
  const noFf = await repo.mergeMany(['feature-2'], { allowFastForward: false });
  assert.equal(noFf.kind, 'merge');
  assert.deepEqual(texts(await repo.materialize()), ['root', 'feature-work', 'more']);
});

test('mergeMany with a filtering strategy records a merge step even for a lone descendant', async () => {
  const { repo } = await forkedRepo();
  await repo.fork('explore');
  await repo.append([
    msg('noise', 2),
    { kind: 'annotation', at: 3, actor: 'assistant', payload: { text: 'finding' } },
  ]);
  await repo.checkout(DEFAULT_BRANCH);

  const result = await repo.mergeMany(['explore'], { strategy: 'conclusions' });
  assert.equal(result.kind, 'merge', 'conclusions must run instead of fast-forwarding');
  assert.deepEqual(texts(await repo.materialize()), ['root', 'finding']);
});

test('mergeMany skips duplicates, HEAD, and already-merged targets', async () => {
  const { repo } = await explorationRepo();
  await repo.mergeMany(['agent-1', 'agent-1', DEFAULT_BRANCH, 'agent-2']);
  const { step } = await repo.getStep('HEAD');
  assert.equal(step.parents.length, 3, 'duplicate and self targets dropped');

  const noop = await repo.mergeMany(['agent-1', 'agent-2']);
  assert.equal(noop.kind, 'already-up-to-date', 'ancestors are already merged');
});

test('a custom judge strategy sees HEAD as tails[0] and all targets after it', async () => {
  const { repo } = await explorationRepo();
  await repo.append([{ kind: 'annotation', at: 5, actor: 'coordinator', payload: { text: 'main-note' } }]);

  const judge: MergeManyStrategy = ({ base, tails }) => {
    assert.deepEqual(texts([...base]), ['task']);
    assert.equal(tails.length, 4);
    assert.deepEqual(texts([...(tails[0] ?? [])]), ['main-note']);
    // "score" each target tail by actor number, keep the best, cite the rest
    return [
      ...(tails[3] ?? []).map((m) => m.event),
      { kind: 'annotation', at: 99, actor: 'judge', payload: { text: 'agent-3 wins; others archived' } },
    ];
  };
  await repo.mergeMany(['agent-1', 'agent-2', 'agent-3'], { strategy: judge });
  assert.deepEqual(texts(await repo.materialize()), [
    'task',
    'agent-3-raw',
    'agent-3-finding',
    'agent-3 wins; others archived',
  ]);
});

test('mergeBase finds the fork point across branch topologies', async () => {
  const { repo, forkPoint } = await forkedRepo();
  const a = await repo.append([msg('a', 10)]);
  await repo.branch('side', forkPoint);
  await repo.checkout('side');
  const b = await repo.append([msg('b', 20)]);

  assert.equal(await repo.mergeBase(a, b), forkPoint);
  assert.equal(await repo.mergeBase(a, forkPoint), forkPoint);
  assert.equal(await repo.mergeBase(a, a), a);
});
