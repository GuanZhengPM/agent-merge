import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

function git(cwd: string, args: string[]): void {
  const child = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, `git ${args.join(' ')} failed: ${child.stderr}`);
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

test('run CLI drives a generic agent command through worktree, evaluation, selection, and apply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-run-cli-'));
  try {
    const agent = join(dir, 'fake-agent.mjs');
    const check = join(dir, 'check.mjs');
    await writeFile(join(dir, 'solution.txt'), 'bad\n');
    await writeFile(join(dir, 'task.txt'), 'make solution good\n');
    await writeFile(agent, [
      "import { writeFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      "const good = process.env.AGENT_MERGE_BRANCH?.endsWith('agent-1');",
      "await writeFile(join(process.cwd(), 'solution.txt'), good ? 'good\\n' : 'bad candidate\\n');",
      "process.stdout.write(good ? 'candidate ready' : 'candidate intentionally fails');",
    ].join('\n'));
    await writeFile(check, [
      "import { readFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      "const value = (await readFile(join(process.cwd(), 'solution.txt'), 'utf8')).trim();",
      "process.exit(value === 'good' ? 0 : 1);",
    ].join('\n'));
    git(dir, ['init']);
    git(dir, ['config', 'user.name', 'agent-merge test']);
    git(dir, ['config', 'user.email', 'agent-merge@test.invalid']);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'fixture']);

    const child = spawnSync(process.execPath, [
      CLI,
      'run',
      '--task', 'task.txt',
      '--test', `${quote(process.execPath)} ${quote(check)}`,
      '--runner', 'command',
      '--agent-command', `${quote(process.execPath)} ${quote(agent)}`,
      '--agents', '2',
      '--retries', '0',
      '--apply',
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /agent-1: passed/);
    assert.match(child.stdout, /agent-2: failed/);
    assert.match(child.stdout, /winner: agent-1 \(patch applied\)/);
    assert.equal((await readFile(join(dir, 'solution.txt'), 'utf8')).trim(), 'good');
    const doctor = spawnSync(process.execPath, [CLI, 'doctor'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    });
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run CLI selects without applying unless --apply is explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-merge-run-safe-default-'));
  try {
    const agent = join(dir, 'fake-agent.mjs');
    const check = join(dir, 'check.mjs');
    await writeFile(join(dir, 'solution.txt'), 'bad\n');
    await writeFile(join(dir, 'task.txt'), 'make solution good\n');
    await writeFile(agent, "import { writeFile } from 'node:fs/promises'; await writeFile('solution.txt', 'good\\n');\n");
    await writeFile(check, "import { readFile } from 'node:fs/promises'; process.exit((await readFile('solution.txt','utf8')) === 'good\\n' ? 0 : 1);\n");
    git(dir, ['init']);
    git(dir, ['config', 'user.name', 'agent-merge test']);
    git(dir, ['config', 'user.email', 'agent-merge@test.invalid']);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'fixture']);
    const child = spawnSync(process.execPath, [
      CLI,
      'run',
      '--task', 'task.txt',
      '--test', `${quote(process.execPath)} ${quote(check)}`,
      '--runner', 'command',
      '--agent-command', `${quote(process.execPath)} ${quote(agent)}`,
      '--agents', '1',
      '--retries', '0',
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /winner: agent-1 \(not applied\)/);
    assert.equal((await readFile(join(dir, 'solution.txt'), 'utf8')).trim(), 'bad');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
