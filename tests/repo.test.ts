import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  RefNotFoundError,
  RepositoryExistsError,
  RepositoryNotFoundError,
  AgentMergeError,
} from '../src/errors.ts';
import { DEFAULT_BRANCH, Repository } from '../src/repo.ts';
import type { TrajectoryEvent } from '../src/types.ts';

function msg(text: string, at: number): TrajectoryEvent {
  return { kind: 'message', at, actor: 'user', payload: { text } };
}

test('init / open round-trip, including from a subdirectory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-repo-'));
  try {
    const repo = await Repository.init(dir);
    const id = await repo.append([msg('hello', 1)]);

    await mkdir(join(dir, 'deep', 'nested'), { recursive: true });
    const reopened = await Repository.open(join(dir, 'deep', 'nested'));
    assert.equal(await reopened.head(), id);
    assert.equal(await reopened.currentBranch(), DEFAULT_BRANCH);

    await assert.rejects(Repository.init(dir), RepositoryExistsError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('open outside any repository fails clearly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-norepo-'));
  try {
    await assert.rejects(Repository.open(dir), RepositoryNotFoundError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('init adopts a report-only metadata directory created by a no-timeline run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-report-only-'));
  try {
    await mkdir(join(dir, '.agent-merge', 'runs'), { recursive: true });
    const repo = await Repository.init(dir);
    assert.equal(repo.projectRoot, dir);
    assert.equal(await repo.currentBranch(), DEFAULT_BRANCH);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nested repositories require explicit opt-in and exact open never walks upward', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-nested-'));
  try {
    const child = join(dir, 'child');
    await mkdir(child, { recursive: true });
    await Repository.init(dir);
    await assert.rejects(Repository.init(child), /refusing to create nested repository/);
    await assert.rejects(Repository.openExact(child), RepositoryNotFoundError);
    const nested = await Repository.init(child, { allowNested: true });
    assert.equal(nested.projectRoot, child);
    assert.deepEqual(await Repository.findRoots(child), [child, dir]);
    assert.equal((await Repository.open(child)).projectRoot, child);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('append builds a linear history that materializes in order', async () => {
  const repo = Repository.inMemory();
  assert.equal(await repo.head(), null);
  assert.deepEqual(await repo.materialize(), []);

  const s1 = await repo.append([msg('one', 1), msg('two', 2)], { label: 'turn 1' });
  const s2 = await repo.append([msg('three', 3)]);

  assert.equal(await repo.head(), s2);
  const log = await repo.log();
  assert.deepEqual(
    log.map((entry) => entry.id),
    [s2, s1],
  );
  assert.equal(log[1]?.step.meta.label, 'turn 1');

  const context = await repo.materialize();
  assert.deepEqual(
    context.map((m) => (m.event.payload as { text: string }).text),
    ['one', 'two', 'three'],
  );
});

test('append validates events and refuses empty steps', async () => {
  const repo = Repository.inMemory();
  await assert.rejects(repo.append([]), AgentMergeError);
  await assert.rejects(
    repo.append([{ kind: 'message', at: 1, actor: 'user', payload: { x: undefined } }]),
    AgentMergeError,
  );
  assert.equal(await repo.head(), null, 'failed append must not move HEAD');
});

test('branch, fork, and checkout maintain independent timelines', async () => {
  const repo = Repository.inMemory();
  const s1 = await repo.append([msg('shared', 1)]);

  await repo.fork('experiment');
  assert.equal(await repo.currentBranch(), 'experiment');
  await repo.append([msg('exp-only', 2)]);

  await repo.checkout(DEFAULT_BRANCH);
  assert.equal(await repo.head(), s1);
  await repo.append([msg('main-only', 3)]);

  const mainTexts = (await repo.materialize()).map((m) => (m.event.payload as { text: string }).text);
  assert.deepEqual(mainTexts, ['shared', 'main-only']);
  const expTexts = (await repo.materialize('experiment')).map(
    (m) => (m.event.payload as { text: string }).text,
  );
  assert.deepEqual(expTexts, ['shared', 'exp-only']);

  await assert.rejects(repo.branch('experiment'), AgentMergeError); // duplicate name
});

test('checkout by id detaches HEAD and append continues from there', async () => {
  const repo = Repository.inMemory();
  const s1 = await repo.append([msg('a', 1)]);
  await repo.append([msg('b', 2)]);

  await repo.checkout(s1);
  assert.equal(await repo.currentBranch(), null);
  assert.equal(await repo.head(), s1);

  const s3 = await repo.append([msg('c', 3)]);
  assert.equal(await repo.head(), s3);
  const texts = (await repo.materialize()).map((m) => (m.event.payload as { text: string }).text);
  assert.deepEqual(texts, ['a', 'c']);

  const branches = await repo.listBranches();
  assert.equal(branches.get(DEFAULT_BRANCH), await repo.resolve(DEFAULT_BRANCH));
});

test('resolve handles HEAD, full ids, refs, prefixes, and failures', async () => {
  const repo = Repository.inMemory();
  const s1 = await repo.append([msg('a', 1)]);

  assert.equal(await repo.resolve('HEAD'), s1);
  assert.equal(await repo.resolve(s1), s1);
  assert.equal(await repo.resolve(DEFAULT_BRANCH), s1);
  assert.equal(await repo.resolve(s1.slice(0, 12)), s1);

  await assert.rejects(repo.resolve('no-such-branch'), RefNotFoundError);
  await assert.rejects(repo.resolve('abc'), RefNotFoundError); // too short for a prefix
  const empty = Repository.inMemory();
  await assert.rejects(empty.resolve('HEAD'), RefNotFoundError);
});

test('getStep and getEvent return typed objects', async () => {
  const repo = Repository.inMemory();
  const s1 = await repo.append([msg('a', 1)], { label: 'first', author: 'tester' });
  const { id, step } = await repo.getStep(DEFAULT_BRANCH);
  assert.equal(id, s1);
  assert.deepEqual(step.meta, { label: 'first', author: 'tester' });
  assert.equal(step.parents.length, 0);
  const event = await repo.getEvent(step.events[0] as string);
  assert.deepEqual(event, msg('a', 1));
});

test('checkoutNew starts an independent root; merging unrelated roots works', async () => {
  const repo = Repository.inMemory();
  await repo.append([msg('main-root', 1)]);

  await repo.checkoutNew('session-a');
  assert.equal(await repo.currentBranch(), 'session-a');
  assert.equal(await repo.head(), null, 'new branch starts unborn');
  const rootA = await repo.append([msg('a-root', 10)]);

  const { step } = await repo.getStep(rootA);
  assert.equal(step.parents.length, 0, 'first append on a new branch is a root');

  // unrelated histories: no common ancestor, merge base is null
  assert.equal(await repo.mergeBase(rootA, await repo.resolve(DEFAULT_BRANCH)), null);
  await repo.checkout(DEFAULT_BRANCH);
  const result = await repo.merge('session-a');
  assert.equal(result.kind, 'merge');
  const merged = await repo.getStep(result.id);
  assert.equal(merged.step.base, null);
  const textsAfter = (await repo.materialize()).map((m) => (m.event.payload as { text: string }).text);
  assert.deepEqual(textsAfter, ['main-root', 'a-root']);

  await assert.rejects(repo.checkoutNew('session-a'), AgentMergeError);
});

test('branch names may use any script (方案A works, as documented)', async () => {
  const repo = Repository.inMemory();
  await repo.append([msg('根', 1)]);
  await repo.fork('方案A');
  await repo.append([msg('中文分支', 2)]);
  await repo.checkout(DEFAULT_BRANCH);
  await repo.fork('план-б');
  await repo.append([msg('кириллица', 3)]);

  assert.deepEqual([...(await repo.listBranches()).keys()].sort(), ['main', 'план-б', '方案A']);
  const texts = (await repo.materialize('方案A')).map((m) => (m.event.payload as { text: string }).text);
  assert.deepEqual(texts, ['根', '中文分支']);
  await repo.checkout(DEFAULT_BRANCH);
  await repo.merge('方案A');
});

test('append with { branch } targets that branch and never touches HEAD', async () => {
  const repo = Repository.inMemory();
  const mainTip = await repo.append([msg('on-main', 1)]);

  // unborn target branch: created with this step as root
  const s1 = await repo.append([msg('recorded-1', 10)], {}, { branch: 'session/x' });
  const s2 = await repo.append([msg('recorded-2', 11)], {}, { branch: 'session/x' });

  assert.equal(await repo.head(), mainTip, 'HEAD must be untouched');
  assert.equal(await repo.currentBranch(), DEFAULT_BRANCH);
  assert.equal((await repo.listBranches()).get('session/x'), s2);
  const { step } = await repo.getStep(s2);
  assert.deepEqual(step.parents, [s1]);
  assert.equal((await repo.getStep(s1)).step.parents.length, 0, 'first targeted append is a root');

  const texts = (await repo.materialize('session/x')).map((m) => (m.event.payload as { text: string }).text);
  assert.deepEqual(texts, ['recorded-1', 'recorded-2']);
});

test('payloads round-trip value-identically; key order normalizes to sorted', async () => {
  const repo = Repository.inMemory();
  const payload = {
    zebra: 'ANSI [31m中文🎋 �',
    alpha: { 'a b': 1, 'ключ': 2, '键': 3 },
  };
  const id = await repo.append([{ kind: 'message', at: 1, actor: 'user', payload }]);
  const back = await repo.getEvent((await repo.getStep(id)).step.events[0] as string);
  // deep-equal: no data loss…
  assert.deepEqual(back.payload, payload);
  // …but serialized key order is canonical (sorted), by design
  assert.deepEqual(Object.keys(back.payload as object), ['alpha', 'zebra']);
});

test('identical events share one blob across branches', async () => {
  const repo = Repository.inMemory();
  await repo.append([msg('root', 1)]);
  await repo.fork('other');
  const sOther = await repo.append([msg('same-content', 5)]);
  await repo.checkout(DEFAULT_BRANCH);
  const sMain = await repo.append([msg('same-content', 5)]);

  const eventOnOther = (await repo.getStep(sOther)).step.events[0];
  const eventOnMain = (await repo.getStep(sMain)).step.events[0];
  assert.equal(eventOnOther, eventOnMain);
});
