/**
 * Lightweight event bus between the database query editor and the AI surfaces
 * (framework-native AI side panel + SQL editor). The workbench and the panel
 * are sibling components with no shared state owner — a module-level pub/sub
 * avoids threading callbacks through TerminalLayerSupport.
 *
 * - `emitAiPrompt({ text, connectionId })` — editor → AI panel: prefill the
 *   composer (AI 优化/修复). The database-scoped panel consumes it when its
 *   scopeTargetId matches the connectionId.
 * - `requestAiPanelOpen({ sessionId })` — editor → TerminalLayer: open the
 *   native AI side panel for the tab.
 * - `emitSqlEditorAction(...)` — AI panel → editor: insert/replace SQL.
 * Each payload carries a monotonic `seq` so consumers apply an action exactly
 * once regardless of effect re-runs.
 */

export type SqlEditorAction = {
  kind: 'insert' | 'replace';
  sql: string;
  connectionId?: string;
  seq: number;
};

export type AiPromptPayload = {
  text: string;
  connectionId?: string;
  seq: number;
};

export type AiPanelOpenRequest = {
  sessionId: string;
  seq: number;
};

type SqlEditorActionListener = (action: SqlEditorAction) => void;
type AiPromptListener = (payload: AiPromptPayload) => void;
type AiPanelOpenListener = (request: AiPanelOpenRequest) => void;

let sqlEditorSeq = 0;
let aiPromptSeq = 0;
let aiPanelOpenSeq = 0;
const sqlEditorListeners = new Set<SqlEditorActionListener>();
const aiPromptListeners = new Set<AiPromptListener>();
const aiPanelOpenListeners = new Set<AiPanelOpenListener>();

export function emitSqlEditorAction(action: Omit<SqlEditorAction, 'seq'>): SqlEditorAction {
  sqlEditorSeq += 1;
  const payload: SqlEditorAction = { ...action, seq: sqlEditorSeq };
  for (const listener of sqlEditorListeners) {
    try {
      listener(payload);
    } catch {
      // A broken listener must not stop the others.
    }
  }
  return payload;
}

export function subscribeSqlEditorAction(listener: SqlEditorActionListener): () => void {
  sqlEditorListeners.add(listener);
  return () => sqlEditorListeners.delete(listener);
}

export function emitAiPrompt(payload: Omit<AiPromptPayload, 'seq'>): AiPromptPayload {
  aiPromptSeq += 1;
  const message: AiPromptPayload = { ...payload, seq: aiPromptSeq };
  for (const listener of aiPromptListeners) {
    try {
      listener(message);
    } catch {
      // A broken listener must not stop the others.
    }
  }
  return message;
}

export function subscribeAiPrompt(listener: AiPromptListener): () => void {
  aiPromptListeners.add(listener);
  return () => aiPromptListeners.delete(listener);
}

export function requestAiPanelOpen(payload: { sessionId: string }): AiPanelOpenRequest {
  aiPanelOpenSeq += 1;
  const request: AiPanelOpenRequest = { ...payload, seq: aiPanelOpenSeq };
  for (const listener of aiPanelOpenListeners) {
    try {
      listener(request);
    } catch {
      // A broken listener must not stop the others.
    }
  }
  return request;
}

export function subscribeAiPanelOpenRequests(listener: AiPanelOpenListener): () => void {
  aiPanelOpenListeners.add(listener);
  return () => aiPanelOpenListeners.delete(listener);
}

export function _resetSqlEditorBridgeForTests(): void {
  sqlEditorSeq = 0;
  aiPromptSeq = 0;
  aiPanelOpenSeq = 0;
  sqlEditorListeners.clear();
  aiPromptListeners.clear();
  aiPanelOpenListeners.clear();
}
