import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], input?: string): RunResult {
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input: input ?? '',
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
  });
  return { status: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

function ok(cwd: string, args: string[], input?: string): RunResult {
  const result = runCli(cwd, args, input);
  assert.equal(result.status, 0, `agent-merge ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

const event = (text: string, at: number, poison = false): object => ({
  kind: 'message',
  at,
  actor: 'user',
  payload: { text, poison },
});

test('cli end-to-end: init → append → branch → merge → materialize → bisect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-cli-'));
  try {
    ok(dir, ['init']);

    // errors are reported, not thrown as stack traces
    const reinit = runCli(dir, ['init']);
    assert.equal(reinit.status, 1);
    assert.match(reinit.stderr, /already exists/);

    ok(dir, ['append', '--label', 'turn 1'], JSON.stringify([event('root', 1)]));
    ok(dir, ['branch', 'side']);
    ok(dir, ['checkout', 'side']);
    ok(dir, ['append'], JSON.stringify(event('side-work', 20)));
    ok(dir, ['checkout', 'main']);
    ok(dir, ['append'], JSON.stringify(event('main-work', 10)));

    const branches = ok(dir, ['branch']);
    assert.match(branches.stdout, /\* main/);
    assert.match(branches.stdout, /side/);

    const merge = ok(dir, ['merge', 'side', '--strategy', 'interleave', '--label', 'weave']);
    assert.match(merge.stdout, /^merge: HEAD is now /);

    const context = JSON.parse(ok(dir, ['materialize']).stdout) as Array<{ payload: { text: string } }>;
    assert.deepEqual(
      context.map((e) => e.payload.text),
      ['root', 'main-work', 'side-work'],
    );

    const log = ok(dir, ['log']);
    assert.match(log.stdout, /weave.*merge of/);
    assert.match(log.stdout, /turn 1/);

    // poison the context, then let bisect find the culprit via --run
    ok(dir, ['append', '--label', 'fine'], JSON.stringify(event('still fine', 30)));
    ok(dir, ['append', '--label', 'culprit'], JSON.stringify(event('bad tool output', 40, true)));
    ok(dir, ['append', '--label', 'aftermath'], JSON.stringify(event('aftermath', 50)));

    const entries = ok(dir, ['log']).stdout.trim().split('\n');
    const lastGoodShort = (entries.find((line) => line.includes('fine')) as string).split(' ')[0] as string;
    const badShort = (entries[0] as string).split(' ')[0] as string;
    const goodId = ok(dir, ['id', lastGoodShort]).stdout.trim();
    const badId = ok(dir, ['id', badShort]).stdout.trim();

    const probe = `${JSON.stringify(process.execPath)} -e "const fs=require('fs');` +
      `const ctx=JSON.parse(fs.readFileSync(process.env.AGENT_MERGE_CONTEXT,'utf8'));` +
      `process.exit(ctx.some(e=>e.payload.poison)?1:0)"`;
    const bisect = ok(dir, ['bisect', goodId, badId, '--run', probe]);
    assert.match(bisect.stdout, /first bad step:/);
    assert.match(bisect.stdout, /bad tool output/);

    // usage errors exit 2
    const unknown = runCli(dir, ['frobnicate']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown command/);
    const badStrategy = runCli(dir, ['merge', 'side', '--strategy', 'nonsense']);
    assert.equal(badStrategy.status, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cli merge: one unified strategy set for any number of branches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-cli-unified-'));
  try {
    ok(dir, ['init']);
    ok(dir, ['append'], JSON.stringify([event('root', 1)]));

    // conclusions works for a single branch (used to be rejected as N-way only)
    ok(dir, ['branch', 'explore']);
    ok(dir, ['append', '--on', 'explore'], JSON.stringify([
      { kind: 'message', at: 2, actor: 'assistant', payload: { text: 'noise' } },
      { kind: 'annotation', at: 3, actor: 'assistant', payload: { text: 'finding' } },
    ]));
    const conclusions = ok(dir, ['merge', 'explore', '--strategy', 'conclusions']);
    assert.match(conclusions.stdout, /^merge: HEAD is now /);
    let context = JSON.parse(ok(dir, ['materialize']).stdout) as Array<{ payload: { text: string } }>;
    assert.deepEqual(
      context.map((e) => e.payload.text),
      ['root', 'finding'],
    );

    // a plain merge of a lone descendant still fast-forwards
    ok(dir, ['branch', 'ahead']);
    ok(dir, ['append', '--on', 'ahead'], JSON.stringify(event('ahead-work', 4)));
    const ff = ok(dir, ['merge', 'ahead']);
    assert.match(ff.stdout, /^fast-forward: HEAD is now /);

    // theirs keeps only the named branch's tail
    ok(dir, ['branch', 'other']);
    ok(dir, ['append', '--on', 'other'], JSON.stringify(event('their-work', 5)));
    ok(dir, ['append'], JSON.stringify(event('our-work', 6)));
    ok(dir, ['merge', 'other', '--strategy', 'theirs']);
    context = JSON.parse(ok(dir, ['materialize']).stdout) as Array<{ payload: { text: string } }>;
    assert.deepEqual(
      context.map((e) => e.payload.text),
      ['root', 'finding', 'ahead-work', 'their-work'],
    );

    // usage errors exit 2
    const ambiguous = runCli(dir, ['merge', 'ahead', 'other', '--strategy', 'theirs']);
    assert.equal(ambiguous.status, 2);
    assert.match(ambiguous.stderr, /ambiguous with multiple branches/);
    const strayWinner = runCli(dir, ['merge', 'other', '--winner', 'other']);
    assert.equal(strayWinner.status, 2);
    assert.match(strayWinner.stderr, /--winner requires/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cli outside a repository fails with a friendly error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-cli-norepo-'));
  try {
    const result = runCli(dir, ['log']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no \.agent-merge repository/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
