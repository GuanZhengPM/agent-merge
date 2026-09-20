import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { EventKind, TrajectoryEvent } from '@guanzhengpm/agent-merge';
import { recordValue, redactJson } from '@guanzhengpm/agent-merge';
import type { RecordingMode, Redactor } from '@guanzhengpm/agent-merge';
import { TimelineStore } from './store.ts';

/**
 * Mirrors every committed dsh session event into the agent-merge store —
 * a persistence plugin in dsh's intended sense: subscribe to the post-commit
 * append feed, buffer, and write out on the `session/flush` durability
 * checkpoint. Each dsh session becomes one branch (`dsh/<session-id>`), each
 * flush batch one step, so the whole session history is forkable, mergeable,
 * and bisectable after the fact.
 */
export class SessionRecorder {
  readonly #store: TimelineStore;
  readonly #buffers = new Map<string, TrajectoryEvent[]>();

  readonly #mode: RecordingMode;
  readonly #redactor: Redactor;

  constructor(
    ctx: Context,
    store: TimelineStore,
    options: { mode?: RecordingMode; redactor?: Redactor } = {},
  ) {
    this.#store = store;
    this.#mode = options.mode ?? 'redacted';
    this.#redactor = options.redactor ?? redactJson;
    // Listener registrations are effects on the plugin's fiber; cordis
    // disposes them when the plugin unloads.
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.#record(session, event);
    });
    ctx.on('session/flush', (session: Session) => this.flush(session));
    ctx.on('session/disposed', (session: Session) => {
      void this.flush(session).catch(() => undefined);
    });
  }

  #record(session: Session, event: SessionEvent): void {
    const id = String(session.id);
    let buffer = this.#buffers.get(id);
    if (!buffer) {
      buffer = [];
      this.#buffers.set(id, buffer);
    }
    buffer.push(toTrajectoryEvent(event, { mode: this.#mode, redactor: this.#redactor }));
  }

  /** Write this session's buffered events out as one step. */
  async flush(session: Session): Promise<void> {
    const id = String(session.id);
    const buffer = this.#buffers.get(id);
    if (!buffer || buffer.length === 0) return;
    this.#buffers.set(id, []);
    const first = (buffer[0]?.payload as { seq?: number })?.seq;
    const last = (buffer[buffer.length - 1]?.payload as { seq?: number })?.seq;
    await this.#store.recordStep(TimelineStore.branchFor(id), buffer, {
      label: `session ${id} seq ${first ?? '?'}..${last ?? '?'}`,
      author: 'dsh-plugin-agent-merge',
    });
  }
}

/**
 * One dsh session event, re-expressed as an agent-merge trajectory event.
 * `at` is the event's recorded wall-clock time (already part of the dsh log,
 * so the conversion stays deterministic). Payload persistence follows the
 * selected recording mode; full lossless replay is explicit opt-in.
 */
export function toTrajectoryEvent(
  event: SessionEvent,
  options: { mode?: RecordingMode; redactor?: Redactor } = {},
): TrajectoryEvent {
  const mode = options.mode ?? 'redacted';
  const redactor = options.redactor ?? redactJson;
  return {
    kind: kindOf(event.type),
    at: event.time,
    actor: actorOf(event.type),
    payload: recordValue(sanitize({ type: event.type, seq: event.seq, data: event.data }), mode, redactor),
  };
}

function kindOf(type: string): EventKind {
  if (type.endsWith('/message')) return 'message';
  if (type.startsWith('tool/')) return type.includes('result') ? 'tool_result' : 'tool_call';
  return 'annotation';
}

function actorOf(type: string): string {
  const head = type.split('/')[0];
  return head !== undefined && head.length > 0 ? head : type;
}

/**
 * dsh guarantees session payloads are plain JSON; this is a defensive
 * normalization so a misbehaving upstream event degrades instead of
 * poisoning the append: the JSON round-trip drops `undefined` members and
 * unwraps class instances, and `wellFormed` repairs lone surrogates (which
 * agent-merge rejects rather than letting UTF-8 encoding mutate silently).
 */
function sanitize(value: unknown): unknown {
  return wellFormed(JSON.parse(JSON.stringify(value) ?? 'null'));
}

function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') return value.isWellFormed() ? value : value.toWellFormed();
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[wellFormed(key) as string] = wellFormed(item);
    return out;
  }
  return value;
}
