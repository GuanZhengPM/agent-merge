import { runProcess } from './process.ts';
import { hashText } from '../privacy.ts';

export interface EvaluationInput {
  readonly workspace: string;
  readonly branch: string;
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

export interface EvaluationResult {
  readonly passed: boolean;
  readonly status: number;
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

export interface Evaluator {
  readonly name: string;
  readonly fingerprint?: string;
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}

/** Runs the user-supplied acceptance command inside each isolated workspace. */
export class CommandEvaluator implements Evaluator {
  readonly name = 'command';
  readonly fingerprint: string;
  readonly #command: string;
  readonly #timeoutMs: number | undefined;

  constructor(command: string, options: { timeoutMs?: number } = {}) {
    this.#command = command;
    this.fingerprint = hashText(command);
    this.#timeoutMs = options.timeoutMs;
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    const result = await runProcess(this.#command, [], {
      cwd: input.workspace,
      shell: true,
      env: {
        ...process.env,
        AGENT_MERGE_WORKSPACE: input.workspace,
        AGENT_MERGE_BRANCH: input.branch,
        AGENT_MERGE_ATTEMPT: String(input.attempt),
      },
      ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return { passed: result.status === 0, ...result };
  }
}
