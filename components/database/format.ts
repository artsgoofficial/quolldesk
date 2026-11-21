/** Shared value-formatting helpers for the database workbench. */

export interface JsonFormatResult {
  isJson: boolean;
  formatted: string;
}

/** Detect JSON object/array text and pretty-print it; pass everything else through. */
export function formatMaybeJson(text: string | null | undefined): JsonFormatResult {
  if (text == null || typeof text !== 'string') return { isJson: false, formatted: text ?? '' };
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { isJson: false, formatted: text };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return { isJson: true, formatted: JSON.stringify(parsed, null, 2) };
    }
    return { isJson: false, formatted: text };
  } catch {
    return { isJson: false, formatted: text };
  }
}

/** Render an arbitrary redis reply for text panels (console output, values). */
export function formatReplyValue(reply: unknown): string {
  if (reply === null || reply === undefined) return '(nil)';
  if (typeof reply === 'string') return reply;
  if (typeof reply === 'number' || typeof reply === 'boolean') return String(reply);
  try {
    return JSON.stringify(reply, null, 2);
  } catch {
    return String(reply);
  }
}
