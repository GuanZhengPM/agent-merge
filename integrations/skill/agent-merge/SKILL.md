---
name: agent-merge
description: Save-points, parallel timelines, and failure bisection for agent work. Use when the user wants to checkpoint progress, try two approaches in parallel, combine findings from different attempts, roll back to an earlier point, or find which step of a long session went wrong. Triggers include 存档 / 分叉 / 两个方案都试 / 合并结论 / 回滚 / 哪一步出错, checkpoint, fork, try both ways, merge findings, bisect.
license: MIT
compatibility: Requires the agent-merge CLI on PATH (npm install -g agent-merge) and a shell tool.
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
tell the user to install it (`npm install -g agent-merge`) and stop.

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
