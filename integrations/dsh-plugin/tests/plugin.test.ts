import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionRecorder, toTrajectoryEvent } from '../src/recorder.ts';
import { TimelineStore } from '../src/store.ts';

type Listener = (...args: never[]) => unknown;

/** Minimal stand-in for the cordis event bus, enough to drive the recorder. */
function fakeBus(): { ctx: Context; emit: (name: string, ...args: unknown[]) => Promise<void> } {
  const listeners = new Map<string, Listener[]>();
  const ctx = {
    on(name: string, listener: Listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => undefined;
    },
  } as unknown as Context;
  return {
    ctx,
    emit: async (name, ...args) => {
      for (const listener of listeners.get(name) ?? []) {
        await (listener as (...a: unknown[]) => unknown)(...args);
      }
    },
  };
}

function fakeEvent(seq: number, type: string, data: unknown): SessionEvent {
  return { type, seq, time: 1000 + seq, data } as SessionEvent;
}

const fakeSession = (id: string): Session => ({ id }) as unknown as Session;

async function withStore(run: (store: TimelineStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-'));
  try {
    await run(new TimelineStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('toTrajectoryEvent maps dsh event types onto trajectory kinds', () => {
  assert.equal(toTrajectoryEvent(fakeEvent(0, 'user/message', {})).kind, 'message');
  assert.equal(toTrajectoryEvent(fakeEvent(1, 'assistant/message', {})).kind, 'message');
  assert.equal(toTrajectoryEvent(fakeEvent(2, 'tool/result', {})).kind, 'tool_result');
  assert.equal(toTrajectoryEvent(fakeEvent(3, 'tool/call', {})).kind, 'tool_call');
  assert.equal(toTrajectoryEvent(fakeEvent(4, 'turn/start', { turn: 1 })).kind, 'annotation');

  const mapped = toTrajectoryEvent(fakeEvent(7, 'user/message', { content: 'hi' }));
  assert.equal(mapped.at, 1007);
  assert.equal(mapped.actor, 'user');
  assert.deepEqual(mapped.payload, { type: 'user/message', seq: 7, data: { content: 'hi' } });
});

test('lone surrogates in upstream payloads are repaired, not fatal', async () => {
  await withStore(async (store) => {
    const { ctx, emit } = fakeBus();
    new SessionRecorder(ctx, store);
    const session = fakeSession('surrogate');
    await emit('session/event', session, fakeEvent(0, 'tool/result', { output: 'broken \ud800 output' }));
    await emit('session/flush', session); // must not reject
    await store.run(async (repo) => {
      const context = await repo.materialize('dsh/surrogate');
      const output = (context[0]?.event.payload as { data: { output: string } }).data.output;
      assert.ok(output.startsWith('broken '), 'payload recorded');
      assert.ok(output.isWellFormed(), 'string repaired to well-formed');
    });
  });
});

test('branchFor produces valid, distinct branch names', () => {
  assert.equal(TimelineStore.branchFor('abc-123'), 'dsh/abc-123');
  assert.equal(TimelineStore.branchFor('weird id!/x'), 'dsh/weird-id--x');
  assert.equal(TimelineStore.branchFor('-leading'), 'dsh/s-leading');
});

test('recorder buffers events and flushes them as one step per session', async () => {
  await withStore(async (store) => {
    const { ctx, emit } = fakeBus();
    new SessionRecorder(ctx, store);
    const sessionA = fakeSession('sess-a');
    const sessionB = fakeSession('sess-b');

    await emit('session/event', sessionA, fakeEvent(0, 'user/message', { content: 'hello' }));
    await emit('session/event', sessionB, fakeEvent(0, 'user/message', { content: 'other session' }));
    await emit('session/event', sessionA, fakeEvent(1, 'assistant/message', { content: 'hi!' }));
    await emit('session/flush', sessionA);
    await emit('session/flush', sessionB);
    // an empty second flush must not create an empty step
    await emit('session/flush', sessionA);

    await store.run(async (repo) => {
      const logA = await repo.log({ from: 'dsh/sess-a' });
      assert.equal(logA.length, 1);
      assert.equal(logA[0]?.step.events.length, 2);
      assert.match(logA[0]?.step.meta.label ?? '', /sess-a seq 0\.\.1/);

      const contextB = await repo.materialize('dsh/sess-b');
      assert.equal(contextB.length, 1);
      assert.deepEqual((contextB[0]?.event.payload as { data: unknown }).data, { content: 'other session' });
    });
  });
});

test('interleaved sessions stay isolated thanks to the serialized store', async () => {
  await withStore(async (store) => {
    const { ctx, emit } = fakeBus();
    new SessionRecorder(ctx, store);
    const a = fakeSession('a');
    const b = fakeSession('b');

    for (let i = 0; i < 5; i++) {
      await emit('session/event', a, fakeEvent(i, 'user/message', { from: 'a', i }));
      await emit('session/event', b, fakeEvent(i, 'user/message', { from: 'b', i }));
      // flush both without awaiting in between: appends race unless serialized
      await Promise.all([emit('session/flush', a), emit('session/flush', b)]);
    }

    await store.run(async (repo) => {
      for (const [branch, who] of [
        ['dsh/a', 'a'],
        ['dsh/b', 'b'],
      ] as const) {
        const context = await repo.materialize(branch);
        assert.equal(context.length, 5);
        assert.ok(
          context.every((m) => (m.event.payload as { data: { from: string } }).data.from === who),
          `${branch} must only contain ${who}'s events`,
        );
      }
    });
  });
});

test('recorded sessions from unrelated roots fan in with an N-way conclusions merge', async () => {
  await withStore(async (store) => {
    const { ctx, emit } = fakeBus();
    new SessionRecorder(ctx, store);
    for (const who of ['alpha', 'beta']) {
      const session = fakeSession(who);
      await emit('session/event', session, fakeEvent(0, 'user/message', { text: `${who} raw work` }));
      await emit('session/event', session, fakeEvent(1, 'turn/end', { turn: 1, conclusion: `${who} finding` }));
      await emit('session/flush', session);
    }
    await store.run(async (repo) => {
      await repo.checkout('dsh/alpha');
      const result = await repo.mergeMany(['dsh/beta'], { strategy: 'conclusions' });
      assert.equal(result.kind, 'merge');
      const { step } = await repo.getStep(result.id);
      assert.equal(step.base, null, 'unrelated session roots merge over a null base');
      const merged = await repo.materialize(result.id);
      // conclusions keeps only annotation-kind events (turn/end maps to annotation)
      assert.ok(merged.every((m) => m.event.kind === 'annotation'));
      assert.equal(merged.length, 2);
    });
  });
});

test('recorded timelines can be forked, merged, and bisected through the store', async () => {
  await withStore(async (store) => {
    const { ctx, emit } = fakeBus();
    new SessionRecorder(ctx, store);
    const session = fakeSession('main-sess');

    const stepIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const marker = i === 4 ? 'POISON' : `ok-${i}`;
      await emit('session/event', session, fakeEvent(i, 'tool/result', { marker }));
      await emit('session/flush', session);
      await store.run(async (repo) => {
        stepIds.push((await repo.getStep('dsh/main-sess')).id);
      });
    }

    await store.run(async (repo) => {
      // fork before the poison and verify the fork is clean
      await repo.branch('rescue', stepIds[3] as string);
      const forkContext = await repo.materialize('rescue');
      assert.ok(!JSON.stringify(forkContext).includes('POISON'));

      // bisect the poisoned line
      const result = await repo.bisect(stepIds[0] as string, stepIds[5] as string, async (probe) => {
        const context = await probe.context();
        return !JSON.stringify(context.map((m) => m.event)).includes('POISON');
      });
      assert.equal(result.firstBadId, stepIds[4]);
    });
  });
});
