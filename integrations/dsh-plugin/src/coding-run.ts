import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-tools';
import {
  CommandAgentRunner,
  CommandEvaluator,
  orchestrate,
} from '@guanzhengpm/agent-merge';
import type { AgentRunner } from '@guanzhengpm/agent-merge';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string): ContentBlock[] => [{ type: 'text', text: value }],
} as const;

export interface CodingRunConfig {
  /** Git project to orchestrate. Default: plugin path/process cwd. */
  projectPath?: string;
  /** Shell command that runs one worker agent and reads its task from stdin. */
  runnerCommand?: string;
  /** Fixed acceptance command run in every isolated worktree. */
  testCommand: string;
  /** Default worker count. Default: 3. */
  agents?: number;
  /** Default repair rounds. Default: 1. */
  retries?: number;
  /** Apply the winning patch to the project. Default: true. */
  apply?: boolean;
  /** Programmatic-only native harness/sub-agent adapter. */
  runner?: AgentRunner;
}

/** Register the code orchestration entrypoint only when explicitly configured. */
export function registerCodingRunTool(ctx: Context, config: CodingRunConfig, defaultPath: string): void {
  const runner = config.runner ?? (
    config.runnerCommand === undefined
      ? undefined
      : new CommandAgentRunner({ name: 'dsh-configured', command: config.runnerCommand, shell: true })
  );
  if (runner === undefined) {
    throw new Error('agent-merge orchestration requires runnerCommand or a programmatic runner');
  }
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
      execute: async (args) => {
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
