/** How long a live agent terminal may go without reporting a status before it counts as not started. */
export const START_GRACE_MS = 15_000;
/** How often the panel rereads a not-started terminal's screen. */
export const SCREEN_RECHECK_MS = 10_000;

export interface AgentLook {
  text: string;
  spin?: boolean;
  blocked?: boolean;
  stuck?: boolean;
  /** The terminal is live but its agent never reported a status. */
  notStarted?: boolean;
}

export interface AgentInput {
  /** The status the terminal's agent reported, or null when it is not in Herdr's agent list. */
  status: string | null;
  /** The terminal exists and is running. */
  live: boolean;
  /** Milliseconds since the step started or the terminal was attached. */
  sinceMs: number;
  /** The terminal's recent screen text, or null when not read. */
  screen: string | null;
  /** Why the agent's result file was rejected, if it was. */
  error: string | null;
}

const TRUST_DIALOG = /trust this folder/i;

export function agentLook({ status, live, sinceMs, screen, error }: AgentInput): AgentLook {
  if (status === "blocked") return { text: "needs you", blocked: true };
  if (status === "working") return { text: "working", spin: true };
  if (status !== null) return { text: error ? `bad result: ${error}` : "stopped without a result", stuck: true };
  if (!live) return { text: error ? `closed, bad result: ${error}` : "closed", stuck: true };
  if (sinceMs < START_GRACE_MS) return { text: "starting", spin: true };
  const text = screen !== null && TRUST_DIALOG.test(screen) ? "Claude asks to trust this folder: open it" : "waiting in its tab: open it";
  return { text, blocked: true, notStarted: true };
}
