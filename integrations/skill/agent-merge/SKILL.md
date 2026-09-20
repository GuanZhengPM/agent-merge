---
name: agent-merge
description: Multi-agent coding orchestration and evidence-aware trajectory versioning. Use when the user wants isolated coding attempts with test-gated selection, a checkpoint, controlled comparison, merged findings, session recovery, or failure bisection. Triggers include 多 agent / 多分支解题 / 自动验收 / 存档 / 分叉 / 两个方案都试 / 合并结论 / 回滚 / 哪一步出错, multi-agent coding, worktree, test and merge, checkpoint, fork, merge findings, bisect.
license: MIT
compatibility: Requires the agent-merge CLI on PATH (npm install -g @guanzhengpm/agent-merge) and a shell tool.
metadata:
  author: agent-merge
  version: "0.2.0"
---

# agent-merge

Use agent-merge as a thin control layer over its CLI and timeline engine. The Skill chooses a workflow and preserves authorization boundaries; the CLI performs storage, isolation, evaluation, selection, and merging.

Run `agent-merge help` first. If unavailable, tell the user to install `@guanzhengpm/agent-merge` and stop.

## Preflight

Before any write:

1. Run `agent-merge root` when a repository may already exist. Use `agent-merge status` and, for audits or resumed work, `agent-merge doctor`.
2. Keep one timeline repository per project. `agent-merge init` rejects accidental nesting; use `--nested` only when the nested scope is deliberate and explain it to the user.
3. Preserve unrelated working-tree changes. Coding orchestration requires a clean Git worktree except for `.agent-merge/` metadata.
4. Never record secrets, credentials, personal data, or unnecessary proprietary output. Read [references/evidence-and-privacy.md](references/evidence-and-privacy.md) before configuring automatic recording.

## Select one primary workflow

### Coding implementation

Use when the user authorized actual code changes and multiple isolated attempts add value. Read [references/coding-run.md](references/coding-run.md).

```bash
agent-merge run --task task.md --agents 3 --runner auto --test '<acceptance command>'
```

This evaluates and selects without applying by default. Add `--apply` only when the user authorized modifying the working tree. A passing acceptance command is necessary; agent prose is never sufficient evidence.

### Checkpoint, resume, or timeline inspection

Use for durable save-points, continuing earlier work, or understanding what changed. Read [references/timeline.md](references/timeline.md).

### Controlled comparison

Use when alternatives must share frozen inputs and decision criteria, including non-code experiments. Read [references/controlled-comparison.md](references/controlled-comparison.md).

### Failure bisection

Use only when a known-good step precedes a known-bad step and the predicate is deterministic or demonstrably stable. Read [references/timeline.md](references/timeline.md). An annotation-only journal is not enough for causal bisection.

## Merge policy

Inspect `diff` and materialized branch evidence before merging.

| Strategy | Use when |
|---|---|
| `conclusions` | no execution won, or only findings should enter main |
| `interleave` | every event is compatible and chronology matters |
| `pick --winner B` | exactly one tail matters and losing findings add no value |
| `champion --winner B` | one execution won, while loser conclusions remain useful |

Successful coding orchestration should retain the winner's full recorded tail plus loser conclusions. Failed runs should merge conclusions only.

## Reporting

- Show step ids in 12-character form with labels.
- State the active branch after checkout or merge.
- Separate observed facts, inferred causes, and proposals.
- Include denominators, failures, unknowns, recording mode, and whether a patch was applied.
- Never rewrite history. Append a correction naming the superseded conclusion.
