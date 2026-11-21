/** Renderer-side Quoll tool approval idle timeout (5 minutes). */
export const QUOLL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Hard ceiling from approval creation. Review activity re-arms the idle timer
 * but never past this bound (3× idle for the default 5m → 15m).
 */
export const QUOLL_APPROVAL_HARD_DEADLINE_MS = 15 * 60 * 1000;

/** Absolute upper bound for any Quoll approval hard deadline (30 minutes). */
export const QUOLL_APPROVAL_HARD_DEADLINE_MAX_MS = 30 * 60 * 1000;

/**
 * MCP / external SDK approval timeout aligned with Codex MCP limits (~110s).
 * Kept separate from Quoll because external agents block on main-process IPC.
 */
export const MCP_APPROVAL_TIMEOUT_MS = 110 * 1000;

/**
 * Resolve idle vs hard deadline for a Quoll approval request.
 * hardDeadlineMs is always >= idleMs and capped by the 30m global max when
 * the 3× multiplier would exceed it (unless idle itself is larger).
 */
export function resolveQuollApprovalDeadlines(timeoutMs: number = QUOLL_APPROVAL_TIMEOUT_MS): {
  idleMs: number;
  hardDeadlineMs: number;
} {
  const idleMs = Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : QUOLL_APPROVAL_TIMEOUT_MS);
  const scaled = idleMs * 3;
  const hardDeadlineMs = Math.max(
    idleMs,
    Math.min(scaled, QUOLL_APPROVAL_HARD_DEADLINE_MAX_MS),
  );
  return { idleMs, hardDeadlineMs };
}
