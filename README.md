# agent-merge

Harness-neutral multi-agent coding orchestration plus Git-style version control for agent sessions. Run workers in isolated Git worktrees, test their patches, repair failed attempts, explicitly apply a winner, and retain every result as an auditable timeline.

English | [中文](#zh)

## Architecture

agent-merge is not implemented as a prompt-only Skill. It has three layers:

```text
Agent Skill / Harness plugin     choose a workflow and enforce usage policy
              ↓
Coding orchestration            worktrees, agents, evaluation, repair, selection
              ↓
Timeline core                   content-addressed events, DAG steps, merge, replay, bisect
```

The TypeScript library and CLI are the product core. The Agent Skill is a thin,
portable adapter that teaches compatible agents when and how to call that core.

## The problem

An agent's work is recorded as a flat list: user messages, model replies, tool calls, tool outputs, in time order. Three things are hard to do with a flat list:

1. At a decision point ("approach A or approach B?") the agent has to commit to one path. If that path fails, the run starts over.
2. Two attempts each learn something useful, and there is no way to combine what they learned into one session.
3. A 200-step run ends with a wrong conclusion. Finding the step that derailed it means reading the whole log.

Multi-agent setups add a fourth: after fanning out N agents and picking a winner, the other explorations are thrown away, including findings that were worth keeping.

## How it works

agent-merge stores a session the way git stores source code.

- An **event** is one record: a message, a tool call, a tool result, or an annotation (a written-down conclusion). Events are immutable and stored under the SHA-256 of their content, so identical events are stored once, across branches and across sessions.
- A **step** groups events, points at its parent step(s), and is content-addressed the same way. Steps form the session graph.
- A **branch** is a named pointer to a step. Branch names accept any script (`plan-a` and `方案A` are both valid).

The context at any step is reconstructed by walking the graph. A normal step contributes its events after its parent's context. A merge step records which steps it merged, their common fork point, and the event sequence the merge strategy resolved; its context is the fork point's context followed by that sequence. Reconstruction is a pure function of the graph, so any past state replays exactly and can be fed back to a model.

Every write (append, merge, branch, checkout) runs under a lock, held in-process and across processes through a lock directory, so concurrent writers cannot lose steps. A lock left behind by a crashed process expires and is reclaimed automatically. Reads never block.

## Install

```bash
npm install @guanzhengpm/agent-merge
```

The package has zero runtime dependencies. Node 20.19+ runs the built package; Node 23.6+ runs the repository source directly (no build step).

From a repository checkout, optionally install the complete Agent Skill for the
current user or only the current project:

```bash
./integrations/skill/install.sh
./integrations/skill/install.sh project
```

## CLI

```bash
agent-merge init
agent-merge root                                           # active repository
agent-merge status                                         # branch/evidence summary
agent-merge doctor                                         # scope and artifact audit
echo '[{"kind":"message","at":1,"actor":"user","payload":{"text":"hi"}}]' \
  | agent-merge append --label "turn 1"

agent-merge branch plan-a && agent-merge checkout plan-a   # fork
agent-merge log                                            # history
agent-merge diff main plan-a                               # what differs since the fork
agent-merge merge plan-a                                   # fold back
agent-merge materialize --pretty                           # the context a model would see
agent-merge append --on other-branch                       # write to a branch without switching
agent-merge merge b1 b2 b3 --strategy conclusions          # N-way merge; same strategies for 1..N branches
agent-merge bisect <good> <bad> --run 'sh check.sh'        # find the first bad step
```

Each record is one JSON event with four fields: `kind` (`message` / `tool_call` / `tool_result` / `annotation`), `at` (epoch milliseconds), `actor`, and `payload` (any JSON).

## Coding orchestration

`agent-merge run` is the end-to-end coding loop that the timeline-only commands deliberately do not provide:

```bash
agent-merge run \
  --task issue.md \
  --agents 3 \
  --runner auto \
  --test "pnpm test" \
  --retries 1
```

It requires a clean, checked-out Git branch. Each worker gets a temporary worktree at the same base commit. The acceptance command runs inside every worktree; only passing patches are eligible. The default judge selects the smallest passing patch, records structured candidate evidence in `.agent-merge/`, and writes a provenance report under `.agent-merge/runs/`. Selection does **not** modify the current branch by default; pass `--apply` explicitly to apply the winner without committing. If every first attempt fails, the evaluator output is fed back to all workers for a repair round. Use `--judge-command` to delegate selection to a harness/model command.

Agent, acceptance, and judge commands support independent timeouts. Recording defaults to `summary` (hashes, sizes, status, duration, files, and artifact references); `--recording redacted` stores bounded generically-redacted output, while `--recording full` is explicit opt-in. Worktrees isolate file changes but are not a security sandbox, so command flags must contain trusted input.

The orchestration core is not Codex-specific. A host with native sub-agents injects `AgentRunner` (or uses `CallbackAgentRunner`); any CLI/harness can use `--runner command --agent-command "..."`. The task is sent on stdin and these environment variables are provided: `AGENT_MERGE_WORKSPACE`, `AGENT_MERGE_BRANCH`, `AGENT_MERGE_ATTEMPT`, `AGENT_MERGE_TASK`, and, on repair rounds, `AGENT_MERGE_FEEDBACK`. `--runner auto` honors `AGENT_MERGE_RUNNER_COMMAND` first, then uses the verified Codex CLI adapter when available.

```ts
import { CallbackAgentRunner, CommandEvaluator, orchestrate } from '@guanzhengpm/agent-merge';

await orchestrate({
  projectDir: process.cwd(),
  task: 'Fix the issue in issue.md',
  runner: new CallbackAgentRunner('my-harness', (input) => spawnNativeSubagent(input)),
  evaluator: new CommandEvaluator('pnpm test'),
  agents: 3,
  retries: 1,
});
```

## Library

```ts
import { Repository } from '@guanzhengpm/agent-merge';

const repo = Repository.inMemory();          // or: await Repository.init('./session')

await repo.append(
  [{ kind: 'message', at: Date.now(), actor: 'user', payload: { text: 'Fix the failing test' } }],
  { label: 'turn 1' },
);

// Fork and try both approaches.
const forkPoint = await repo.head();
await repo.fork('plan-a');
await repo.append([{ kind: 'annotation', at: Date.now(), actor: 'assistant', payload: { text: 'A works, but slowly' } }]);

await repo.checkout('main');
await repo.fork('plan-b', forkPoint!);
await repo.append([{ kind: 'annotation', at: Date.now(), actor: 'assistant', payload: { text: 'B is the real fix' } }]);

// Fold both back; keep each branch's conclusions.
await repo.checkout('main');
await repo.mergeMany(['plan-a', 'plan-b'], { strategy: 'conclusions' });

const context = await repo.materialize();    // events ready to hand to a model
```

## Multi-agent exploration

Fan out one branch per agent. `append` with `{ branch }` (CLI: `--on`) writes to a branch directly and leaves HEAD alone, so parallel writers stay isolated. When the agents finish, fold every branch back in a single N-way merge whose strategy sees all tails at once:

```ts
await repo.mergeMany(['explore/a', 'explore/b', 'explore/c'], { strategy: 'conclusions' });
```

Built-in strategies. Expose the list to the coordinating agent and let it choose per situation:

| Strategy | Keeps | When |
|---|---|---|
| `conclusions` | each branch's `annotation` events | default for multi-agent: merge what was learned; raw history stays on the branches |
| `interleave` | everything, woven by timestamp | short histories where every step matters |
| `pickTailStrategy(i)` | one branch in full | a judge already chose the winner |
| `championStrategy(i)` | winner in full, plus the other branches' annotations | one branch won and the losers' findings are worth keeping |

A strategy is a function from `{ base, tails }` to an event list, so an LLM judge or synthesizer plugs in as a plain async function. Runnable demo: [examples/multi-agent-exploration.ts](examples/multi-agent-exploration.ts). CLI: `agent-merge merge b1 b2 b3 --strategy champion --winner b2`. The CLI accepts the same strategy set for any number of branches — `agent-merge merge b1 --strategy conclusions` folds back a single exploration; `ours` / `theirs` are shorthands for keeping just one side.

## Bisecting a bad run

```ts
const result = await repo.bisect(goodStep, badStep, async (probe) => {
  const context = await probe.context();       // full record up to the probed step
  return looksHealthy(context);                // your check: run a test, grep a marker, ask a model
});
console.log(result.firstBadId, result.introduced);
```

Reconstruction at any step is cheap, so a 1000-step session takes about 10 probes. The CLI variant runs a command per probe and passes the context file path in `$AGENT_MERGE_CONTEXT`.

## Integrations

- **Agent skill** ([integrations/skill](integrations/skill/)): a thin workflow router plus focused references following the [Agent Skills](https://agentskills.io) standard, usable from Claude Code, Codex CLI, pi, Gemini CLI, Cursor, OpenCode, and other adopters. It chooses when to call the CLI; storage and orchestration remain code. `integrations/skill/install.sh` installs the complete skill directory for every agent on the machine; `install.sh project` installs it into the current repository.
- **DeepSeek Harness plugin** ([integrations/dsh-plugin](integrations/dsh-plugin/)): subscribes to dsh's session append feed and records every session as a branch, and registers `timeline_*` tools (log, show, fork, merge, merge_many, bisect) so the agent inside dsh can operate on its own history. Built against the published `@deepseek-ai/*` type declarations.

## Design details

- Append-only. Recorded steps are never modified; changing history means creating a new branch. Any past state can be replayed and audited.
- Deterministic. The core reads no clock and uses no randomness, so two machines recording the same content produce byte-identical stores. Object ids depend only on content.
- Validated at the boundary. Data read from disk is schema-checked and hash-verified; a tampered file raises an error. Strings containing lone surrogates are rejected at write time, because UTF-8 encoding would silently alter them (`String.prototype.toWellFormed()` normalizes them first if needed).
- Payloads round-trip with identical values; JSON object keys are stored in sorted order. Sorted keys give identical content an identical hash.
- Storage sits behind two small interfaces (`ObjectStore`, `RefStore`). Filesystem and in-memory implementations are included; a database or cloud backend implements the same two.

## Status

v0.2, developer preview. The storage format is intended to be stable; APIs above it may still change. Orchestration includes injectable/native runners, generic commands, a Codex CLI adapter, Git worktrees, command evaluation, repair rounds, explicit patch application, timeouts, provenance reports, privacy-aware recording, repository diagnostics, and champion-style evidence fan-in. Planned: more first-party harness adapters, patch synthesis, trajectory-format (ATIF) import/export, branch deletion/garbage collection, and storage compaction.

### v0.2 behavior changes

- `agent-merge run` selects but does not apply by default; use `--apply` explicitly.
- persisted command/model output defaults to `summary`; `redacted` and `full` are opt-in modes.
- accidental nested timeline repositories are rejected unless `init --nested` is explicit.
- successful coding runs retain the winner's full recorded tail plus loser conclusions; failed runs retain conclusions only.
- reports include reproducibility fingerprints and repository-relative, hash-verified artifact references.

## License

[MIT](LICENSE)

---

<a id="zh"></a>

# agent-merge（中文）

面向不同 Harness 的多 Agent 编码编排，加上会话的 Git 式版本控制：在隔离 worktree 中并行解题，用测试筛选和修复 patch，显式选择是否把赢家应用回主分支，并保留可审计时间线。

## 架构

agent-merge 不是靠一份 prompt-only Skill 实现的，它分成三层：

```text
Agent Skill / Harness 插件      选择工作流并约束使用策略
              ↓
编码编排层                      worktree、Agent、验收、修复、选优
              ↓
轨迹核心                        内容寻址事件、DAG、合并、重放、二分排查
```

TypeScript Library 和 CLI 是产品核心；Agent Skill 是可移植的薄适配层，负责告诉兼容 Agent 何时、如何调用核心能力。

## 解决什么问题

Agent 的工作过程被记录成一条平铺的列表：用户消息、模型回复、工具调用、工具输出，按时间排列。这种结构下有三件事很难做：

1. 走到决策点（"方案 A 还是方案 B？"）只能选一条路，选错了整个任务重来。
2. 两次尝试各有收获，没有办法把两边学到的东西合进同一个会话。
3. 200 步之后发现结论错了，想知道是哪一步开始偏的，只能从头读日志。

多 agent 场景还有第四件：N 个 agent 并行探索、选出赢家之后，其余探索连同其中有价值的发现一起被丢弃。

## 怎么实现的

agent-merge 用 git 存代码的方式来存会话。

- **事件**是一条记录：一句消息、一次工具调用、一个工具结果、或一条批注（写下来的结论）。事件不可变，按内容的 SHA-256 存储，相同内容只存一份，跨分支、跨会话都生效。
- **步骤**把若干事件打包，指向父步骤，同样按内容寻址。步骤连起来构成会话图。
- **分支**是指向某个步骤的命名指针。分支名支持任意文字（`plan-a`、`方案A` 都合法）。

任何一步的上下文都通过遍历会话图重建：普通步骤在父步骤的上下文之后接上自己的事件；合并步骤记录它合并了哪些步骤、共同的分叉点、以及合并策略给出的事件序列，它的上下文就是分叉点的上下文加上这段序列。重建是会话图的纯函数，任何历史状态都能精确重放、直接喂给模型。

所有写操作（追加、合并、建分支、切换）都在锁内执行，进程内排队，跨进程用锁目录，并发写入不会丢步骤；进程崩溃残留的锁会在过期后被自动回收。读操作永不阻塞。

## 安装

```bash
npm install @guanzhengpm/agent-merge
```

零运行时依赖。Node 20.19+ 可运行构建产物；Node 23.6+ 可直接运行仓库源码，无需构建。

从仓库 checkout 中可以选择安装完整 Agent Skill：

```bash
./integrations/skill/install.sh          # 当前用户
./integrations/skill/install.sh project  # 仅当前项目
```

## 命令行

```bash
agent-merge init
agent-merge root                                           # 当前实际使用的轨迹库
agent-merge status                                         # 分支与证据摘要
agent-merge doctor                                         # 作用域、时间与产物审计
echo '[{"kind":"message","at":1,"actor":"user","payload":{"text":"你好"}}]' \
  | agent-merge append --label "第一轮"

agent-merge branch 方案A && agent-merge checkout 方案A     # 分叉
agent-merge log                                           # 看历史
agent-merge diff main 方案A                                # 分叉后两边差了什么
agent-merge merge 方案A                                    # 合回来
agent-merge materialize --pretty                          # 此刻模型会看到的完整上下文
agent-merge append --on 其他分支                            # 定向写入，不切换当前分支
agent-merge merge 甲 乙 丙 --strategy conclusions          # N 路合并；单分支也用同一套策略
agent-merge bisect <好的步骤> <坏的步骤> --run 'sh check.sh'  # 二分定位出错步骤
```

每条记录是一个 JSON 事件，四个字段：`kind`（`message` / `tool_call` / `tool_result` / `annotation`）、`at`（毫秒时间戳）、`actor`（谁）、`payload`（任意 JSON）。

## 编码编排

`agent-merge run` 补齐从“开多分支”到“代码合回去”的完整链路：

```bash
agent-merge run \
  --task issue.md \
  --agents 3 \
  --runner auto \
  --test "pnpm test" \
  --retries 1
```

命令要求当前是干净、已检出的 Git 分支。每个 worker 从同一 commit 获得临时 worktree；验收命令在各自 worktree 内运行，只有通过的 patch 才能成为赢家。默认评委选择改动最小的通过 patch，把结构化候选证据写入 `.agent-merge/`，并在 `.agent-merge/runs/` 保存 provenance 报告。默认只选择、不修改当前工作树；必须显式传入 `--apply` 才应用赢家且不自动提交。首轮全部失败时，会把 evaluator 输出反馈给所有 worker，自动进入修复轮。`--judge-command` 可把 winner 选择交给主 Harness 或模型。

Agent、验收和评委命令分别支持超时。记录默认采用 `summary`，只保留哈希、大小、状态、耗时、文件和产物引用；`--recording redacted` 保存有界脱敏输出，`--recording full` 必须显式开启。worktree 只隔离文件改动，不是安全沙箱，因此命令参数必须来自可信输入。

编排核心不绑定 Codex：有原生 sub-agent 的主 Harness 直接注入 `AgentRunner` / `CallbackAgentRunner`；任意 CLI 用 `--runner command --agent-command "..."`。任务通过 stdin 传递，同时提供 `AGENT_MERGE_WORKSPACE`、`AGENT_MERGE_BRANCH`、`AGENT_MERGE_ATTEMPT`、`AGENT_MERGE_TASK`，修复轮额外提供 `AGENT_MERGE_FEEDBACK`。`--runner auto` 优先采用 `AGENT_MERGE_RUNNER_COMMAND`，否则在可用时使用已验证的 Codex CLI adapter。

## 代码调用

```ts
import { Repository } from '@guanzhengpm/agent-merge';

const repo = Repository.inMemory();          // 或 await Repository.init('./目录') 落盘

await repo.append(
  [{ kind: 'message', at: Date.now(), actor: 'user', payload: { text: '修复失败的测试' } }],
  { label: '第一轮' },
);

// 分叉，两个方案都试
const 分叉点 = await repo.head();
await repo.fork('方案A');
await repo.append([{ kind: 'annotation', at: Date.now(), actor: 'assistant', payload: { text: 'A 可行，但很慢' } }]);

await repo.checkout('main');
await repo.fork('方案B', 分叉点!);
await repo.append([{ kind: 'annotation', at: Date.now(), actor: 'assistant', payload: { text: 'B 才是根治' } }]);

// 一步收拢，只保留各分支的结论
await repo.checkout('main');
await repo.mergeMany(['方案A', '方案B'], { strategy: 'conclusions' });

const context = await repo.materialize();    // 可直接交给模型的事件序列
```

## 多 agent 探索

每个 agent 一条分支。`append` 传入 `{ branch }`（命令行用 `--on`）就直接写到指定分支、完全不碰当前分支，所以并行写入互不干扰。探索结束后，一次 N 路合并收拢所有分支，合并策略能同时看到每条支线：

```ts
await repo.mergeMany(['探索/甲', '探索/乙', '探索/丙'], { strategy: 'conclusions' });
```

内置策略如下。把这张表交给负责协调的主 agent，让它按情况自己选：

| 策略 | 保留什么 | 适用场景 |
|---|---|---|
| `conclusions` | 各分支的 `annotation` 结论 | 多 agent 的推荐默认：合并学到的东西，原始过程留在支线备查 |
| `interleave` | 全部事件，按时间织成一条线 | 历史很短、每一步都重要 |
| `pickTailStrategy(i)` | 完整保留一条分支 | 评委已经选出赢家 |
| `championStrategy(i)` | 赢家全量，外加其他分支的结论 | 有明确赢家，输家的发现也值得保留 |

策略本质是一个从 `{ base, tails }` 到事件列表的函数，让 LLM 当评委或做综合，写一个普通的 async 函数接上即可。可运行的演示：[examples/multi-agent-exploration.ts](examples/multi-agent-exploration.ts)。命令行写法：`agent-merge merge 甲 乙 丙 --strategy champion --winner 乙`。命令行的 merge 不论合几条分支都用同一套策略——`agent-merge merge 甲 --strategy conclusions` 收拢单条探索分支；`ours` / `theirs` 是"只保留一边"的简写。

## 二分排查

```ts
const result = await repo.bisect(好的步骤, 坏的步骤, async (probe) => {
  const context = await probe.context();       // 到这一步为止的完整记录
  return 看起来还正常吗(context);               // 检查方式自定：跑测试、搜关键词、问模型
});
console.log(result.firstBadId, result.introduced);
```

任意一步的上下文重建成本很低，1000 步的会话约 10 次探测即可定位。命令行版本每次探测执行一条命令，把上下文文件路径放在 `$AGENT_MERGE_CONTEXT` 环境变量里。

## 两种现成的集成

- **通用 Agent Skill**（[integrations/skill](integrations/skill/)）：按 [Agent Skills](https://agentskills.io) 开放标准提供薄路由入口和按需 references。Skill 决定何时调用，存储与编排仍由代码实现。运行 `integrations/skill/install.sh` 会安装完整 Skill 目录，`install.sh project` 装进当前仓库。
- **DeepSeek Harness 插件**（[integrations/dsh-plugin](integrations/dsh-plugin/)）：订阅 dsh 的会话事件流，把每个会话自动记录成一条分支，并注册 `timeline_*` 工具（查看、分叉、合并、N 路合并、二分排查），让 dsh 里的 agent 可以操作自己的历史。基于官方发布的 `@deepseek-ai/*` 类型声明编写并通过类型检查。

## 设计细节

- 只增不改。写入的步骤永不修改，改历史等于开新分支，任何历史状态都可重放、可审计。
- 确定性。核心代码不读系统时间、不用随机数，两台机器记录相同内容会得到逐字节相同的存储；对象 id 只由内容决定。
- 边界校验。从磁盘读回的数据要过 schema 校验和哈希校验，文件被篡改会直接报错。含残缺代理对的字符串在写入时被拒绝（UTF-8 编码会悄悄改掉它们），需要时可先用 `String.prototype.toWellFormed()` 规范化。
- 内容按值原样往返，JSON 对象的键按字母序存储；排序后的键让相同内容得到相同哈希。
- 存储层是两个小接口（`ObjectStore`、`RefStore`），内置文件系统和内存两种实现，接数据库或云端也是实现同样两个接口。

## 状态

v0.2 开发者预览。存储格式计划保持稳定，其上的 API 仍可能调整。编排层已经包含可注入/原生 Runner、通用命令、Codex CLI adapter、Git worktree、命令验收、失败修复轮、显式 patch 应用、超时、provenance 报告、隐私感知记录、仓库诊断和 champion 式证据归并。后续计划：更多一方 Harness adapter、patch 综合、ATIF 导入导出、分支删除/垃圾回收和存储压缩。

### v0.2 行为变化

- `agent-merge run` 默认只选择、不应用；必须显式传入 `--apply`。
- 命令和模型输出默认使用 `summary` 记录；`redacted` 与 `full` 需要主动选择。
- 默认拒绝意外嵌套的轨迹库；只有显式 `init --nested` 才允许。
- 编码成功时保留赢家完整轨迹和失败分支结论；全失败时只归并结论。
- 报告包含可复现 fingerprint，以及仓库相对路径和哈希校验的产物引用。

## 许可证

[MIT](LICENSE)
