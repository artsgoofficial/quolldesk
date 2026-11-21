/**
 * Extract fenced ```sql code blocks from assistant markdown content. Used by
 * the database AI panel's message actions (insert/replace/copy). Only fenced
 * blocks with a SQL-ish language tag count so prose code samples are skipped.
 */

const SQL_LANGUAGES = new Set(['sql', 'mysql', 'postgresql', 'postgres', 'pgsql']);

export function extractSqlBlocks(markdown: string): string[] {
  const text = String(markdown || '');
  const blocks: string[] = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const lang = (match[1] || '').trim().toLowerCase();
    if (!SQL_LANGUAGES.has(lang)) continue;
    const body = match[2].trim();
    if (body) blocks.push(body);
  }
  return blocks;
}
