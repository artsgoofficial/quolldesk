/**
 * Shared HTML/XML entity decoding (note clipboard paste, vault import XML
 * parsers). Numeric references use a code-point guard so malformed input
 * (e.g. &#1114112;) is left as-is instead of throwing on fromCodePoint.
 * Named entities decode case-insensitively as a harmless superset of the XML
 * set, and &amp; runs last so pre-decoded text is never re-expanded.
 */

const isValidUnicodeCodePoint = (code: unknown): code is number => (
  typeof code === "number"
  && Number.isInteger(code)
  && code >= 0
  && code <= 0x10FFFF
);

const codePointFromEntity = (code: number, fallback: string): string => (
  isValidUnicodeCodePoint(code) ? String.fromCodePoint(code) : fallback
);

/** Decode common HTML/XML entities (once) before re-escaping on serialize. */
export const decodeHtmlEntities = (value: string): string => (
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) => codePointFromEntity(Number(n), _))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => (
      codePointFromEntity(Number.parseInt(hex, 16), _)
    ))
    // &amp; last so we don't re-expand decoded entities
    .replace(/&amp;/gi, "&")
);
