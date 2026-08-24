import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OrchestrationError, RepositoryNotFoundError } from '../errors.ts';
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
}

export interface CandidateResult extends SelectableCandidate {
  readonly passed: boolean;
  readonly patchHash: string;
  readonly history: readonly CandidateAttempt[];
}

export interface OrchestrationResult {
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

function annotation(actor: string, text: string, payload: Record<string, unknown> = {}): TrajectoryEvent {
  return { kind: 'annotation', at: Date.now(), actor, payload: { text, ...payload } };
}

function hashPatch(patch: string): string {
  return createHash('sha256').update(patch).digest('hex');
}

function summarizeOutput(result: { stdout: string; stderr: string }): string {
  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return combined.length <= 8_000 ? combined : `${combined.slice(0, 8_000)}\n… output truncated …`;
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

async function openTimeline(projectRoot: string, runId: string, ids: readonly string[], task: string): Promise<TimelineState> {
  let repo: Repository;
  try {
    repo = await Repository.open(projectRoot);
  } catch (error) {
    if (!(error instanceof RepositoryNotFoundError)) throw error;
    repo = await Repository.init(projectRoot);
  }
  const receivingBranch = await repo.currentBranch();
  if (receivingBranch === null) throw new OrchestrationError('timeline HEAD is detached; checkout a timeline branch first');
  const baseline = await repo.append(
    [annotation('orchestrator', `Started coding run ${runId}`, { runId, task })],
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

function asResult(state: CandidateState): CandidateResult {
  return {
    id: state.id,
    patch: state.patch,
    files: state.files,
    attempts: state.history.length,
    passed: state.passed,
    patchHash: hashPatch(state.patch),
    history: state.history,
  };
}

export async function orchestrate(options: OrchestratorOptions): Promise<OrchestrationResult> {
  const started = Date.now();
  const agents = options.agents ?? 3;
  const retries = options.retries ?? 1;
  if (!Number.isInteger(agents) || agents < 1 || agents > 32) throw new OrchestrationError('agents must be an integer from 1 to 32');
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new OrchestrationError('retries must be an integer from 0 to 10');
  if (options.task.trim() === '') throw new OrchestrationError('task must not be empty');

  const provider = options.workspaceProvider ?? await GitWorktreeProvider.open(options.projectDir);
  const selector = options.selector ?? new SmallestPatchSelector();
  const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const ids = Array.from({ length: agents }, (_, index) => `agent-${index + 1}`);
  try {
    const workspaces = await provider.prepare(ids);
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const timeline = options.timeline === false ? undefined : await openTimeline(provider.projectRoot, runId, ids, options.task);
    const states: CandidateState[] = ids.map((id) => {
      const workspace = byId.get(id);
      if (workspace === undefined) throw new OrchestrationError(`workspace provider did not return ${id}`);
      return { id, branch: timeline?.branches.get(id) ?? id, workspace, history: [], patch: '', files: [], passed: false };
    });

    for (let round = 1; round <= retries + 1; round++) {
      const active = states.filter((state) => !state.passed);
      await Promise.all(active.map(async (state) => {
        const agent = await options.runner.run({
          task: options.task,
          workspace: state.workspace.path,
          branch: state.branch,
          attempt: round,
          ...(round > 1 ? { feedback: feedbackFor(state, states) } : {}),
        });
        const collected = await provider.collect(state.workspace);
        state.patch = collected.patch;
        state.files = collected.files;
        const evaluation = agent.status === 'completed'
          ? await options.evaluator.evaluate({ workspace: state.workspace.path, branch: state.branch, attempt: round })
          : { passed: false, status: -1, stdout: '', stderr: 'agent process failed; evaluator skipped', durationMs: 0 };
        state.passed = evaluation.passed;
        const attempt: CandidateAttempt = {
          attempt: round,
          agent,
          evaluation,
          patchBytes: state.patch.length,
          files: state.files,
        };
        state.history.push(attempt);
        if (timeline !== undefined) {
          await timeline.repo.append(
            [annotation(state.id, `${state.id} attempt ${round}: ${evaluation.passed ? 'passed' : 'failed'}`, {
              runId,
              attempt: round,
              runnerStatus: agent.status,
              evaluationStatus: evaluation.status,
              patchHash: hashPatch(state.patch),
              patchBytes: state.patch.length,
              files: state.files,
              output: summarizeOutput(evaluation),
            })],
            { label: `${state.id} attempt ${round}` },
            { branch: state.branch },
          );
        }
      }));
      if (states.some((state) => state.passed)) break;
    }

    const passing = states.filter((state) => state.passed).map(asResult);
    const winner = passing.length === 0 ? null : await selector.select(passing, provider.projectRoot);
    const winnerState = winner === null ? undefined : states.find((state) => state.id === winner);
    if (winner !== null && winnerState === undefined) throw new OrchestrationError(`selector chose unknown candidate ${winner}`);
    const shouldApply = options.apply ?? true;
    if (winnerState !== undefined && shouldApply) await provider.apply(winnerState.patch);

    if (timeline !== undefined) {
      await timeline.repo.checkout(timeline.receivingBranch);
      await timeline.repo.mergeMany([...timeline.branches.values()], {
        strategy: 'conclusions',
        meta: { label: `run ${runId} candidate conclusions` },
      });
      await timeline.repo.append(
        [annotation('orchestrator', winner === null ? `Run ${runId} failed` : `Run ${runId} selected ${winner}`, {
          runId,
          winner,
          applied: winner !== null && shouldApply,
          selector: selector.name,
        })],
        { label: `run ${runId} verdict` },
      );
    }

    const reportDir = join(provider.projectRoot, '.agent-merge', 'runs');
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `${runId}.json`);
    const result: OrchestrationResult = {
      runId,
      status: winner === null ? 'failed' : 'passed',
      runner: options.runner.name,
      evaluator: options.evaluator.name,
      selector: selector.name,
      winner,
      applied: winner !== null && shouldApply,
      candidates: states.map(asResult),
      reportPath,
      durationMs: Date.now() - started,
    };
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  } finally {
    if (options.keepWorkspaces !== true) await provider.cleanup();
  }
}
