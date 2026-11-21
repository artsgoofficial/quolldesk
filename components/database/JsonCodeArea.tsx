import React from 'react';

/**
 * JSON code area for the value viewer: a colored, pretty-printed view that
 * stays editable. A transparent textarea sits on top of a highlighted <pre>
 * (react-simple-code-editor technique), so text and colors stay in sync while
 * the user types. Tolerant of invalid JSON — tokens just render uncolored.
 */

interface JsonToken { text: string; kind: 'key' | 'string' | 'number' | 'keyword' | 'other' }

// "…":  → key; "…" → string value; keywords/numbers; everything else opaque.
const JSON_TOKEN_RE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\s+|./gs;

export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  JSON_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_TOKEN_RE.exec(text))) {
    const [text0, str, colon] = match;
    if (str !== undefined) {
      tokens.push({ text: str, kind: colon !== undefined ? 'key' : 'string' });
      // The regex folds the following ":" into the string match; emit it as
      // its own token, otherwise the rendered view drops every object colon.
      if (colon !== undefined) tokens.push({ text: colon, kind: 'other' });
    } else if (/^[{}[\],:]/.test(text0)) tokens.push({ text: text0, kind: 'other' });
    else if (text0 === 'true' || text0 === 'false' || text0 === 'null') tokens.push({ text: text0, kind: 'keyword' });
    else if (/^-?\d/.test(text0)) tokens.push({ text: text0, kind: 'number' });
    else tokens.push({ text: text0, kind: 'other' });
    if (match.index === JSON_TOKEN_RE.lastIndex) JSON_TOKEN_RE.lastIndex += 1; // zero-width safety
  }
  return tokens;
}

const TOKEN_CLASS: Record<JsonToken['kind'], string> = {
  key: 'text-sky-600 dark:text-sky-300',
  string: 'text-emerald-600 dark:text-emerald-300',
  number: 'text-amber-600 dark:text-amber-300',
  keyword: 'text-violet-600 dark:text-violet-400',
  other: 'text-muted-foreground',
};

/** Colored JSON spans; whitespace/newlines preserved (parent sets white-space). */
export function highlightJson(text: string): React.ReactNode[] {
  return tokenizeJson(text).map((tok, i) => (
    <span key={i} className={TOKEN_CLASS[tok.kind]}>{tok.text}</span>
  ));
}

interface JsonCodeAreaProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Editable JSON area. The <pre> drives the container height (textarea is
 * absolutely positioned over it, overflow-hidden) so long values grow the
 * box instead of scrolling inside mismatched scroll containers.
 */
const JsonCodeArea: React.FC<JsonCodeAreaProps> = ({ value, onChange }) => (
  <div className="relative min-h-[160px] w-full rounded-md border border-input bg-foreground/5 font-mono text-xs">
    <pre aria-hidden className="m-0 whitespace-pre-wrap break-all px-3 py-2">
      {highlightJson(value)}
      {'\n'}
    </pre>
    <textarea
      value={value}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      className="absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-all border-0 bg-transparent px-3 py-2 text-transparent caret-foreground outline-none focus-visible:outline-none"
    />
  </div>
);

export default JsonCodeArea;
