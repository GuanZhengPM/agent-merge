/**
 * dsh-plugin-agent-merge — DeepSeek Harness plugin giving sessions a
 * forkable, mergeable, bisectable history.
 *
 * Two halves, both optional per config:
 * - a session recorder that mirrors every committed session event into an
 *   agent-merge store (one branch per session, one step per flush batch),
 *   subscribing to dsh's post-commit append feed the way persistence
 *   plugins are meant to;
 * - five `timeline_*` tools that let the agent itself fork, inspect, merge,
 *   and bisect the recorded history.
 *
 * @module dsh-plugin-agent-merge
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
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
  /** Mirror committed session events into the store. Default: true. */
  record?: boolean;
  /** Register the `timeline_*` tools. Default: true. */
  tools?: boolean;
}

export function apply(ctx: Context, config: Config = {}): void {
  const store = new TimelineStore(config.path ?? process.cwd());

  if (config.record !== false) {
    new SessionRecorder(ctx, store);
  }

  if (config.tools !== false) {
    ctx.inject(['tools'], (toolCtx: Context) => {
      registerTimelineTools(toolCtx, store);
    });
  }
}

export { SessionRecorder, toTrajectoryEvent } from './recorder.ts';
export { TimelineStore } from './store.ts';
