import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { OrchestrationError } from '../errors.ts';
import { runProcess } from './process.ts';

export interface AgentWorkspace {
  readonly id: string;
  readonly path: string;
  readonly baseCommit: string;
}

export interface CollectedPatch {
  readonly patch: string;
  readonly files: readonly string[];
}

export interface WorkspaceProvider {
  readonly projectRoot: string;
  prepare(ids: readonly string[]): Promise<readonly AgentWorkspace[]>;
  collect(workspace: AgentWorkspace): Promise<CollectedPatch>;
  apply(patch: string): Promise<void>;
  cleanup(): Promise<void>;
}

async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const result = await runProcess('git', args, { cwd, ...(input !== undefined ? { input } : {}) });
  if (result.status !== 0) {
    throw new OrchestrationError(`git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

/** Isolates every candidate in a temporary Git worktree and returns portable patches. */
export class GitWorktreeProvider implements WorkspaceProvider {
  readonly projectRoot: string;
  readonly #baseCommit: string;
  #container: string | undefined;
  #workspaces: AgentWorkspace[] = [];

  private constructor(projectRoot: string, baseCommit: string) {
    this.projectRoot = projectRoot;
    this.#baseCommit = baseCommit;
  }

  static async open(projectDir: string): Promise<GitWorktreeProvider> {
    const root = await git(projectDir, ['rev-parse', '--show-toplevel']);
    const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
    if (branch === '') throw new OrchestrationError('agent-merge run requires a checked-out Git branch, not detached HEAD');
    const status = await git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).agent-merge']);
    if (status !== '') {
      throw new OrchestrationError('working tree must be clean before orchestration (except .agent-merge metadata)');
    }
    const baseCommit = await git(root, ['rev-parse', 'HEAD']);
    return new GitWorktreeProvider(resolve(root), baseCommit);
  }

  async prepare(ids: readonly string[]): Promise<readonly AgentWorkspace[]> {
    if (this.#container !== undefined) throw new OrchestrationError('workspaces are already prepared');
    this.#container = await mkdtemp(join(tmpdir(), `${basename(this.projectRoot)}-agent-merge-`));
    for (const id of ids) {
      const path = join(this.#container, id);
      await git(this.projectRoot, ['worktree', 'add', '--detach', path, this.#baseCommit]);
      this.#workspaces.push({ id, path, baseCommit: this.#baseCommit });
    }
    return this.#workspaces;
  }

  async collect(workspace: AgentWorkspace): Promise<CollectedPatch> {
    // Intent-to-add makes untracked, non-ignored files appear in a normal binary diff.
    await git(workspace.path, ['add', '-N', '--', '.']);
    const result = await runProcess('git', ['diff', '--binary', '--no-ext-diff', workspace.baseCommit, '--'], {
      cwd: workspace.path,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.status !== 0) throw new OrchestrationError(`cannot collect patch for ${workspace.id}: ${result.stderr}`);
    const names = await git(workspace.path, ['diff', '--name-only', workspace.baseCommit, '--']);
    return { patch: result.stdout, files: names === '' ? [] : names.split(/\r?\n/) };
  }

  async apply(patch: string): Promise<void> {
    if (patch === '') return;
    const status = await git(this.projectRoot, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).agent-merge']);
    if (status !== '') throw new OrchestrationError('main working tree changed during orchestration; refusing to apply winner');
    await git(this.projectRoot, ['apply', '--check', '--binary', '-'], patch);
    await git(this.projectRoot, ['apply', '--binary', '--whitespace=nowarn', '-'], patch);
    try {
      await git(this.projectRoot, ['diff', '--check']);
    } catch (error) {
      await git(this.projectRoot, ['apply', '-R', '--binary', '--whitespace=nowarn', '-'], patch).catch(() => '');
      throw new OrchestrationError('applied patch failed git diff --check and was rolled back', { cause: error });
    }
  }

  async cleanup(): Promise<void> {
    for (const workspace of [...this.#workspaces].reverse()) {
      await git(this.projectRoot, ['worktree', 'remove', '--force', workspace.path]).catch(() => '');
    }
    this.#workspaces = [];
    if (this.#container !== undefined) {
      await rm(this.#container, { recursive: true, force: true });
      this.#container = undefined;
    }
    await git(this.projectRoot, ['worktree', 'prune']).catch(() => '');
  }
}
