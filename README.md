# agent-merge

> Multi-agent coding orchestration with Git-style version control for agent sessions.  
> 面向多 Agent 协同编码的编排框架与会话级 Git 版本控制系统：在独立 Worktree 中并发探索，通过测试筛选补丁，保留可审计的 DAG 轨迹。

[English](#english) · [简体中文](#简体中文)

---

<a id="简体中文"></a>

## 简体中文

### 背景与解决的问题

在传统的 Agent 运行时中，任务记录通常被存储为扁平的时间序列（用户输入、模型回复、工具调用及结果）。这种单一线性结构在应对复杂编程任务时存在明显限制：

1. **分叉试错成本高**：面对技术路线分歧（如方案 A 与方案 B）时，Agent 只能单线前行；一旦路线选错，往往需要整体回滚或重新开局；
2. **多并发探索价值丢失**：并发派发多个 Agent 尝试解决同一问题并选出最优方案后，未获选分支的所有探索过程与经验结论通常被直接丢弃；
3. **长链路排错困难**：经历多轮交互后若发现最终结论偏差，缺乏类似 `git bisect` 的高效二分定位工具，排查原因需肉眼检索海量日志。

`agent-merge` 采用类似 Git 的内容寻址图结构（DAG）来管理 Agent 的会话历史，并结合 Git worktree 实现轻量隔离的并发编码编排。

### 架构设计

```text
Agent Skill / Harness 插件    定义工作流策略与模型调用规范
             ↓
编码编排层 (Orchestration)     Git worktree 隔离、并发任务下发、测试验收、修复轮次、补丁优选
             ↓
轨迹核心层 (Timeline Core)    内容寻址事件 (Event)、DAG 步骤 (Step)、分支与合并、上下文重放、二分排错
```

* **事件 (Event)**：不可变记录（消息、工具调用、工具输出、结论批注），按 SHA-256 内容寻址存储，跨分支去重；
* **步骤 (Step)**：打包一组事件并指向父步骤，构成有向无环图；
* **分支 (Branch)**：指向具体步骤的命名指针，支持分支并行写入；
* **上下文重建 (Materialization)**：上下文为 DAG 遍历的纯函数，任意历史分叉点均可精确重建并重新交由模型推理。

### 快速开始

#### 安装

```bash
npm install @guanzhengpm/agent-merge
```

* 运行时要求：Node.js 20.19+（直接运行源码需 Node.js 23.6+）
* 零外部运行时依赖。

#### 1. 终端命令行基础操作

```bash
# 初始化会话库
agent-merge init

# 追加一轮对话
echo '[{"kind":"message","at":1,"actor":"user","payload":{"text":"优化认证逻辑"}}]' \
  | agent-merge append --label "第一轮"

# 针对方案 A 创建分支并切换
agent-merge branch plan-a && agent-merge checkout plan-a

# 查看历史与分支差异
agent-merge log
agent-merge diff main plan-a

# 重建当前分支模型可见的完整上下文
agent-merge materialize --pretty
```

#### 2. 多 Agent 协同编码运行 (`agent-merge run`)

`agent-merge run` 提供了开箱即用的多 Agent 并行开发闭环：

```bash
agent-merge run \
  --task issue.md \
  --agents 3 \
  --runner auto \
  --test "pnpm test" \
  --retries 1 \
  --apply
```

**执行流程**：
1. 检查当前 Git 工作区干净度，从同一 Base Commit 为每个 worker 创建独立的临时 Git worktree；
2. 并发执行改动；各 worktree 内独立运行 `--test` 指定的验收测试；
3. 仅测试通过的补丁进入候选池；默认评判策略选取改动量最小的有效 Patch；
4. 若首轮全部未通过测试，自动将报错反馈回传给各 worker，进入修复轮（Repair Round）；
5. 传入 `--apply` 参数后，自动将优胜补丁应用回当前主工作区，并保存完整 provenance 审计报告。

### 代码调用示例

```ts
import { Repository } from '@guanzhengpm/agent-merge';

const repo = Repository.inMemory(); // 或落盘存储：await Repository.init('./session-db')

// 记录初始问题
await repo.append(
  [{ kind: 'message', at: Date.now(), actor: 'user', payload: { text: '修复失败的测试用例' } }],
  { label: 'turn 1' },
);

// 建立两个分支并发探索
const forkPoint = await repo.head();

await repo.fork('plan-a');
await repo.append([{ kind: 'annotation', at: Date.now(), actor: 'assistant', payload: { text: '方案 A：重写缓存层' } }]);

await repo.checkout('main');
await repo.fork('plan-b', forkPoint!);
await repo.append([{ kind: 'annotation', at: Date.now(), actor: 'assistant', payload: { text: '方案 B：修正边界条件' } }]);

// N 路合并：合并两个分支的结论批注
await repo.checkout('main');
await repo.mergeMany(['plan-a', 'plan-b'], { strategy: 'conclusions' });

// 重建当前上下文供模型使用
const context = await repo.materialize();
```

### 多分支合并策略

| 策略名 | 合并行为 | 适用场景 |
| :--- | :--- | :--- |
| `conclusions` | 仅保留各分支的 `annotation` 结论 | 推荐默认：提取各分支探索经验，底层流水日志留存原分支备查 |
| `interleave` | 按时间戳严格交错合并所有事件 | 短时序且每一步操作都不可或缺的场景 |
| `pickTailStrategy(i)` | 完整保留第 `i` 个获胜分支 | 已由外部测试或人工选定单一胜出方案 |
| `championStrategy(i)` | 保留胜出分支完整事件 + 失败分支的经验批注 | 存在胜出方案，同时需要保留其他分支排错结论的场景 |

### 二分排查 (`bisect`)

当长达数百步的复杂会话出现异常时，无需逐行人工查阅日志，可使用确定性的二分排查定位问题引入点：

```ts
const result = await repo.bisect(goodStepId, badStepId, async (probe) => {
  const context = await probe.context();
  return isStepNormal(context); // 用户自定义检查逻辑：跑测试、检索关键词或模型判断
});

console.log(`错误引入步骤: ${result.firstBadId}`);
```

### 现成集成

* **Agent Skill** (`integrations/skill`)：符合 [Agent Skills](https://agentskills.io) 开放标准，提供通用工具封装；
* **DeepSeek Harness 插件** (`integrations/dsh-plugin`)：订阅 DSH 会话流，自动分支化记录会话并暴露 `timeline_*` 工具集。

### License

[MIT](LICENSE)

---

<a id="english"></a>

## English

### Overview

`agent-merge` introduces Git-style version control and orchestration for multi-agent coding sessions. Rather than treating an agent's history as a flat, disposable log, it models execution as a content-addressed directed acyclic graph (DAG) of immutable events, while using Git worktrees to isolate parallel attempts.

### Problem Statement & Background

In traditional agent runtimes, interaction history is recorded as a flat, chronological sequence (user prompts, model replies, tool invocations, and tool results). This linear structure creates major bottlenecks when tackling complex software tasks:

1. **High Branching Costs**: At architectural decision points (e.g., Approach A vs. Approach B), agents must commit to a single sequential path; choosing wrong often requires rolling back the entire session.
2. **Discarded Exploratory Value**: When fan-out exploration evaluates $N$ parallel agents to pick a single winner, intermediate findings, edge-case discoveries, and negative lessons from the rejected branches are discarded entirely.
3. **Tedious Debugging in Long Sessions**: After hundreds of steps, discovering that an agent diverged from the goal requires manually reading through massive transcripts, lacking an automated `git bisect` equivalent.

`agent-merge` addresses these problems by treating agent history as a content-addressed Directed Acyclic Graph (DAG) and orchestrating multi-worker exploration using lightweight Git worktrees.

### Architecture

```text
Agent Skill / Harness Plugin    Defines workflow policies and usage constraints
             ↓
Coding Orchestration            Git worktree isolation, multi-agent dispatch, test gating, repair rounds, patch selection
             ↓
Timeline Core                   Content-addressed Events, DAG Steps, branch & merge, context replay, session bisecting
```

* **Event**: An immutable record (message, tool call, tool result, or annotation) addressed by the SHA-256 hash of its content, deduplicated across branches and sessions.
* **Step**: Groups events and references parent step(s), forming the execution DAG.
* **Branch**: A named pointer to a step, supporting concurrent writes without HEAD conflicts.
* **Materialization**: Pure-function context reconstruction by graph traversal, enabling exact replay and re-prompting from any historical step.

### Quick Start

#### Installation

```bash
npm install @guanzhengpm/agent-merge
```

* Requirements: Node.js 20.19+ (Node.js 23.6+ to run repository source directly without compilation).
* Zero external runtime dependencies.

#### 1. Basic CLI Workflow

```bash
# Initialize timeline repository
agent-merge init

# Append an interaction event
echo '[{"kind":"message","at":1,"actor":"user","payload":{"text":"Optimize auth flow"}}]' \
  | agent-merge append --label "turn 1"

# Create and checkout a branch for Approach A
agent-merge branch plan-a && agent-merge checkout plan-a

# View history and branch diffs
agent-merge log
agent-merge diff main plan-a

# Reconstruct full context visible to the model
agent-merge materialize --pretty
```

#### 2. End-to-End Multi-Agent Coding (`agent-merge run`)

`agent-merge run` provides a complete coding loop with worktree isolation and automated test selection:

```bash
agent-merge run \
  --task issue.md \
  --agents 3 \
  --runner auto \
  --test "pnpm test" \
  --retries 1 \
  --apply
```

**Workflow**:
1. Checks for a clean Git branch and provisions temporary Git worktrees from the same base commit for each worker;
2. Workers execute changes in isolation; acceptance tests (`--test`) run independently inside each worktree;
3. Only passing patches are eligible for selection; the default judge selects the smallest passing patch;
4. If all initial attempts fail, evaluator feedback is passed back to all workers for an automated repair round;
5. When `--apply` is specified, the winning patch is applied directly to the main workspace, accompanied by an auditable provenance report.

### Programmatic Library Usage

```ts
import { Repository } from '@guanzhengpm/agent-merge';

const repo = Repository.inMemory(); // Or persist to disk: await Repository.init('./session-db')

// Record initial turn
await repo.append(
  [{ kind: 'message', at: Date.now(), actor: 'user', payload: { text: 'Fix failing unit tests' } }],
  { label: 'turn 1' },
);

// Fork two exploratory branches
const forkPoint = await repo.head();

await repo.fork('plan-a');
await repo.append([{ kind: 'annotation', at: Date.now(), actor: 'assistant', payload: { text: 'Approach A: Refactor caching layer' } }]);

await repo.checkout('main');
await repo.fork('plan-b', forkPoint!);
await repo.append([{ kind: 'annotation', at: Date.now(), actor: 'assistant', payload: { text: 'Approach B: Fix edge conditions' } }]);

// N-way merge: Combine annotations from both branches into main
await repo.checkout('main');
await repo.mergeMany(['plan-a', 'plan-b'], { strategy: 'conclusions' });

// Materialize reconstructed context for model input
const context = await repo.materialize();
```

### Merge Strategies

| Strategy | Behavior | When to Use |
| :--- | :--- | :--- |
| `conclusions` | Merges only `annotation` events from each branch | Default for multi-agent: retains high-level findings while leaving verbose histories on branches. |
| `interleave` | Weaves all events chronologically | Short histories where every operational step matters. |
| `pickTailStrategy(i)` | Retains the $i$-th branch in full | When an external test suite or judge has already chosen a single winner. |
| `championStrategy(i)` | Winner in full + annotations from rejected branches | One clear winner, but insights from failed explorations are worth preserving. |

### Session Bisecting (`bisect`)

Pinpoint the exact step that introduced an error without manually reviewing hundreds of log entries:

```ts
const result = await repo.bisect(goodStepId, badStepId, async (probe) => {
  const context = await probe.context();
  return isStepHealthy(context); // Custom probe: run test, inspect keywords, or query a model
});

console.log(`Fault introduced at step: ${result.firstBadId}`);
```

### Integrations

* **Agent Skill** (`integrations/skill`): Standardized adapter compliant with the [Agent Skills](https://agentskills.io) specification.
* **DeepSeek Harness Plugin** (`integrations/dsh-plugin`): Subscribes to DSH session event streams, branching histories automatically and exposing `timeline_*` tools.

### License

[MIT](LICENSE)
