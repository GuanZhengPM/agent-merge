import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Repository } from '../src/repo.ts';
import type { Evaluator } from '../src/orchestration/evaluator.ts';
import { orchestrate } from '../src/orchestration/orchestrator.ts';
import { CallbackAgentRunner } from '../src/orchestration/runner.ts';

function git(cwd: string, args: string[]): string {
  const child = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, `git ${args.join(' ')} failed: ${child.stderr}`);
  return child.stdout.trim();
}

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-orchestrator-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'agent-merge test']);
  git(dir, ['config', 'user.email', 'agent-merge@test.invalid']);
  await writeFile(join(dir, 'solution.txt'), 'bad\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  return dir;
}

const evaluator: Evaluator = {
  name: 'fixture',
  async evaluate(input) {
    const value = await readFile(join(input.workspace, 'solution.txt'), 'utf8');
    const passed = value === 'good\n';
    return {
      passed,
      status: passed ? 0 : 1,
      stdout: passed ? 'accepted' : `expected good, received ${value.trim()}`,
      stderr: '',
      durationMs: 1,
    };
  },
};

test('orchestrator runs injected harness agents, selects the smallest passing patch, and applies it', async () => {
  const dir = await project();
  try {
    const runner = new CallbackAgentRunner('native-subagent-fixture', async (input) => {
      await writeFile(join(input.workspace, 'solution.txt'), input.branch.endsWith('agent-3') ? 'bad\n' : 'good\n');
      if (input.branch.endsWith('agent-2')) await writeFile(join(input.workspace, 'extra.txt'), 'unnecessary\n');
      return { status: 'completed', stdout: 'done', stderr: '', durationMs: 1 };
    });

    const result = await orchestrate({
      projectDir: dir,
      task: 'make solution.txt contain good',
      runner,
      evaluator,
      agents: 3,
      retries: 0,
      apply: true,
    });

    assert.equal(result.status, 'passed');
    assert.equal(result.winner, 'agent-1');
    assert.equal(result.applied, true);
    assert.equal((await readFile(join(dir, 'solution.txt'), 'utf8')).trim(), 'good');
    assert.equal(result.candidates.filter((candidate) => candidate.passed).length, 2);
    assert.equal(result.candidates.find((candidate) => candidate.id === 'agent-3')?.passed, false);
    assert.match(await readFile(result.reportPath, 'utf8'), /native-subagent-fixture/);

    const timeline = await Repository.open(dir);
    const events = (await timeline.materialize()).map((item) => item.event);
    assert.ok(events.some((event) => event.kind === 'tool_call' && event.actor === 'agent-1'));
    assert.ok(events.some((event) => event.kind === 'tool_result' && event.actor === 'agent-1'));
    assert.ok(events.some((event) => event.kind === 'annotation' && event.actor === 'agent-3'));
    assert.ok(!events.some((event) => event.kind === 'tool_call' && event.actor === 'agent-3'));
    assert.match(JSON.stringify(events.at(-1)?.payload), /selected agent-1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('orchestrator defaults to no apply and summary recording', async () => {
  const dir = await project();
  try {
    const runner = new CallbackAgentRunner('summary-fixture', async (input) => {
      await writeFile(join(input.workspace, 'solution.txt'), 'good\n');
      return { status: 'completed', stdout: 'token=private-value', stderr: '', durationMs: 1 };
    });
    const result = await orchestrate({
      projectDir: dir,
      task: 'make solution.txt contain good',
      runner,
      evaluator,
      agents: 1,
      retries: 0,
    });
    assert.equal(result.status, 'passed');
    assert.equal(result.applied, false);
    assert.equal((await readFile(join(dir, 'solution.txt'), 'utf8')).trim(), 'bad');
    assert.equal(result.provenance.recordingMode, 'summary');
    assert.equal(result.candidates[0]?.history[0]?.agent.stdout, '');
    assert.ok(result.candidates[0]?.history[0]?.agent.stdoutHash);
    assert.equal(result.candidates[0]?.patch, '');
    assert.ok(result.candidates[0]?.patchBytes !== 0);
    const persisted = await readFile(result.reportPath, 'utf8');
    assert.doesNotMatch(persisted, /private-value/);
    assert.doesNotMatch(persisted, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(persisted, /"recordingMode": "summary"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('orchestrator enforces agent timeout for an injected native runner', async () => {
  const dir = await project();
  try {
    const runner = new CallbackAgentRunner('slow-native-fixture', async (input) => {
      await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'failed', stdout: '', stderr: 'aborted', durationMs: 100 };
    });
    const result = await orchestrate({
      projectDir: dir,
      task: 'make solution.txt contain good',
      runner,
      evaluator,
      agents: 1,
      retries: 0,
      agentTimeoutMs: 25,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.candidates[0]?.history[0]?.agent.timedOut, true);
    assert.equal(result.applied, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('orchestrator starts a repair round only after every first attempt fails', async () => {
  const dir = await project();
  try {
    const feedbackSeen: string[] = [];
    const runner = new CallbackAgentRunner('repair-fixture', async (input) => {
      if (input.feedback !== undefined) feedbackSeen.push(input.feedback);
      const repaired = input.attempt === 2 && input.branch.endsWith('agent-2');
      await writeFile(join(input.workspace, 'solution.txt'), repaired ? 'good\n' : 'still bad\n');
      return { status: 'completed', stdout: repaired ? 'repaired' : 'attempted', stderr: '', durationMs: 1 };
    });

    const result = await orchestrate({
      projectDir: dir,
      task: 'make solution.txt contain good',
      runner,
      evaluator,
      agents: 2,
      retries: 1,
      apply: true,
    });

    assert.equal(result.status, 'passed');
    assert.equal(result.winner, 'agent-2');
    assert.equal(feedbackSeen.length, 2);
    assert.ok(feedbackSeen.every((feedback) => feedback.includes('Acceptance command failed')));
    assert.ok(result.candidates.every((candidate) => candidate.attempts === 2));
    assert.equal((await readFile(join(dir, 'solution.txt'), 'utf8')).trim(), 'good');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
