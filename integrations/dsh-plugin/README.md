# dsh-plugin-agent-merge

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
that gives dsh sessions a forkable, mergeable, bisectable history, backed by
[agent-merge](../../README.md).

## What it does

**Records sessions.** In dsh, persistence is a plugin concern: plugins
subscribe to the post-commit append feed and write events out on the
`session/flush` durability checkpoint. This plugin does exactly that — every
committed session event is mirrored into an agent-merge store, one branch per
session (`dsh/<session-id>`), one step per flush batch. The full original
event (`type`, `seq`, `data`) rides in each payload, so the recorded timeline
is losslessly replayable.

**Gives the agent timeline tools.** Five tools are registered when a tool
registry is present:

| Tool | What the agent can do with it |
|---|---|
| `timeline_log` | list recorded branches / recent steps |
| `timeline_show` | inspect the replayable context at any step |
| `timeline_fork` | branch a timeline at any point to explore an alternative |
| `timeline_merge` | fold a branch back (`interleave` / `ours` / `theirs`) |
| `timeline_bisect` | binary-search a session for the step that introduced a marker |

## Configuration

```yaml
# in your dsh profile
plugins:
  dsh-plugin-agent-merge:
    path: /path/to/workspace   # where .agent-merge/ lives (default: cwd)
    record: true               # mirror session events (default)
    tools: true                # register timeline_* tools (default)
```

## Notes

- Built and typechecked against the published `@deepseek-ai/*` type
  declarations (`cordis`, `dsh-session`, `dsh-tools`, `dsh-llm`). dsh is a
  developer preview and its extension contracts may still change; if a dsh
  update breaks this plugin, the binding surface is three small files
  (`src/index.ts`, `src/recorder.ts`, `src/tools.ts`).
- All store operations are serialized through one queue, so concurrent
  sessions and tool calls cannot interleave a checkout with an append.
- The `agent-merge` dependency is declared as `file:../..` for in-repo
  development and CI; a standalone npm release would pin a published version
  instead.

## Develop

```bash
npm install
npm run typecheck   # strict, includes tests
npm test            # node --test (no build needed, Node ≥ 23.6)
npm run build       # emit lib/
```
