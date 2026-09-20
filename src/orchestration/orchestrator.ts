import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { OrchestrationError, RepositoryNotFoundError } from '../errors.ts';
import { championStrategy } from '../merge.ts';
import { hashText, redactJson, redactText } from '../privacy.ts';
import type { RecordingMode, Redactor } from '../privacy.ts';
import { Repository } from '../repo.ts';
import type { TrajectoryEvent } from '../types.ts';
import type { EvaluationResult, Evaluator } from './evaluator.ts';
import type { AgentRunResult, AgentRunner } from './runner.ts';
import { SmallestPatchSelector } from './selector.ts';
import type { CandidateSelector, SelectableCandidate } from './selector.ts';
import { GitWorktreeProvider } from './workspace.ts';
import type { AgentWorkspace, WorkspaceProvider } from './workspace.ts';

export interface CandidateAttempt {
  readonly attempt: number;
  readonly agent: AgentRunResult;
  readonly evaluation: EvaluationResult;
  readonly patchBytes: number;
  readonly files: readonly string[];
  readonly artifactPath: string;
  readonly artifactHash: string;
}

export interface CandidateResult extends SelectableCandidate {
  readonly passed: boolean;
  readonly patchHash: string;
  readonly patchBytes: number;
  readonly history: readonly CandidateAttempt[];
}

export interface OrchestrationResult {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly status: 'passed' | 'failed';
  readonly runner: string;
  readonly evaluator: string;
  readonly selector: string;
  readonly winner: string | null;
  readonly applied: boolean;
  readonly candidates: readonly CandidateResult[];
  readonly reportPath: string;
  readonly durationMs: number;
  readonly provenance: {
    readonly baseCommit: string;
    readonly taskHash: string;
    readonly recordingMode: RecordingMode;
    readonly runnerFingerprint: string;
    readonly evaluatorFingerprint: string;
    readonly selectorFingerprint: string;
    readonly agents: number;
    readonly retries: number;
    readonly node: string;
    readonly platform: string;
  };
}

export interface OrchestratorOptions {
  readonly projectDir: string;
  readonly task: string;
  readonly runner: AgentRunner;
  readonly evaluator: Evaluator;
  readonly agents?: number;
  /** Number of repair rounds after the first attempt. Default: 1. */
  readonly retries?: number;
  readonly apply?: boolean;
  readonly keepWorkspaces?: boolean;
  readonly selector?: CandidateSelector;
  readonly workspaceProvider?: WorkspaceProvider;
  readonly timeline?: boolean;
  /** What command/model output is persisted. Default: summary (hashes and sizes only). */
  readonly recordingMode?: RecordingMode;
  /** Optional application-specific redactor used when recordingMode is redacted. */
  readonly redactor?: Redactor;
  /** Per-attempt timeout for any runner, including native harness adapters. */
  readonly agentTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface CandidateState {
  readonly id: string;
  readonly branch: string;
  readonly workspace: AgentWorkspace;
  readonly history: CandidateAttempt[];
  patch: string;
  files: readonly string[];
  passed: boolean;
}

interface TimelineState {
  readonly repo: Repository;
  readonly receivingBranch: string;
  readonly branches: ReadonlyMap<string, string>;
}

function event(
  kind: TrajectoryEvent['kind'],
  actor: string,
  payload: Record<string, unknown>,
): TrajectoryEvent {
  return { kind, at: Date.now(), actor, payload };
}

function annotation(actor: string, text: string, payload: Record<string, unknown> = {}): TrajectoryEvent {
  return { kind: 'annotation', at: Date.now(), actor, payload: { text, ...payload } };
}

function hashPatch(patch: string): string {
  return createHash('sha256').update(patch).digest('hex');
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted === true) throw new OrchestrationError(message);
}

function summarizeOutput(result: { stdout: string; stderr: string }): string {
  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return combined.length <= 8_000 ? combined : `${combined.slice(0, 8_000)}\n… output truncated …`;
}

function recordedText(value: string, mode: RecordingMode, redactor: Redactor): string {
  if (mode === 'full') return value;
  if (mode === 'redacted') {
    const redacted = redactor(value);
    return typeof redacted === 'string' ? redactText(redacted) : redactText(JSON.stringify(redacted) ?? '');
  }
  return '';
}

function recordedProcess<T extends { stdout: string; stderr: string }>(
  result: T,
  mode: RecordingMode,
  redactor: Redactor,
): T & { stdoutBytes: number; stderrBytes: number; stdoutHash: string; stderrHash: string } {
  return {
    ...result,
    stdout: recordedText(result.stdout, mode, redactor),
    stderr: recordedText(result.stderr, mode, redactor),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    stdoutHash: hashText(result.stdout),
    stderrHash: hashText(result.stderr),
  };
}

function feedbackFor(state: CandidateState, states: readonly CandidateState[]): string {
  const latest = state.history.at(-1);
  const own = latest === undefined ? 'No previous result.' : summarizeOutput(latest.evaluation);
  const peers = states
    .filter((peer) => peer.id !== state.id)
    .map((peer) => {
      const result = peer.history.at(-1);
      return `${peer.id}: ${result?.evaluation.passed === true ? 'passed' : 'failed'}; files=${peer.files.join(', ') || '(none)'}`;
    })
    .join('\n');
  return `Acceptance command failed for ${state.id}.\n\nEvaluator output:\n${own}\n\nPeer outcomes:\n${peers}`;
}

async function openTimeline(
  projectRoot: string,
  runId: string,
  ids: readonly string[],
  taskHash: string,
): Promise<TimelineState> {
  let repo: Repository;
  try {
    repo = await Repository.openExact(projectRoot);
  } catch (error) {
    if (!(error instanceof RepositoryNotFoundError)) throw error;
    repo = await Repository.init(projectRoot);
  }
  const receivingBranch = await repo.currentBranch();
  if (receivingBranch === null) throw new OrchestrationError('timeline HEAD is detached; checkout a timeline branch first');
  const baseline = await repo.append(
    [event('tool_call', 'orchestrator', { operation: 'coding_run', runId, taskHash, candidates: ids })],
    { label: `run ${runId} start` },
  );
  const branches = new Map<string, string>();
  for (const id of ids) {
    const branch = `runs/${runId}/${id}`;
    await repo.branch(branch, baseline);
    branches.set(id, branch);
  }
  return { repo, receivingBranch, branches };
}

function asResult(state: CandidateState, mode: RecordingMode, redactor: Redactor): CandidateResult {
  return {
    id: state.id,
    patch: mode === 'full' ? state.patch : '',
    files: state.files,
    attempts: state.history.length,
    passed: state.passed,
    patchHash: hashPatch(state.patch),
    patchBytes: state.patch.length,
    history: state.history.map((attempt) => ({
      ...attempt,
      agent: recordedProcess(attempt.agent, mode, redactor),
      evaluation: recordedProcess(attempt.evaluation, mode, redactor),
    })),
  };
}

export async function orchestrate(options: OrchestratorOptions): Promise<OrchestrationResult> {
  const started = Date.now();
  const agents = options.agents ?? 3;
  const retries = options.retries ?? 1;
  const recordingMode = options.recordingMode ?? 'summary';
  const redactor = options.redactor ?? redactJson;
  if (!Number.isInteger(agents) || agents < 1 || agents > 32) throw new OrchestrationError('agents must be an integer from 1 to 32');
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new OrchestrationError('retries must be an integer from 0 to 10');
  if (options.agentTimeoutMs !== undefined && (!Number.isFinite(options.agentTimeoutMs) || options.agentTimeoutMs <= 0)) {
    throw new OrchestrationError('agentTimeoutMs must be a positive finite number');
  }
  if (!['summary', 'redacted', 'full'].includes(recordingMode)) {
    throw new OrchestrationError('recordingMode must be summary, redacted, or full');
  }
  if (options.task.trim() === '') throw new OrchestrationError('task must not be empty');
  throwIfAborted(options.signal, 'orchestration aborted before start');

  const provider = options.workspaceProvider ?? await GitWorktreeProvider.open(options.projectDir);
  const selector = options.selector ?? new SmallestPatchSelector();
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const taskHash = hashText(options.task);
  const ids = Array.from({ length: agents }, (_, index) => `agent-${index + 1}`);
  try {
    const workspaces = await provider.prepare(ids);
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const baseCommit = workspaces[0]?.baseCommit ?? 'unknown';
    if (workspaces.some((workspace) => workspace.baseCommit !== baseCommit)) {
      throw new OrchestrationError('workspace provider returned candidates from different base commits');
    }
    const timeline = options.timeline === false ? undefined : await openTimeline(provider.projectRoot, runId, ids, taskHash);
    const reportDir = join(provider.projectRoot, '.agent-merge', 'runs');
    const attemptDir = join(reportDir, runId);
    await mkdir(attemptDir, { recursive: true });
    const states: CandidateState[] = ids.map((id) => {
      const workspace = byId.get(id);
      if (workspace === undefined) throw new OrchestrationError(`workspace provider did not return ${id}`);
      return { id, branch: timeline?.branches.get(id) ?? id, workspace, history: [], patch: '', files: [], passed: false };
    });

    for (let round = 1; round <= retries + 1; round++) {
      throwIfAborted(options.signal, 'orchestration aborted');
      const active = states.filter((state) => !state.passed);
      const outcomes = await Promise.allSettled(active.map(async (state) => {
        if (timeline !== undefined) {
          await timeline.repo.append(
            [event('tool_call', state.id, {
              operation: 'agent_attempt',
              runId,
              attempt: round,
              runner: options.runner.name,
              workspace: state.id,
            })],
            { label: `${state.id} attempt ${round} start` },
            { branch: state.branch },
          );
        }
        let agent: AgentRunResult;
        const attemptController = new AbortController();
        let agentTimedOut = false;
        let agentAborted = false;
        const abortAttempt = (): void => {
          agentAborted = true;
          attemptController.abort();
        };
        options.signal?.addEventListener('abort', abortAttempt, { once: true });
        const agentTimer = options.agentTimeoutMs === undefined ? undefined : setTimeout(() => {
          agentTimedOut = true;
          attemptController.abort();
        }, options.agentTimeoutMs);
        agentTimer?.unref();
        try {
          agent = await options.runner.run({
            task: options.task,
            workspace: state.workspace.path,
            branch: state.branch,
            attempt: round,
            ...(round > 1 ? { feedback: feedbackFor(state, states) } : {}),
            signal: attemptController.signal,
          });
          if (agentTimedOut) {
            agent = { ...agent, status: 'failed', timedOut: true };
          }
        } catch (error) {
          agent = {
            status: 'failed',
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            durationMs: 0,
            ...(agentTimedOut ? { timedOut: true } : {}),
            ...(agentAborted ? { aborted: true } : {}),
          };
        } finally {
          if (agentTimer !== undefined) clearTimeout(agentTimer);
          options.signal?.removeEventListener('abort', abortAttempt);
        }
        const collected = await provider.collect(state.workspace);
        state.patch = collected.patch;
        state.files = collected.files;
        let evaluation: EvaluationResult;
        if (agent.status === 'completed') {
          try {
            evaluation = await options.evaluator.evaluate({
              workspace: state.workspace.path,
              branch: state.branch,
              attempt: round,
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
            });
          } catch (error) {
            evaluation = {
              passed: false,
              status: -1,
              stdout: '',
              stderr: error instanceof Error ? error.message : String(error),
              durationMs: 0,
            };
          }
        } else {
          evaluation = { passed: false, status: -1, stdout: '', stderr: 'agent process failed; evaluator skipped', durationMs: 0 };
        }
        state.passed = evaluation.passed;
        const artifactRelative = join('.agent-merge', 'runs', runId, `${state.id}-attempt-${round}.json`);
        const artifactPath = join(provider.projectRoot, artifactRelative);
        const recordedAgent = recordedProcess(agent, recordingMode, redactor);
        const recordedEvaluation = recordedProcess(evaluation, recordingMode, redactor);
        const artifactContent = `${JSON.stringify({
          schemaVersion: 1,
          runId,
          candidate: state.id,
          attempt: round,
          taskHash,
          patchHash: hashPatch(state.patch),
          patchBytes: state.patch.length,
          files: state.files,
          agent: recordedAgent,
          evaluation: recordedEvaluation,
        }, null, 2)}\n`;
        await writeFile(artifactPath, artifactContent, { encoding: 'utf8', mode: 0o600 });
        const artifactHash = hashText(artifactContent);
        const attempt: CandidateAttempt = {
          attempt: round,
          agent,
          evaluation,
          patchBytes: state.patch.length,
          files: state.files,
          artifactPath: artifactRelative,
          artifactHash,
        };
        state.history.push(attempt);
        if (timeline !== undefined) {
          await timeline.repo.append(
            [
              event('tool_result', state.id, {
                operation: 'agent_attempt',
                runId,
                attempt: round,
                runnerStatus: agent.status,
                evaluationPassed: evaluation.passed,
                evaluationStatus: evaluation.status,
                patchHash: hashPatch(state.patch),
                patchBytes: state.patch.length,
                files: state.files,
                artifact: artifactRelative,
                artifactHash,
              }),
              annotation(state.id, `${state.id} attempt ${round}: ${evaluation.passed ? 'passed' : 'failed'}`, {
                runId,
                attempt: round,
                ...(evaluation.timedOut === true || agent.timedOut === true ? { limitation: 'timeout' } : {}),
              }),
            ],
            { label: `${state.id} attempt ${round} result` },
            { branch: state.branch },
          );
        }
      }));
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (rejected !== undefined) throw rejected.reason;
      if (states.some((state) => state.passed)) break;
    }

    throwIfAborted(options.signal, 'orchestration aborted');
    const passing = states.filter((state) => state.passed).map((state) => ({
      id: state.id,
      patch: state.patch,
      files: state.files,
      attempts: state.history.length,
    }));
    const winner = passing.length === 0 ? null : await selector.select(passing, provider.projectRoot, options.signal);
    const winnerState = winner === null ? undefined : states.find((state) => state.id === winner);
    if (winner !== null && winnerState === undefined) throw new OrchestrationError(`selector chose unknown candidate ${winner}`);
    const shouldApply = options.apply ?? false;
    if (winnerState !== undefined && shouldApply) await provider.apply(winnerState.patch);

    if (timeline !== undefined) {
      await timeline.repo.checkout(timeline.receivingBranch);
      const winnerIndex = winner === null ? -1 : ids.indexOf(winner);
      await timeline.repo.mergeMany([...timeline.branches.values()], {
        strategy: winnerIndex < 0 ? 'conclusions' : championStrategy(winnerIndex + 1),
        meta: { label: `run ${runId} candidate evidence` },
      });
    }

    const reportPath = join(reportDir, `${runId}.json`);
    const result: OrchestrationResult = {
      schemaVersion: 2,
      runId,
      status: winner === null ? 'failed' : 'passed',
      runner: options.runner.name,
      evaluator: options.evaluator.name,
      selector: selector.name,
      winner,
      applied: winner !== null && shouldApply,
      candidates: states.map((state) => asResult(state, recordingMode, redactor)),
      reportPath,
      durationMs: Date.now() - started,
      provenance: {
        baseCommit,
        taskHash,
        recordingMode,
        runnerFingerprint: options.runner.fingerprint ?? hashText(options.runner.name),
        evaluatorFingerprint: options.evaluator.fingerprint ?? hashText(options.evaluator.name),
        selectorFingerprint: selector.fingerprint ?? hashText(selector.name),
        agents,
        retries,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
    };
    const reportRelative = relative(provider.projectRoot, reportPath);
    const reportContent = `${JSON.stringify({ ...result, reportPath: reportRelative }, null, 2)}\n`;
    await writeFile(reportPath, reportContent, { encoding: 'utf8', mode: 0o600 });
    if (timeline !== undefined) {
      await timeline.repo.append(
        [
          event('tool_result', 'orchestrator', {
            operation: 'coding_run',
            runId,
            status: result.status,
            winner,
            applied: result.applied,
            report: reportRelative,
            reportHash: hashText(reportContent),
          }),
          annotation('orchestrator', winner === null ? `Run ${runId} failed` : `Run ${runId} selected ${winner}`, {
            runId,
            winner,
            applied: result.applied,
            selector: selector.name,
          }),
        ],
        { label: `run ${runId} verdict` },
      );
    }
    return result;
  } finally {
    if (options.keepWorkspaces !== true) await provider.cleanup();
  }
}
