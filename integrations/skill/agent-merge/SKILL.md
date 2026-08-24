---
name: agent-merge
description: Multi-agent coding orchestration, save-points, parallel timelines, and failure bisection. Use when the user wants several agents to solve a coding task in isolated worktrees, test and merge a winner, checkpoint progress, try alternatives, combine findings, roll back, or find which step went wrong. Triggers include 多 agent / 多分支解题 / 自动验收 / 存档 / 分叉 / 两个方案都试 / 合并结论 / 回滚 / 哪一步出错, multi-agent coding, worktree, test and merge, checkpoint, fork, merge findings, bisect.
license: MIT
compatibility: Requires the agent-merge CLI on PATH (npm install -g @guanzhengpm/agent-merge) and a shell tool.
metadata:
  author: agent-merge
  version: "0.1.0"
---

# agent-merge: session save-points, forks, merges, and bisect

agent-merge is a CLI that versions a *timeline of events* the way git versions
files. You (the agent) use it as a structured work journal: record meaningful
moments as events, fork parallel timelines when exploring alternatives, merge
what each alternative learned, and bisect the journal when something went wrong.

Run `agent-merge help` for the full command list. If the command is missing,
tell the user to install it (`npm install -g @guanzhengpm/agent-merge`) and stop.

## Ground rules

- Keep one repository per project: run `agent-merge init` once in the project
  root (creates `.agent-merge/`). If a repository already exists, reuse it.
- Record **milestones, not noise**: decisions taken, conclusions reached,
  important tool results, user requirements. One `append` per milestone,
  with a short `--label`.
- Event format (JSON, single object or array), all four fields required:

```json
{"kind": "message", "at": 1723456789000, "actor": "assistant", "payload": {"text": "..."}}
```

  - `kind`: `message` (said), `tool_call` (did), `tool_result` (observed),
    `annotation` (concluded).
  - `at`: current epoch milliseconds (`date +%s000`).
  - `actor`: `user`, `assistant`, or a tool name.
  - `payload`: any JSON. Put the substance here.

## Workflows

**End-to-end coding fan-out / test / repair / merge** — prefer this when the
user wants actual code alternatives rather than timeline-only exploration:

```bash
agent-merge run --task issue.md --agents 3 --runner auto --test '<acceptance command>' --retries 1
```

- The working tree must be clean. The command creates isolated temporary Git
  worktrees, runs workers in parallel, evaluates each patch, feeds failures
  into a repair round, selects a passing winner, applies it without committing,
  and records a JSON report plus timeline events.
- Use the current harness's native sub-agent adapter when it exposes one. In an
  embedded integration, inject `AgentRunner` / `CallbackAgentRunner`. From the
  standalone CLI, configure any harness with
  `--runner command --agent-command '<worker command>'`; the task is provided on
  stdin. `--runner auto` uses `AGENT_MERGE_RUNNER_COMMAND` when set, otherwise a
  detected supported adapter.
- The acceptance command is mandatory. Do not select a winner from agent prose
  alone. Use `--dry-run` when the user only wants comparison and no code applied.
- If no candidate passes after the configured repair rounds, report failure and
  leave the main code untouched. Never merge a failing patch just to produce a
  winner.

**Checkpoint (存档)** — after completing a meaningful unit of work:

```bash
echo '[{"kind":"annotation","at":<now-ms>,"actor":"assistant","payload":{"text":"<what was achieved / decided>"}}]' | agent-merge append --label "<milestone>"
```

**Fork to try two approaches (分叉)** — before committing to one path:

1. `agent-merge branch approach-a && agent-merge checkout approach-a`
2. Work on approach A; append its findings as events.
3. `agent-merge checkout main`, then `agent-merge branch approach-b --at main`,
   `agent-merge checkout approach-b`; work on B; append findings.
4. Tell the user what each branch holds (`agent-merge diff approach-a approach-b`).

**Merge findings (合并)** — when a winner is chosen or both matter:

```bash
agent-merge checkout main
agent-merge merge approach-a --strategy interleave
```

Then append one `annotation` summarizing what the merged timeline established
(you are the smart merge strategy). `--strategy ours|theirs` discards the
other side instead.

**Multi-agent fan-out / fan-in (多路探索与归并)** — explore with several
agents (or several attempts) in parallel, then fold all results back at once:

1. Fork one branch per explorer from the shared starting point:
   `agent-merge branch explore/a --at main` (repeat for b, c, …).
2. Record each explorer's work onto its own branch with targeted appends —
   `agent-merge append --on explore/a` — which never touches HEAD, so
   parallel writers cannot interfere. Have each explorer end with an
   `annotation` event summarizing what it concluded.
3. Fold everything back in one N-way merge:
   `agent-merge checkout main && agent-merge merge explore/a explore/b explore/c --strategy <S>`

Choose `<S>` yourself, based on the situation:

| Strategy | Keeps | Choose when |
|---|---|---|
| `conclusions` | only each branch's `annotation` events | the usual default: merge what was learned, not raw histories (small context, no fake linear history) |
| `interleave` | everything, woven by timestamp | histories are short and every step matters |
| `pick --winner B` | branch B only | one attempt clearly won; the rest add nothing |
| `champion --winner B` | B in full + others' annotations | B won, but the losers' findings are worth salvaging |

You are the judge: inspect the branches (`agent-merge diff`, `agent-merge
materialize <branch>`) and decide the strategy and winner before merging.
After the merge, append one `annotation` summarizing the combined outcome.

**Bisect a failure (二分排查)** — a long session produced a wrong conclusion:

1. Identify a step id that was still good and one that is bad (`agent-merge log`).
2. Write a small check script reading `$AGENT_MERGE_CONTEXT` (a JSON file of
   events up to the probed step) that exits non-zero when the record already
   looks wrong.
3. `agent-merge bisect <good-id> <bad-id> --run '<check command>'`
4. Report the first bad step and the events it introduced to the user.

**Inspect** — `agent-merge log` (history), `agent-merge materialize --pretty`
(full record at HEAD), `agent-merge diff <a> <b>` (what differs).

## Reporting to the user

Always show step ids as the 12-character short form printed by the CLI, with
their labels. After forks/merges, state which branch is current. Never delete
or rewrite recorded history — append corrections as new `annotation` events.
