/**
 * Multi-agent exploration demo: three agents attack one task on parallel
 * branches; a judge scores their findings, keeps the winner's full timeline,
 * and salvages the losers' conclusions — all as one N-way merge step.
 *
 * Run with: node examples/multi-agent-exploration.ts
 * (Node ≥ 23.6 runs the TypeScript directly.)
 */
import { Repository, championStrategy } from '../src/index.ts';
import type { TrajectoryEvent } from '../src/index.ts';

const repo = Repository.inMemory();

const note = (actor: string, at: number, text: string, score = 0): TrajectoryEvent => ({
  kind: 'annotation',
  at,
  actor,
  payload: { text, score },
});

// ── the shared starting point ───────────────────────────────────────────────
await repo.append(
  [{ kind: 'message', at: 0, actor: 'user', payload: { text: 'Fix the flaky login test' } }],
  { label: 'task' },
);

// ── fan-out: one branch per agent, written concurrently via targeted appends ─
for (const agent of ['agent-1', 'agent-2', 'agent-3']) {
  await repo.branch(`explore/${agent}`, 'main');
}
await Promise.all([
  (async () => {
    await repo.append(
      [
        { kind: 'tool_call', at: 10, actor: 'bash', payload: { cmd: 'pytest -k login --count 50' } },
        note('agent-1', 20, 'Retries mask a race; increasing timeout hides it. Dead end.', 2),
      ],
      { label: 'agent-1' },
      { branch: 'explore/agent-1' },
    );
  })(),
  (async () => {
    await repo.append(
      [
        { kind: 'tool_call', at: 11, actor: 'bash', payload: { cmd: 'git log -S session_token' } },
        note('agent-2', 21, 'Token refresh races the assertion — fixing the await removes the flake.', 9),
      ],
      { label: 'agent-2' },
      { branch: 'explore/agent-2' },
    );
  })(),
  (async () => {
    await repo.append(
      [
        { kind: 'tool_call', at: 12, actor: 'bash', payload: { cmd: 'rg sleep tests/' } },
        note('agent-3', 22, 'Unrelated, but tests share a fixture that leaks state — worth a ticket.', 5),
      ],
      { label: 'agent-3' },
      { branch: 'explore/agent-3' },
    );
  })(),
]);

// ── the judge: score each branch's findings, then fan in ────────────────────
const branches = ['explore/agent-1', 'explore/agent-2', 'explore/agent-3'];
let bestIndex = 0;
let bestScore = -Infinity;
for (const [i, branch] of branches.entries()) {
  const context = await repo.materialize(branch);
  const score = Math.max(
    ...context.map((m) => ((m.event.payload as { score?: number }).score ?? -Infinity)),
  );
  console.log(`${branch}: score ${score}`);
  if (score > bestScore) {
    bestScore = score;
    bestIndex = i + 1; // tails[0] is the receiving branch (main)
  }
}

await repo.checkout('main');
const result = await repo.mergeMany(branches, {
  strategy: championStrategy(bestIndex), // winner in full + others' conclusions
  meta: { label: `judge: ${branches[bestIndex - 1]} wins` },
});
console.log(`\nmerged as ${result.id.slice(0, 12)} (${result.kind})\n`);

// ── the merged context main would hand to the model ─────────────────────────
for (const m of await repo.materialize()) {
  const text = (m.event.payload as { text?: string; cmd?: string }).text ?? JSON.stringify(m.event.payload);
  console.log(`[${m.event.kind}] ${m.event.actor}: ${text}`);
}
