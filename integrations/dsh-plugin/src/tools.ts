import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-tools';
import { championStrategy, pickTailStrategy } from '@guanzhengpm/agent-merge';
import type { MaterializedEvent, MergeManyOptions } from '@guanzhengpm/agent-merge';
import type { TimelineStore } from './store.ts';

const SHORT = 12;

/** Text-only canonical output shared by every timeline tool. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string): ContentBlock[] => [{ type: 'text', text: value }],
} as const;

function preview(m: MaterializedEvent): string {
  const text = JSON.stringify(m.event.payload) ?? 'null';
  const clipped = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  return `${m.id.slice(0, SHORT)} [${m.event.kind}] ${m.event.actor}: ${clipped}`;
}

/**
 * The model-facing surface: six `timeline_*` tools over the shared store,
 * letting the agent fork, inspect, merge, and bisect recorded session
 * history. Registered under `ctx.inject(['tools'], …)` by the entry plugin
 * so assemblies without a tool registry stay unaffected.
 */
export function registerTimelineTools(ctx: Context, store: TimelineStore): void {
  ctx.tools.register(
    defineTool({
      name: 'timeline_log',
      description:
        'List recorded timeline branches and the recent steps of one branch. ' +
        'Session histories are recorded on dsh/<session-id> branches.',
      parameters: {
        branch: { type: 'string', description: 'Branch to show steps for; omit to list all branches.' },
        limit: { type: 'number', description: 'Max steps to list (default 20).' },
      },
      output: TEXT_OUTPUT,
      execute: async (args) =>
        store.run(async (repo) => {
          if (args.branch === undefined) {
            const branches = await repo.listBranches();
            if (branches.size === 0) return 'no branches recorded yet';
            return [...branches.entries()]
              .map(([name, id]) => `${name}  ${id.slice(0, SHORT)}`)
              .join('\n');
          }
          const entries = await repo.log({ from: args.branch, limit: args.limit ?? 20 });
          return entries
            .map(({ id, step }) => `${id.slice(0, SHORT)}  ${step.events.length} events  ${step.meta.label ?? ''}`)
            .join('\n');
        }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'timeline_fork',
      description:
        'Fork a recorded timeline: create a new branch at a step or branch tip, ' +
        'so an alternative path can be explored without touching the original.',
      parameters: {
        name: { type: 'string', required: true, description: 'Name for the new branch.' },
        at: { type: 'string', required: true, description: 'Branch name, step id, or id prefix to fork from.' },
      },
      output: TEXT_OUTPUT,
      execute: async (args) =>
        store.run(async (repo) => {
          const id = await repo.branch(args.name, args.at);
          return `forked ${args.name} at ${id.slice(0, SHORT)}`;
        }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'timeline_merge',
      description:
        'Merge one timeline branch into another. Strategies: interleave (weave both ' +
        'sides by time, default), ours, theirs.',
      parameters: {
        into: { type: 'string', required: true, description: 'Branch that receives the merge.' },
        from: { type: 'string', required: true, description: 'Branch (or step id) to merge in.' },
        strategy: {
          type: 'string',
          enum: ['interleave', 'ours', 'theirs'],
          description: 'How to combine diverged histories (default interleave).',
        },
      },
      output: TEXT_OUTPUT,
      execute: async (args) =>
        store.run(async (repo) => {
          await repo.checkout(args.into);
          const result = await repo.merge(args.from, {
            ...(args.strategy !== undefined ? { strategy: args.strategy as 'interleave' | 'ours' | 'theirs' } : {}),
            meta: { author: 'dsh-plugin-agent-merge' },
          });
          return `${result.kind}: ${args.into} is now ${result.id.slice(0, SHORT)}`;
        }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'timeline_merge_many',
      description:
        'Fold several timeline branches into one in a single N-way merge — the fan-in ' +
        'after parallel multi-agent exploration. Pick the strategy for the situation: ' +
        '"conclusions" keeps only each branch\'s annotation events (recommended default: ' +
        'merges what the agents concluded, not their raw histories); "interleave" keeps ' +
        'everything woven by time; "pick" keeps the winner branch only; "champion" keeps ' +
        'the winner in full plus the other branches\' conclusions. pick/champion require winner.',
      parameters: {
        into: { type: 'string', required: true, description: 'Branch that receives the merge.' },
        from: {
          type: 'string',
          required: true,
          description: 'Comma-separated list of branches (or step ids) to merge in.',
        },
        strategy: {
          type: 'string',
          enum: ['conclusions', 'interleave', 'pick', 'champion'],
          description: 'How to combine the branches (default interleave).',
        },
        winner: {
          type: 'string',
          description: 'For pick/champion: the winning branch — one of `from`, or `into` itself.',
        },
      },
      output: TEXT_OUTPUT,
      execute: async (args) =>
        store.run(async (repo) => {
          const targets = args.from.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
          if (targets.length === 0) return 'error: `from` lists no branches';
          let strategy: MergeManyOptions['strategy'];
          if (args.strategy === 'pick' || args.strategy === 'champion') {
            if (args.winner === undefined) return `error: strategy ${args.strategy} requires \`winner\``;
            const index = args.winner === args.into ? 0 : targets.indexOf(args.winner) + 1;
            if (index === 0 && args.winner !== args.into) {
              return `error: winner ${args.winner} is not in \`from\` or \`into\``;
            }
            strategy = args.strategy === 'pick' ? pickTailStrategy(index) : championStrategy(index);
          } else {
            strategy = args.strategy;
          }
          await repo.checkout(args.into);
          const result = await repo.mergeMany(targets, {
            ...(strategy !== undefined ? { strategy } : {}),
            meta: { author: 'dsh-plugin-agent-merge' },
          });
          return `${result.kind}: ${args.into} is now ${result.id.slice(0, SHORT)} (${targets.length} branches folded in)`;
        }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'timeline_show',
      description: 'Show the recorded events at a step or branch tip (the replayable context).',
      parameters: {
        ref: { type: 'string', required: true, description: 'Branch name, step id, or id prefix.' },
        last: { type: 'number', description: 'Only the last N events (default 20).' },
      },
      output: TEXT_OUTPUT,
      execute: async (args) =>
        store.run(async (repo) => {
          const context = await repo.materialize(args.ref);
          const tail = context.slice(-(args.last ?? 20));
          if (tail.length === 0) return '(empty timeline)';
          const skipped = context.length - tail.length;
          const lines = tail.map(preview);
          return (skipped > 0 ? [`… ${skipped} earlier events`, ...lines] : lines).join('\n');
        }),
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'timeline_bisect',
      description:
        'Binary-search a timeline for the first step whose recorded context contains a ' +
        'marker string — find where a session went bad in log2(n) probes. ' +
        '`good` must be an earlier step on the same branch as `bad`.',
      parameters: {
        good: { type: 'string', required: true, description: 'A step id (or prefix) known to be fine.' },
        bad: { type: 'string', required: true, description: 'A later step id, prefix, or branch tip known to be bad.' },
        pattern: {
          type: 'string',
          required: true,
          description: 'Substring whose appearance in the materialized context marks a step as bad.',
        },
      },
      output: TEXT_OUTPUT,
      execute: async (args) =>
        store.run(async (repo) => {
          const result = await repo.bisect(args.good, args.bad, async (probe) => {
            const context = await probe.context();
            return !JSON.stringify(context.map((m) => m.event)).includes(args.pattern);
          });
          const introduced = result.introduced.map(preview).join('\n');
          return (
            `first bad step: ${result.firstBadId.slice(0, SHORT)}` +
            ` (${result.firstBad.meta.label ?? 'no label'}, ${result.probes} probes)\n` +
            `it introduced:\n${introduced}`
          );
        }),
    }),
  );
}
