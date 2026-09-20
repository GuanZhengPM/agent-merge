import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { OrchestrationError } from '../errors.ts';
import { hashText } from '../privacy.ts';
import { runProcess } from './process.ts';

export interface AgentRunInput {
  readonly task: string;
  readonly workspace: string;
  readonly branch: string;
  readonly attempt: number;
  readonly feedback?: string;
  readonly signal?: AbortSignal;
}

export interface AgentRunResult {
  readonly status: 'completed' | 'failed';
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly stdoutHash?: string;
  readonly stderrHash?: string;
}

/** Adapter implemented by a CLI, a harness plugin, or a native sub-agent host. */
export interface AgentRunner {
  readonly name: string;
  readonly fingerprint?: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export type AgentRunCallback = (input: AgentRunInput) => Promise<AgentRunResult>;

/** Lets an embedding harness supply its own native sub-agent implementation. */
export class CallbackAgentRunner implements AgentRunner {
  readonly name: string;
  readonly #callback: AgentRunCallback;

  constructor(name: string, callback: AgentRunCallback) {
    this.name = name;
    this.#callback = callback;
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    return this.#callback(input);
  }
}

export interface CommandAgentRunnerOptions {
  readonly name?: string;
  readonly command: string;
  readonly shell?: boolean;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/** Generic adapter for any agent process. Task and feedback are sent on stdin and in env. */
export class CommandAgentRunner implements AgentRunner {
  readonly name: string;
  readonly fingerprint: string;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #shell: boolean;
  readonly #timeoutMs: number | undefined;

  constructor(options: CommandAgentRunnerOptions) {
    this.name = options.name ?? 'command';
    this.#command = options.command;
    this.#args = options.args ?? [];
    this.#shell = options.shell ?? false;
    this.#timeoutMs = options.timeoutMs;
    this.fingerprint = hashText(JSON.stringify({ command: this.#command, args: this.#args }));
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const prompt = input.feedback === undefined
      ? input.task
      : `${input.task}\n\nPrevious attempt feedback:\n${input.feedback}\n\nRepair the existing workspace and re-run focused checks.`;
    const result = await runProcess(this.#command, this.#args, {
      cwd: input.workspace,
      input: prompt,
      shell: this.#shell,
      env: {
        ...process.env,
        AGENT_MERGE_WORKSPACE: input.workspace,
        AGENT_MERGE_BRANCH: input.branch,
        AGENT_MERGE_ATTEMPT: String(input.attempt),
        AGENT_MERGE_TASK: input.task,
        ...(input.feedback !== undefined ? { AGENT_MERGE_FEEDBACK: input.feedback } : {}),
      },
      ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return {
      status: result.status === 0 ? 'completed' : 'failed',
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }
}

/** The Codex CLI adapter is one implementation; the orchestration API is harness-neutral. */
export class CodexCliRunner extends CommandAgentRunner {
  constructor(command = 'codex', timeoutMs?: number) {
    super({
      name: 'codex',
      command,
      args: ['exec', '--ephemeral', '--sandbox', 'workspace-write', '-'],
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
}

async function executableExists(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (command.includes('/') || command.includes('\\')) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  const path = env.PATH ?? env.Path ?? '';
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue;
    for (const extension of extensions) {
      try {
        await access(join(directory, `${command}${extension.toLowerCase()}`));
        return true;
      } catch {
        try {
          await access(join(directory, `${command}${extension.toUpperCase()}`));
          return true;
        } catch {
          // Try the next PATH entry.
        }
      }
    }
  }
  return false;
}

async function executableRuns(command: string): Promise<boolean> {
  if (!(await executableExists(command))) return false;
  try {
    const probe = await runProcess(command, ['--version'], {
      cwd: process.cwd(),
      maxOutputBytes: 4_096,
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

export interface ResolveRunnerOptions {
  readonly runner: 'auto' | 'codex' | 'command';
  readonly command?: string;
  readonly timeoutMs?: number;
}

/** Resolve the standalone CLI runner. Embedded harnesses should inject AgentRunner directly. */
export async function resolveAgentRunner(options: ResolveRunnerOptions): Promise<AgentRunner> {
  if (options.runner === 'command') {
    if (options.command === undefined || options.command.trim() === '') {
      throw new OrchestrationError('--runner command requires --agent-command <command>');
    }
    return new CommandAgentRunner({
      name: 'command',
      command: options.command,
      shell: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
  if (options.runner === 'codex') return new CodexCliRunner(options.command ?? 'codex', options.timeoutMs);

  const configured = options.command ?? process.env.AGENT_MERGE_RUNNER_COMMAND;
  if (configured !== undefined && configured.trim() !== '') {
    return new CommandAgentRunner({
      name: 'configured',
      command: configured,
      shell: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
  if (await executableRuns('codex')) return new CodexCliRunner('codex', options.timeoutMs);
  throw new OrchestrationError(
    'no agent runner detected; set --agent-command, use --runner command, or inject AgentRunner from the host harness',
  );
}
