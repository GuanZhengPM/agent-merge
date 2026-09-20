#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentMergeError } from '../errors.ts';
import { builtinManyStrategies, championStrategy, pickTailStrategy } from '../merge.ts';
import type { BuiltinManyStrategyName, MergeManyStrategy } from '../merge.ts';
import { CommandEvaluator } from '../orchestration/evaluator.ts';
import { orchestrate } from '../orchestration/orchestrator.ts';
import { resolveAgentRunner } from '../orchestration/runner.ts';
import { CommandCandidateSelector, SmallestPatchSelector } from '../orchestration/selector.ts';
import { Repository } from '../repo.ts';
import type { LogEntry } from '../repo.ts';
import { assertTrajectoryEvent } from '../types.ts';
import type { MaterializedEvent, StepMeta, TrajectoryEvent } from '../types.ts';
import { hashText } from '../privacy.ts';
import type { RecordingMode } from '../privacy.ts';

const USAGE = `agent-merge — version control for agent sessions

Usage: agent-merge <command> [options]

Commands:
  init [--nested]                 Create a repository; nested stores require explicit opt-in
  root                            Print the active repository root
  status                          Summarize HEAD, branches, steps, and event kinds
  doctor                          Audit repository scope, ordering, evidence, and artifacts
  append [--label L] [--file F] [--on BRANCH]
                                  Append events (JSON from stdin or --file) as a new
                                  step on HEAD, or directly on BRANCH (created if absent)
  log [-n N] [ref]                Show step history along the current spine
  branch [name] [--at ref]        List branches, or create one
  checkout <target>               Switch to a branch, or detach HEAD at a step
  materialize [ref] [--pretty]    Print the model-visible context at a step
  diff <a> <b>                    Show events unique to each side since the merge base
  merge <ref> [<ref> ...] [--strategy S] [--winner B] [--label L]
                                  Merge one or more branches into HEAD. Strategies:
                                  interleave (keep everything, default), conclusions
                                  (only annotation events), ours / theirs (keep just
                                  that side; theirs takes a single branch), pick
                                  (winner only, needs --winner), champion (winner in
                                  full + others' conclusions, needs --winner)
  bisect <good> <bad> --run CMD   Find the first step where CMD starts failing;
                                  CMD sees AGENT_MERGE_STEP and AGENT_MERGE_CONTEXT (a JSON file)
  run --task FILE --test CMD [options]
                                  Run coding agents in parallel Git worktrees, evaluate
                                  their patches, repair failed attempts, select a winner,
                                  and optionally apply it. Options:
                                    --agents N              workers (default 3)
                                    --retries N             repair rounds (default 1)
                                    --runner auto|codex|command
                                    --agent-command CMD     generic runner / auto override
                                    --judge-command CMD     reads candidates JSON, prints id
                                    --apply                 apply the selected patch (default: no)
                                    --dry-run               compatibility alias for the safe default
                                    --agent-timeout MS      per agent attempt timeout
                                    --test-timeout MS       per acceptance command timeout
                                    --judge-timeout MS      winner judge timeout
                                    --recording MODE        summary|redacted|full (default summary)
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

async function cmdInit(args: string[]): Promise<void> {
  const { values } = flags(args, { nested: { type: 'boolean' } });
  await Repository.init(process.cwd(), { allowNested: values.nested === true });
  console.log(`initialized empty agent-merge repository in ${join(process.cwd(), '.agent-merge')}`);
}

async function cmdRoot(): Promise<void> {
  const repo = await openRepo();
  if (repo.projectRoot === null) throw new AgentMergeError('in-memory repository has no filesystem root');
  console.log(repo.projectRoot);
}

async function cmdStatus(): Promise<void> {
  const repo = await openRepo();
  const branch = await repo.currentBranch();
  const head = await repo.head();
  const branches = await repo.listBranches();
  const steps = head === null ? [] : await repo.log({ limit: Infinity });
  const events = head === null ? [] : await repo.materialize();
  const kinds = new Map<string, number>();
  for (const item of events) kinds.set(item.event.kind, (kinds.get(item.event.kind) ?? 0) + 1);
  const unmerged: string[] = [];
  if (head !== null) {
    for (const [name, id] of branches) {
      if (name !== branch && !(await repo.isAncestor(id, head))) unmerged.push(name);
    }
  }
  console.log(`root: ${repo.projectRoot ?? '(memory)'}`);
  console.log(`branch: ${branch ?? '(detached)'}`);
  console.log(`head: ${head === null ? '(unborn)' : shortId(head)}`);
  console.log(`branches: ${branches.size}; unmerged: ${unmerged.length}${unmerged.length > 0 ? ` (${unmerged.sort().join(', ')})` : ''}`);
  console.log(`steps: ${steps.length}; events: ${events.length}`);
  console.log(`event kinds: ${[...kinds.entries()].sort().map(([kind, count]) => `${kind}=${count}`).join(', ') || '(none)'}`);
}

interface ArtifactReference { artifact: string; artifactHash?: string }

function artifactReferences(value: unknown, out: ArtifactReference[] = []): ArtifactReference[] {
  if (Array.isArray(value)) {
    for (const item of value) artifactReferences(item, out);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['artifact'] === 'string') {
      out.push({
        artifact: record['artifact'],
        ...(typeof record['artifactHash'] === 'string' ? { artifactHash: record['artifactHash'] } : {}),
      });
    }
    if (typeof record['report'] === 'string') {
      out.push({
        artifact: record['report'],
        ...(typeof record['reportHash'] === 'string' ? { artifactHash: record['reportHash'] } : {}),
      });
    }
    for (const item of Object.values(record)) artifactReferences(item, out);
  }
  return out;
}

async function cmdDoctor(): Promise<number> {
  const repo = await openRepo();
  if (repo.projectRoot === null) throw new AgentMergeError('doctor requires a filesystem repository');
  const errors: string[] = [];
  const warnings: string[] = [];
  const roots = await Repository.findRoots(process.cwd());
  if (roots.length > 1) errors.push(`nested repositories detected: ${roots.join(', ')}`);
  const branches = await repo.listBranches();
  const branchContexts: MaterializedEvent[][] = [];
  for (const [name] of branches) {
    try {
      branchContexts.push(await repo.materialize(name));
    } catch (error) {
      errors.push(`branch ${name} cannot be materialized: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const head = await repo.head();
  const context = head === null ? [] : await repo.materialize();
  if (context.length > 0 && context.every((item) => item.event.kind === 'annotation')) {
    warnings.push('timeline is annotation-only; replay and causal bisect evidence are weak');
  }
  for (let index = 1; index < context.length; index++) {
    if ((context[index] as MaterializedEvent).event.at < (context[index - 1] as MaterializedEvent).event.at) {
      warnings.push(`event time moves backward at materialized index ${index}`);
    }
  }
  const checked = new Set<string>();
  for (const item of [context, ...branchContexts].flat()) {
    for (const reference of artifactReferences(item.event.payload)) {
      if (checked.has(reference.artifact)) continue;
      checked.add(reference.artifact);
      const path = isAbsolute(reference.artifact) ? reference.artifact : resolve(repo.projectRoot, reference.artifact);
      const insideRoot = relative(repo.projectRoot, path);
      if (insideRoot.startsWith('..') || isAbsolute(insideRoot)) {
        warnings.push(`artifact escapes repository root: ${reference.artifact}`);
      }
      try {
        await access(path);
        if (reference.artifactHash !== undefined) {
          const actual = hashText(await readFile(path, 'utf8'));
          if (actual !== reference.artifactHash) errors.push(`artifact digest mismatch: ${reference.artifact}`);
        }
      } catch {
        errors.push(`artifact is missing or unreadable: ${reference.artifact}`);
      }
    }
  }
  for (const message of errors) console.log(`ERROR ${message}`);
  for (const message of [...new Set(warnings)]) console.log(`WARN  ${message}`);
  if (errors.length === 0 && warnings.length === 0) console.log('OK    repository is healthy');
  else console.log(`doctor: ${errors.length} error(s), ${new Set(warnings).size} warning(s)`);
  return errors.length === 0 ? 0 : 1;
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

  // One strategy set for any number of branches: every merge goes through
  // mergeMany with HEAD as tail 0 and the targets following in order.
  // `ours` and `theirs` are aliases for picking the corresponding tail.
  let many: MergeManyStrategy | BuiltinManyStrategyName | undefined;
  if (winner !== undefined && strategy !== 'pick' && strategy !== 'champion') {
    throw new UsageError('--winner requires --strategy pick or champion');
  }
  if (strategy === 'ours') {
    many = pickTailStrategy(0);
  } else if (strategy === 'theirs') {
    if (positionals.length !== 1) {
      throw new UsageError('--strategy theirs is ambiguous with multiple branches; use --strategy pick --winner <branch>');
    }
    many = pickTailStrategy(1);
  } else if (strategy === 'pick' || strategy === 'champion') {
    if (winner === undefined) throw new UsageError(`--strategy ${strategy} requires --winner <branch>`);
    const index = winner === (await repo.currentBranch()) ? 0 : positionals.indexOf(winner) + 1;
    if (index === 0 && winner !== (await repo.currentBranch())) {
      throw new UsageError(`--winner ${JSON.stringify(winner)} must be one of the merged branches (or the current one)`);
    }
    many = strategy === 'pick' ? pickTailStrategy(index) : championStrategy(index);
  } else if (strategy !== undefined) {
    if (!Object.hasOwn(builtinManyStrategies, strategy)) {
      throw new UsageError(
        `unknown strategy ${JSON.stringify(strategy)}; expected ` +
          `${Object.keys(builtinManyStrategies).join(' | ')} | ours | theirs | pick | champion`,
      );
    }
    many = strategy as BuiltinManyStrategyName;
  }
  const result = await repo.mergeMany(positionals, {
    ...(many !== undefined ? { strategy: many } : {}),
    ...meta,
  });
  const folded = positionals.length > 1 ? ` (${positionals.length} branches folded in)` : '';
  console.log(`${result.kind}: HEAD is now ${shortId(result.id)}${folded}`);
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

function optionalPositiveIntegerFlag(value: string | boolean | undefined, name: string): number | undefined {
  const raw = stringFlag(value, name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`--${name} expects a positive integer`);
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
    apply: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'agent-timeout': { type: 'string' },
    'test-timeout': { type: 'string' },
    'judge-timeout': { type: 'string' },
    recording: { type: 'string' },
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
  const agentTimeout = optionalPositiveIntegerFlag(values['agent-timeout'], 'agent-timeout');
  const testTimeout = optionalPositiveIntegerFlag(values['test-timeout'], 'test-timeout');
  const judgeTimeout = optionalPositiveIntegerFlag(values['judge-timeout'], 'judge-timeout');
  const runner = await resolveAgentRunner({
    runner: runnerName,
    ...(agentCommand !== undefined ? { command: agentCommand } : {}),
    ...(agentTimeout !== undefined ? { timeoutMs: agentTimeout } : {}),
  });
  const judgeCommand = stringFlag(values['judge-command'], 'judge-command');
  const selector = judgeCommand === undefined
    ? new SmallestPatchSelector()
    : new CommandCandidateSelector(judgeCommand, { ...(judgeTimeout !== undefined ? { timeoutMs: judgeTimeout } : {}) });
  if (values.apply === true && values['dry-run'] === true) throw new UsageError('--apply and --dry-run cannot be combined');
  const recordingRaw = stringFlag(values.recording, 'recording') ?? 'summary';
  if (recordingRaw !== 'summary' && recordingRaw !== 'redacted' && recordingRaw !== 'full') {
    throw new UsageError('--recording must be summary, redacted, or full');
  }
  const recordingMode = recordingRaw as RecordingMode;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let result: Awaited<ReturnType<typeof orchestrate>>;
  try {
    result = await orchestrate({
      projectDir: process.cwd(),
      task,
      runner,
      evaluator: new CommandEvaluator(testCommand, { ...(testTimeout !== undefined ? { timeoutMs: testTimeout } : {}) }),
      selector,
      agents: integerFlag(values.agents, 'agents', 3),
      retries: integerFlag(values.retries, 'retries', 1),
      apply: values.apply === true,
      keepWorkspaces: values['keep-workspaces'] === true,
      timeline: values['no-timeline'] !== true,
      recordingMode,
      ...(agentTimeout !== undefined ? { agentTimeoutMs: agentTimeout } : {}),
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
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
      `${candidate.patchBytes} patch bytes, ${candidate.files.length} file${candidate.files.length === 1 ? '' : 's'}`,
    );
  }
  console.log(result.winner === null
    ? 'winner: none (no patch applied)'
    : `winner: ${result.winner}${result.applied ? ' (patch applied)' : ' (not applied)'}`);
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
        await cmdInit(rest);
        return 0;
      case 'root':
        await cmdRoot();
        return 0;
      case 'status':
        await cmdStatus();
        return 0;
      case 'doctor':
        return cmdDoctor();
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
