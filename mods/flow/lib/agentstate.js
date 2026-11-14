export const START_GRACE_MS = 15_000;
export const SCREEN_RECHECK_MS = 10_000;
const TRUST_DIALOG = /trust this folder/i;
export function agentLook({ status, live, sinceMs, screen, error }) {
    if (status === "blocked")
        return { text: "needs you", blocked: true };
    if (status === "working")
        return { text: "working", spin: true };
    if (status !== null)
        return { text: error ? `bad result: ${error}` : "stopped without a result", stuck: true };
    if (!live)
        return { text: error ? `closed, bad result: ${error}` : "closed", stuck: true };
    if (sinceMs < START_GRACE_MS)
        return { text: "starting", spin: true };
    const text = screen !== null && TRUST_DIALOG.test(screen) ? "Claude asks to trust this folder: open it" : "waiting in its tab: open it";
    return { text, blocked: true, notStarted: true };
}
