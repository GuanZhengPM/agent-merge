import { OrchestrationError } from '../errors.ts';
import { hashText } from '../privacy.ts';
import { runProcess } from './process.ts';

export interface SelectableCandidate {
  readonly id: string;
  readonly patch: string;
  readonly files: readonly string[];
  readonly attempts: number;
}

export interface CandidateSelector {
  readonly name: string;
  readonly fingerprint?: string;
  select(candidates: readonly SelectableCandidate[], projectRoot: string, signal?: AbortSignal): Promise<string>;
}

/** Deterministic safe default: choose the passing patch with the fewest bytes. */
export class SmallestPatchSelector implements CandidateSelector {
  readonly name = 'smallest-patch';
  readonly fingerprint = hashText('smallest-patch-v1');

  async select(candidates: readonly SelectableCandidate[]): Promise<string> {
    const sorted = [...candidates].sort((a, b) => a.patch.length - b.patch.length || a.id.localeCompare(b.id));
    const winner = sorted[0];
    if (winner === undefined) throw new OrchestrationError('cannot select a winner from an empty candidate list');
    return winner.id;
  }
}

/** Delegate winner selection to a user or harness command that prints one candidate id. */
export class CommandCandidateSelector implements CandidateSelector {
  readonly name = 'command';
  readonly fingerprint: string;
  readonly #command: string;
  readonly #timeoutMs: number | undefined;

  constructor(command: string, options: { timeoutMs?: number } = {}) {
    this.#command = command;
    this.fingerprint = hashText(command);
    this.#timeoutMs = options.timeoutMs;
  }

  async select(candidates: readonly SelectableCandidate[], projectRoot: string, signal?: AbortSignal): Promise<string> {
    const summaries = candidates.map(({ id, files, attempts, patch }) => ({
      id,
      files,
      attempts,
      patchBytes: patch.length,
    }));
    const result = await runProcess(this.#command, [], {
      cwd: projectRoot,
      shell: true,
      input: JSON.stringify(candidates),
      env: { ...process.env, AGENT_MERGE_CANDIDATES: JSON.stringify(summaries) },
      ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (result.status !== 0) {
      throw new OrchestrationError(`judge command failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const winner = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
    if (winner === undefined || !candidates.some((candidate) => candidate.id === winner)) {
      throw new OrchestrationError(`judge returned invalid candidate id ${JSON.stringify(winner)}`);
    }
    return winner;
  }
}
