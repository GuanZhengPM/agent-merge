/**
 * dsh-plugin-agent-merge — DeepSeek Harness plugin giving sessions a
 * forkable, mergeable, bisectable history.
 *
 * Two halves, both optional per config:
 * - a session recorder that mirrors every committed session event into an
 *   agent-merge store (one branch per session, one step per flush batch),
 *   subscribing to dsh's post-commit append feed the way persistence
 *   plugins are meant to;
 * - six `timeline_*` tools that let the agent itself fork, inspect, merge,
 *   and bisect the recorded history;
 * - an opt-in `coding_run` tool that performs test-gated multi-agent coding
 *   through DSH's native subagents, a configured CLI, or an injected runner.
 *
 * @module dsh-plugin-agent-merge
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
import type { RecordingMode, Redactor } from '@guanzhengpm/agent-merge';
import { registerCodingRunTool } from './coding-run.ts';
import type { CodingRunConfig } from './coding-run.ts';
import { SessionRecorder } from './recorder.ts';
import { TimelineStore } from './store.ts';
import { registerTimelineTools } from './tools.ts';

export const name = 'agent-merge';

export const inject: string[] = [];

/** Plugin configuration. */
export interface Config {
  /**
   * Directory whose `.agent-merge/` store holds the timelines.
   * Default: the harness process working directory.
   */
  path?: string;
  /** Explicitly permit `path` to create a repository below another timeline store. */
  allowNested?: boolean;
  /** Mirror committed session events into the store. Default: true. */
  record?: boolean;
  /** Persist redacted events by default; `full` is explicit opt-in. */
  recordingMode?: RecordingMode;
  /** Optional host-provided redaction hook. */
  redactor?: Redactor;
  /** Register the `timeline_*` tools. Default: true. */
  tools?: boolean;
  /** Optional, explicit coding orchestration entrypoint. */
  orchestration?: CodingRunConfig;
}

export function apply(ctx: Context, config: Config = {}): void {
  const store = new TimelineStore(config.path ?? process.cwd(), { allowNested: config.allowNested ?? false });

  if (config.record !== false) {
    new SessionRecorder(ctx, store, {
      ...(config.recordingMode !== undefined ? { mode: config.recordingMode } : {}),
      ...(config.redactor !== undefined ? { redactor: config.redactor } : {}),
    });
  }

  if (config.tools !== false || config.orchestration !== undefined) {
    const needsNativeSubagents = config.orchestration !== undefined
      && config.orchestration.runner === undefined
      && config.orchestration.runnerCommand === undefined;
    ctx.inject(needsNativeSubagents ? ['tools', 'subagents'] : ['tools'], (toolCtx: Context) => {
      if (config.tools !== false) registerTimelineTools(toolCtx, store);
      if (config.orchestration !== undefined) {
        registerCodingRunTool(toolCtx, config.orchestration, config.path ?? process.cwd());
      }
    });
  }
}

export { SessionRecorder, toTrajectoryEvent } from './recorder.ts';
export { TimelineStore } from './store.ts';
export { DshSubagentRunner, registerCodingRunTool } from './coding-run.ts';
export type { CodingRunConfig } from './coding-run.ts';
