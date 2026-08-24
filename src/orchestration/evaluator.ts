import { runProcess } from './process.ts';

export interface EvaluationInput {
  readonly workspace: string;
  readonly branch: string;
  readonly attempt: number;
}

export interface EvaluationResult {
  readonly passed: boolean;
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface Evaluator {
  readonly name: string;
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}

/** Runs the user-supplied acceptance command inside each isolated workspace. */
export class CommandEvaluator implements Evaluator {
  readonly name = 'command';
  readonly #command: string;

  constructor(command: string) {
    this.#command = command;
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
    });
    return { passed: result.status === 0, ...result };
  }
}
