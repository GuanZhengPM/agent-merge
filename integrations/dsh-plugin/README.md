# dsh-plugin-agent-merge

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin
that gives dsh sessions a forkable, mergeable, bisectable history, backed by
[agent-merge](../../README.md).

## What it does

**Records sessions.** In dsh, persistence is a plugin concern: plugins
subscribe to the post-commit append feed and write events out on the
`session/flush` durability checkpoint. This plugin does exactly that — every
committed session event is mirrored into an agent-merge store, one branch per
session (`dsh/<session-id>`), one step per flush batch. Generic redaction is
enabled by default. Hosts can choose `summary`, `redacted`, or explicit
`full` recording and can supply a domain-specific redactor.

**Gives the agent timeline tools.** Six tools are registered when a tool
registry is present:

| Tool | What the agent can do with it |
|---|---|
| `timeline_log` | list recorded branches / recent steps |
| `timeline_show` | inspect the replayable context at any step |
| `timeline_fork` | branch a timeline at any point to explore an alternative |
| `timeline_merge` | fold a branch back (`interleave` / `ours` / `theirs`) |
| `timeline_merge_many` | fold several timelines back in one N-way merge |
| `timeline_bisect` | binary-search a session for the step that introduced a marker |

**Optionally orchestrates real coding workers.** When an `orchestration`
configuration is explicitly supplied, the plugin also registers `coding_run`.
It creates isolated Git worktrees, starts workers through DSH's own
`ctx.subagents` provider (or a configured CLI/programmatic `AgentRunner`), runs
a fixed acceptance command, retries failures with evaluator feedback, selects
a passing patch, and optionally applies it. Timeline tools alone never pretend
to merge code.

## Configuration

Install the published bundle into an existing dsh profile:

```bash
dsh plugin --profile web add dsh-plugin-agent-merge
dsh --profile web --dump-config   # verify the bundle layer
dsh --profile web
```

The bundle enables recording and timeline tools by default. Its shipped
`cordis.patch.yml` is equivalent to:

```yaml
- insert:
    - id: agent-merge
      name: dsh-plugin-agent-merge
      config:
        record: true
        recordingMode: redacted
        tools: true
```

`path` defaults to the harness process working directory, where the plugin
creates `.agent-merge/`. A profile may override the inserted `agent-merge`
row when it needs a fixed workspace path. Accidental nested stores are rejected;
set `allowNested: true` only for an intentionally independent nested scope.

Coding orchestration is off by default because it launches workers; applying
a winner additionally modifies a Git working tree. In an ordinary DSH profile it uses the native
`spawn` subagent provider by default:

```yaml
- insert:
    - id: agent-merge
      name: dsh-plugin-agent-merge
      config:
        record: true
        tools: true
        orchestration:
          projectPath: /workspace/project
          subagentProvider: spawn
          testCommand: pnpm test
          agents: 3
          retries: 1
          apply: true
          recordingMode: summary
```

Each native child receives the assigned worktree's absolute path and strict
instructions to keep every read, write, and command inside it. The orchestrator
then accepts only the patch actually collected from that worktree and refuses
to apply a winner if the parent checkout changed during the run.
`apply` defaults to `false`; the example opts in explicitly.

For a different Harness/CLI, set `runnerCommand: my-agent --non-interactive`.
That process reads the task from stdin and receives
`AGENT_MERGE_WORKSPACE`, `AGENT_MERGE_BRANCH`, `AGENT_MERGE_ATTEMPT`,
`AGENT_MERGE_TASK`, and (during repair) `AGENT_MERGE_FEEDBACK`. A DSH host
can also import `registerCodingRunTool` and provide an `AgentRunner` directly.

For local development, install the checkout from the repository root:

```bash
dsh plugin --profile web add ./integrations/dsh-plugin
```

## Notes

- Built and typechecked against the published `@deepseek-ai/*@0.1.1-rc.2`
  release train (`cordis`, `dsh-session`, `dsh-tools`, `dsh-llm`). dsh is a
  developer preview and its extension contracts may still change; if a dsh
  update breaks this plugin, the binding surface is three small files
  (`src/index.ts`, `src/recorder.ts`, `src/tools.ts`).
- The DSH packages are optional peers supplied by the harness at runtime and
  mirrored in `devDependencies` for standalone typechecking and tests. A small
  local type bridge keeps the used Cordis augmentations stable across pnpm's
  optional-peer virtual package layouts; it emits no runtime behavior.
- All store operations are serialized through one queue, so concurrent
  sessions and tool calls cannot interleave a checkout with an append.
- The workspace uses `@guanzhengpm/agent-merge: workspace:^` during
  development. `pnpm pack` and `pnpm publish` rewrite that specifier to the
  matching published semver range, so registry consumers never receive a
  local filesystem path.

## Develop

```bash
pnpm install
pnpm run typecheck   # strict, includes tests
pnpm test            # node --test (no build needed, Node ≥ 23.6)
pnpm run build       # emit lib/
pnpm pack           # verify the publishable tarball
```

## Publish

The repository's **Publish npm packages** GitHub Actions workflow is the
preferred release path. Configure an `npm` environment with an `NPM_TOKEN`
secret, then dispatch the workflow. It runs all checks, publishes the core
first, publishes this dependent bundle second, and attaches npm provenance.

For a local release, publish in the same order:

```bash
pnpm install --frozen-lockfile
pnpm publish --access public
pnpm --dir integrations/dsh-plugin publish --access public
```

The public package names are `@guanzhengpm/agent-merge` for the library/CLI
and `dsh-plugin-agent-merge` for the installable DSH bundle.
