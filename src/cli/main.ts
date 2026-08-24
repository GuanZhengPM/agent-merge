#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentMergeError } from '../errors.ts';
import { builtinManyStrategies, builtinStrategies, championStrategy, pickTailStrategy } from '../merge.ts';
import type { BuiltinManyStrategyName, BuiltinStrategyName } from '../merge.ts';
import { CommandEvaluator } from '../orchestration/evaluator.ts';
import { orchestrate } from '../orchestration/orchestrator.ts';
import { resolveAgentRunner } from '../orchestration/runner.ts';
import { CommandCandidateSelector, SmallestPatchSelector } from '../orchestration/selector.ts';
import { Repository } from '../repo.ts';
import type { LogEntry } from '../repo.ts';
import { assertTrajectoryEvent } from '../types.ts';
import type { MaterializedEvent, StepMeta, TrajectoryEvent } from '../types.ts';

const USAGE = `agent-merge — version control for agent sessions

Usage: agent-merge <command> [options]

Commands:
  init                            Create an empty repository in the current directory
  append [--label L] [--file F] [--on BRANCH]
                                  Append events (JSON from stdin or --file) as a new
                                  step on HEAD, or directly on BRANCH (created if absent)
  log [-n N] [ref]                Show step history along the current spine
  branch [name] [--at ref]        List branches, or create one
  checkout <target>               Switch to a branch, or detach HEAD at a step
  materialize [ref] [--pretty]    Print the model-visible context at a step
  diff <a> <b>                    Show events unique to each side since the merge base
  merge <ref> [--strategy S] [--label L]
                                  Merge one branch into HEAD (ours | theirs | interleave)
  merge <ref> <ref> ... [--strategy S] [--winner B] [--label L]
                                  N-way merge into HEAD. Strategies: interleave (keep
                                  everything), conclusions (only annotation events),
                                  pick (winner only, needs --winner), champion (winner
                                  in full + others' conclusions, needs --winner)
  bisect <good> <bad> --run CMD   Find the first step where CMD starts failing;
                                  CMD sees AGENT_MERGE_STEP and AGENT_MERGE_CONTEXT (a JSON file)
  run --task FILE --test CMD [options]
                                  Run coding agents in parallel Git worktrees, evaluate
                                  their patches, repair failed attempts, select a winner,
                                  and apply it. Options:
                                    --agents N              workers (default 3)
                                    --retries N             repair rounds (default 1)
                                    --runner auto|codex|command
                                    --agent-command CMD     generic runner / auto override
                                    --judge-command CMD     reads candidates JSON, prints id
                                    --dry-run               select but do not apply code
                                    --keep-workspaces       preserve temporary worktrees
                                    --no-timeline           skip session timeline recording
                                    --json                  print the full JSON report
  id <target>                     Resolve a ref or prefix to a full id
  help                            Show this message
`;

class UsageError extends AgentMergeError {}

function shortId(id: string): string {
  return id.slice(0, 12);
}

function previewPayload(payload: unknown): string {
  const text = JSON.stringify(payload) ?? 'null';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function formatEvent(m: MaterializedEvent): string {
  const { kind, actor, at } = m.event;
  return `  ${shortId(m.id)}  [${kind}] ${actor} @${at}  ${previewPayload(m.event.payload)}`;
}

function formatLogEntry(entry: LogEntry): string {
  const { id, step } = entry;
  const label = step.meta.label !== undefined ? `  ${step.meta.label}` : '';
  const merge =
    step.parents.length > 1 ? `  (merge of ${step.parents.map(shortId).join(' + ')})` : '';
  return `${shortId(id)}  ${step.events.length} event${step.events.length === 1 ? '' : 's'}${label}${merge}`;
}

function flags<const T extends Record<string, { type: 'string' | 'boolean'; short?: string }>>(
  args: string[],
  options: T,
): { values: Partial<Record<keyof T, string | boolean>>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true });
    return { values: parsed.values as Partial<Record<keyof T, string | boolean>>, positionals: parsed.positionals };
  } catch (cause) {
    throw new UsageError(cause instanceof Error ? cause.message : String(cause));
  }
}

function stringFlag(value: string | boolean | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new UsageError(`--${name} requires a value`);
  return value;
}

function requirePositional(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined) throw new UsageError(`missing required argument <${name}>`);
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseEvents(text: string): TrajectoryEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new UsageError(`input is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    assertTrajectoryEvent(item);
  }
  return items as TrajectoryEvent[];
}

function buildMeta(label: string | undefined, author: string | undefined): StepMeta {
  return { ...(label !== undefined ? { label } : {}), ...(author !== undefined ? { author } : {}) };
}

const openRepo = (): Promise<Repository> => Repository.open(process.cwd());

async function cmdInit(): Promise<void> {
  await Repository.init(process.cwd());
  console.log(`initialized empty agent-merge repository in ${join(process.cwd(), '.agent-merge')}`);
}

async function cmdAppend(args: string[]): Promise<void> {
  const { values } = flags(args, {
    label: { type: 'string', short: 'l' },
    author: { type: 'string' },
    file: { type: 'string', short: 'f' },
    on: { type: 'string' },
  });
  const file = stringFlag(values.file, 'file');
  let text: string;
  if (file !== undefined) {
    try {
      text = await readFile(file, 'utf8');
    } catch (cause) {
      throw new UsageError(`cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  } else {
    text = await readStdin();
  }
  const events = parseEvents(text);
  const repo = await openRepo();
  const on = stringFlag(values.on, 'on');
  const id = await repo.append(
    events,
    buildMeta(stringFlag(values.label, 'label'), stringFlag(values.author, 'author')),
    on !== undefined ? { branch: on } : {},
  );
  const target = on ?? (await repo.currentBranch()) ?? 'detached HEAD';
  console.log(`step ${shortId(id)}  (+${events.length} event${events.length === 1 ? '' : 's'}) on ${target}`);
}

async function cmdLog(args: string[]): Promise<void> {
  const { values, positionals } = flags(args, { n: { type: 'string', short: 'n' } });
  const rawLimit = stringFlag(values.n, 'n');
  const limit = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : 20;
  if (!Number.isInteger(limit) || limit <= 0) throw new UsageError('-n expects a positive integer');
  const repo = await openRepo();
  const options = positionals[0] !== undefined ? { from: positionals[0], limit } : { limit };
  const entries = await repo.log(options);
  if (entries.length === 0) {
    console.log('(no steps yet)');
    return;
  }
  for (const entry of entries) {
    console.log(formatLogEntry(entry));
  }
}

async function cmdBranch(args: string[]): Promise<void> {
  const { values, positionals } = flags(args, { at: { type: 'string' } });
  const repo = await openRepo();
  const name = positionals[0];
  if (name === undefined) {
    const current = await repo.currentBranch();
    const branches = await repo.listBranches();
    if (branches.size === 0 && current !== null) {
      console.log(`* ${current} (unborn)`);
      return;
    }
    for (const [branch, id] of [...branches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`${branch === current ? '*' : ' '} ${branch}  ${shortId(id)}`);
    }
    return;
  }
  const at = stringFlag(values.at, 'at');
  const id = at !== undefined ? await repo.branch(name, at) : await repo.branch(name);
  console.log(`branch ${name} created at ${shortId(id)}`);
}

async function cmdCheckout(args: string[]): Promise<void> {
  const { positionals } = flags(args, {});
  const target = requirePositional(positionals, 0, 'target');
  const repo = await openRepo();
  const id = await repo.checkout(target);
  const branch = await repo.currentBranch();
  console.log(
    branch !== null
      ? `switched to branch ${branch}${id !== null ? ` at ${shortId(id)}` : ' (unborn)'}`
      : `HEAD detached at ${shortId(id as string)}`,
  );
}

async function cmdMaterialize(args: string[]): Promise<void> {
  const { values, positionals } = flags(args, { pretty: { type: 'boolean', short: 'p' } });
  const repo = await openRepo();
  const context = positionals[0] !== undefined ? await repo.materialize(positionals[0]) : await repo.materialize();
  const events = context.map((m) => m.event);
  console.log(values.pretty === true ? JSON.stringify(events, null, 2) : JSON.stringify(events));
}

async function cmdDiff(args: string[]): Promise<void> {
  const { positionals } = flags(args, {});
  const a = requirePositional(positionals, 0, 'a');
  const b = requirePositional(positionals, 1, 'b');
  const repo = await openRepo();
  const diff = await repo.diff(a, b);
  const theirIds = new Set(diff.theirs.map((m) => m.id));
  const ourIds = new Set(diff.ours.map((m) => m.id));
  const onlyOurs = diff.ours.filter((m) => !theirIds.has(m.id));
  const onlyTheirs = diff.theirs.filter((m) => !ourIds.has(m.id));
  console.log(`merge base: ${diff.baseId !== null ? shortId(diff.baseId) : '(none — unrelated histories)'}`);
  console.log(`only in ${a} (${onlyOurs.length}):`);
  for (const m of onlyOurs) console.log(formatEvent(m));
  console.log(`only in ${b} (${onlyTheirs.length}):`);
  for (const m of onlyTheirs) console.log(formatEvent(m));
}

async function cmdMerge(args: string[]): Promise<void> {
  const { values, positionals } = flags(args, {
    strategy: { type: 'string', short: 's' },
    label: { type: 'string', short: 'l' },
    winner: { type: 'string', short: 'w' },
  });
  if (positionals.length === 0) throw new UsageError('missing required argument <ref>');
  const strategy = stringFlag(values.strategy, 'strategy');
  const winner = stringFlag(values.winner, 'winner');
  const label = stringFlag(values.label, 'label');
  const repo = await openRepo();
  const meta = label !== undefined ? { meta: { label } } : {};

  if (positionals.length === 1) {
    if (winner !== undefined) throw new UsageError('--winner only applies when merging multiple branches');
    if (strategy !== undefined && !Object.hasOwn(builtinStrategies, strategy)) {
      throw new UsageError(
        `unknown two-way strategy ${JSON.stringify(strategy)}; expected ${Object.keys(builtinStrategies).join(' | ')}`,
      );
    }
    const result = await repo.merge(positionals[0] as string, {
      ...(strategy !== undefined ? { strategy: strategy as BuiltinStrategyName } : {}),
      ...meta,
    });
    console.log(`${result.kind}: HEAD is now ${shortId(result.id)}`);
    return;
  }

  // N-way merge: HEAD is tail 0, targets follow in the order given.
  let many;
  if (strategy === 'pick' || strategy === 'champion') {
    if (winner === undefined) throw new UsageError(`--strategy ${strategy} requires --winner <branch>`);
    const index = winner === (await repo.currentBranch()) ? 0 : positionals.indexOf(winner) + 1;
    if (index === 0 && winner !== (await repo.currentBranch())) {
      throw new UsageError(`--winner ${JSON.stringify(winner)} must be one of the merged branches (or the current one)`);
    }
    many = strategy === 'pick' ? pickTailStrategy(index) : championStrategy(index);
  } else if (strategy !== undefined) {
    if (!Object.hasOwn(builtinManyStrategies, strategy)) {
      throw new UsageError(
        `unknown N-way strategy ${JSON.stringify(strategy)}; expected ` +
          `${Object.keys(builtinManyStrategies).join(' | ')} | pick | champion`,
      );
    }
    many = strategy as BuiltinManyStrategyName;
  }
  const result = await repo.mergeMany(positionals, {
    ...(many !== undefined ? { strategy: many } : {}),
    ...meta,
  });
  console.log(`${result.kind}: HEAD is now ${shortId(result.id)} (${positionals.length} branches folded in)`);
}

async function cmdBisect(args: string[]): Promise<void> {
  const { values, positionals } = flags(args, { run: { type: 'string' } });
  const good = requirePositional(positionals, 0, 'good');
  const bad = requirePositional(positionals, 1, 'bad');
  const command = stringFlag(values.run, 'run');
  if (command === undefined) throw new UsageError('bisect requires --run <command>');
  const repo = await openRepo();
  const workdir = await mkdtemp(join(tmpdir(), 'agent-merge-bisect-'));
  try {
    const contextPath = join(workdir, 'context.json');
    const result = await repo.bisect(good, bad, async (probe) => {
      const context = await probe.context();
      await writeFile(contextPath, JSON.stringify(context.map((m) => m.event)));
      const child = spawnSync('/bin/sh', ['-c', command], {
        env: { ...process.env, AGENT_MERGE_STEP: probe.id, AGENT_MERGE_CONTEXT: contextPath },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const verdict = child.status === 0;
      console.log(`probe ${shortId(probe.id)} → ${verdict ? 'good' : 'bad'}`);
      return verdict;
    });
    console.log(`first bad step: ${shortId(result.firstBadId)} (${result.probes} probe${result.probes === 1 ? '' : 's'})`);
    console.log('introduced:');
    for (const m of result.introduced) console.log(formatEvent(m));
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function cmdId(args: string[]): Promise<void> {
  const { positionals } = flags(args, {});
  const target = requirePositional(positionals, 0, 'target');
  const repo = await openRepo();
  console.log(await repo.resolve(target));
}

function integerFlag(value: string | boolean | undefined, name: string, fallback: number): number {
  const raw = stringFlag(value, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) throw new UsageError(`--${name} expects an integer`);
  return parsed;
}

async function cmdRun(args: string[]): Promise<void> {
  const { values } = flags(args, {
    task: { type: 'string' },
    test: { type: 'string' },
    agents: { type: 'string' },
    retries: { type: 'string' },
    runner: { type: 'string' },
    'agent-command': { type: 'string' },
    'judge-command': { type: 'string' },
    'dry-run': { type: 'boolean' },
    'keep-workspaces': { type: 'boolean' },
    'no-timeline': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const taskPath = stringFlag(values.task, 'task');
  if (taskPath === undefined) throw new UsageError('run requires --task <file>');
  const testCommand = stringFlag(values.test, 'test');
  if (testCommand === undefined || testCommand.trim() === '') throw new UsageError('run requires --test <command>');
  let task: string;
  try {
    task = await readFile(taskPath, 'utf8');
  } catch (cause) {
    throw new UsageError(`cannot read task file ${taskPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const runnerName = stringFlag(values.runner, 'runner') ?? 'auto';
  if (runnerName !== 'auto' && runnerName !== 'codex' && runnerName !== 'command') {
    throw new UsageError('--runner must be auto, codex, or command');
  }
  const agentCommand = stringFlag(values['agent-command'], 'agent-command');
  const runner = await resolveAgentRunner({
    runner: runnerName,
    ...(agentCommand !== undefined ? { command: agentCommand } : {}),
  });
  const judgeCommand = stringFlag(values['judge-command'], 'judge-command');
  const selector = judgeCommand === undefined
    ? new SmallestPatchSelector()
    : new CommandCandidateSelector(judgeCommand);
  const result = await orchestrate({
    projectDir: process.cwd(),
    task,
    runner,
    evaluator: new CommandEvaluator(testCommand),
    selector,
    agents: integerFlag(values.agents, 'agents', 3),
    retries: integerFlag(values.retries, 'retries', 1),
    apply: values['dry-run'] !== true,
    keepWorkspaces: values['keep-workspaces'] === true,
    timeline: values['no-timeline'] !== true,
  });
  if (values.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`run ${result.runId}: ${result.status}`);
  console.log(`runner: ${result.runner}; evaluator: ${result.evaluator}; selector: ${result.selector}`);
  for (const candidate of result.candidates) {
    console.log(
      `${candidate.id}: ${candidate.passed ? 'passed' : 'failed'}, ` +
      `${candidate.attempts} attempt${candidate.attempts === 1 ? '' : 's'}, ` +
      `${candidate.patch.length} patch bytes, ${candidate.files.length} file${candidate.files.length === 1 ? '' : 's'}`,
    );
  }
  console.log(result.winner === null
    ? 'winner: none (no patch applied)'
    : `winner: ${result.winner}${result.applied ? ' (patch applied)' : ' (dry run)'}`);
  console.log(`report: ${result.reportPath}`);
  if (result.status === 'failed') process.exitCode = 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return command === undefined ? 2 : 0;
      case 'init':
        await cmdInit();
        return 0;
      case 'append':
        await cmdAppend(rest);
        return 0;
      case 'log':
        await cmdLog(rest);
        return 0;
      case 'branch':
        await cmdBranch(rest);
        return 0;
      case 'checkout':
        await cmdCheckout(rest);
        return 0;
      case 'materialize':
        await cmdMaterialize(rest);
        return 0;
      case 'diff':
        await cmdDiff(rest);
        return 0;
      case 'merge':
        await cmdMerge(rest);
        return 0;
      case 'bisect':
        await cmdBisect(rest);
        return 0;
      case 'run':
        await cmdRun(rest);
        return process.exitCode === 1 ? 1 : 0;
      case 'id':
        await cmdId(rest);
        return 0;
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}; run "agent-merge help"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`agent-merge: ${err.message}`);
      return 2;
    }
    if (err instanceof AgentMergeError) {
      console.error(`agent-merge: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('agent-merge: unexpected error:', err);
    process.exitCode = 1;
  },
);
