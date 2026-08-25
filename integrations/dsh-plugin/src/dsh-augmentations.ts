/**
 * Keep the small slice of dsh's Cordis augmentation used by this plugin
 * attached to the same package identity as our direct Context import.
 *
 * pnpm may assign the optional peer copies in dsh-session and dsh-tools a
 * different virtual package identity during standalone development. Their
 * upstream declarations remain authoritative; these matching declarations
 * make typechecking independent of that installation detail.
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRuntime;
    subagents: SubagentRuntime;
  }

  interface Events {
    'session/disposed'(session: Session): void;
    'session/event'(session: Session, event: SessionEvent): void;
    'session/flush'(session: Session): Promise<void> | void;
  }
}

export {};
