import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-tools';
import {
  CommandAgentRunner,
  CommandEvaluator,
  orchestrate,
} from '@guanzhengpm/agent-merge';
import type { AgentRunner } from '@guanzhengpm/agent-merge';
import type { AgentRunInput, AgentRunResult } from '@guanzhengpm/agent-merge';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string): ContentBlock[] => [{ type: 'text', text: value }],
} as const;

export interface CodingRunConfig {
  /** Git project to orchestrate. Default: plugin path/process cwd. */
  projectPath?: string;
  /** Shell command that runs one worker agent and reads its task from stdin. */
  runnerCommand?: string;
  /** Native `ctx.subagents` provider. Default: `spawn`. */
  subagentProvider?: string;
  /** Fixed acceptance command run in every isolated worktree. */
  testCommand: string;
  /** Default worker count. Default: 3. */
  agents?: number;
  /** Default repair rounds. Default: 1. */
  retries?: number;
  /** Apply the winning patch to the project. Default: true. */
  apply?: boolean;
  /** Programmatic runner override, primarily for embedding and tests. */
  runner?: AgentRunner;
}

function textFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Bridge one orchestration worker to DSH's own one-shot subagent seam. */
export class DshSubagentRunner implements AgentRunner {
  readonly name: string;
  readonly #runtime: SubagentRuntime;
  readonly #parent: Agent;
  readonly #signal: AbortSignal;
  readonly #provider: string;

  constructor(runtime: SubagentRuntime, parent: Agent, signal: AbortSignal, provider = 'spawn') {
    this.name = `dsh-subagent:${provider}`;
    this.#runtime = runtime;
    this.#parent = parent;
    this.#signal = signal;
    this.#provider = provider;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.#runtime.getProvider(this.#provider) === undefined) {
      const available = this.#runtime.list().join(', ') || 'none';
      throw new Error(`DSH subagent provider "${this.#provider}" is unavailable (available: ${available})`);
    }
    const startedAt = Date.now();
    const feedback = input.feedback === undefined
      ? ''
      : `\n\nPrevious attempt feedback:\n${input.feedback}\nRepair the existing workspace and rerun focused checks.`;
    const prompt = [
      'Implement the coding task in the isolated Git worktree below.',
      `Workspace: ${input.workspace}`,
      `Branch: ${input.branch}`,
      `Attempt: ${input.attempt}`,
      '',
      'All file reads, writes, and commands MUST target that exact workspace (use absolute paths or set cwd/workdir explicitly).',
      'Do not modify the parent agent workspace. Finish by leaving the implementation changes in the assigned worktree.',
      '',
      'Task:',
      input.task,
      feedback,
    ].join('\n');
    const run = await this.#runtime.start(this.#provider, {
      label: `agent-merge ${input.branch}`,
      prompt: [{ type: 'text', text: prompt }],
      parent: this.#parent,
      signal: this.#signal,
    });
    let result: Awaited<typeof run.result> | undefined;
    let resultError: unknown;
    try {
      result = await run.result;
    } catch (error) {
      resultError = error;
    }
    let disposeError: unknown;
    try {
      await run.dispose();
    } catch (error) {
      disposeError = error;
    }
    if (resultError !== undefined || disposeError !== undefined) {
      const errors = [resultError, disposeError].filter((error) => error !== undefined);
      throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'DSH subagent run and cleanup failed');
    }
    const settled = result as NonNullable<typeof result>;
    return {
      status: settled.stopReason === 'completed' ? 'completed' : 'failed',
      stdout: textFromBlocks(settled.output),
      stderr: settled.stopReason === 'completed'
        ? ''
        : [settled.stopReason, settled.diagnostic].filter(Boolean).join(': '),
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Register the code orchestration entrypoint only when explicitly configured. */
export function registerCodingRunTool(ctx: Context, config: CodingRunConfig, defaultPath: string): void {
  const configuredRunner = config.runner ?? (
    config.runnerCommand === undefined
      ? undefined
      : new CommandAgentRunner({ name: 'dsh-configured', command: config.runnerCommand, shell: true })
  );
  ctx.tools.register(
    defineTool({
      name: 'coding_run',
      description:
        'Run several coding agents in isolated Git worktrees, evaluate their patches, ' +
        'retry failed attempts with test feedback, select a passing winner, and optionally apply it.',
      parameters: {
        task: { type: 'string', required: true, description: 'Complete coding task for every worker.' },
        agents: { type: 'number', description: `Worker count (default ${config.agents ?? 3}).` },
        retries: { type: 'number', description: `Repair rounds after the first failure (default ${config.retries ?? 1}).` },
        dryRun: { type: 'boolean', description: 'Select a winner but do not apply its patch.' },
      },
      output: TEXT_OUTPUT,
      execute: async (args, exec) => {
        const runner = configuredRunner ?? (() => {
          if (exec.agent === undefined) {
            throw new Error('coding_run requires a calling DSH agent when no runnerCommand is configured');
          }
          const runtime = ctx.get('subagents');
          if (runtime === undefined) {
            throw new Error('coding_run requires ctx.subagents or an explicit runnerCommand');
          }
          return new DshSubagentRunner(runtime, exec.agent, exec.signal, config.subagentProvider ?? 'spawn');
        })();
        const result = await orchestrate({
          projectDir: config.projectPath ?? defaultPath,
          task: args.task,
          runner,
          evaluator: new CommandEvaluator(config.testCommand),
          agents: args.agents ?? config.agents ?? 3,
          retries: args.retries ?? config.retries ?? 1,
          apply: args.dryRun === true ? false : (config.apply ?? true),
        });
        const candidates = result.candidates
          .map((candidate) => `${candidate.id}: ${candidate.passed ? 'passed' : 'failed'} (${candidate.attempts} attempts, ${candidate.patch.length} patch bytes)`)
          .join('\n');
        return (
          `run ${result.runId}: ${result.status}\n${candidates}\n` +
          `winner: ${result.winner ?? 'none'}; applied: ${result.applied}\nreport: ${result.reportPath}`
        );
      },
    }),
  );
}
