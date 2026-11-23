/**
 * BLOB cell viewer helpers: grid cells carry binary values as either the pg
 * driver's JSON-serialized Buffer shape (`{"type":"Buffer","data":[..]}`) or
 * the `\xDEAD…` hex literal (restore dumps). Parse both back to bytes, sniff
 * image formats for the preview tab, and render a hex dump for the rest.
 */

/**
 * Binary check for the grid render path: same shapes parseCellValueToBytes
 * accepts, but never builds the byte arrays — the cell map only needs the
 * boolean, and allocating a Uint8Array per binary cell per render (hex parse:
 * parseInt per byte) is waste. Keep the shape rules in sync with the parser.
 */
export const isBinaryCellValue = (value: unknown): boolean => {
  if (value == null) return false;
  // Buffer JSON shape (pg driver → serializeCellValue).
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as { type?: string; data?: unknown };
    return obj.type === 'Buffer' && Array.isArray(obj.data);
  }
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.startsWith('{') && text.includes('"type":"Buffer"')) {
    try {
      const obj = JSON.parse(text) as { type?: string; data?: unknown[] };
      return obj.type === 'Buffer' && Array.isArray(obj.data);
    } catch { return false; }
  }
  // \xDEADBEEF / x'DEADBEEF' / 0xDEADBEEF hex literal forms, or a plain even-length hex run (≥32 chars).
  if (/^(?:\\x|x'|0x)([0-9a-fA-F]+)'?$/.test(text)) return true;
  return text.length >= 32 && /^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0;
};

/** Parse a grid cell value into bytes; null when the value is not binary. */
export const parseCellValueToBytes = (value: unknown): Uint8Array | null => {
  if (value == null) return null;
  // Buffer JSON shape (pg driver → serializeCellValue).
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as { type?: string; data?: unknown };
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return new Uint8Array(obj.data.map((n) => Number(n) & 0xff));
    }
    return null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // The grid cell is serializeCellValue's output: Buffers arrive as their
  // JSON text — parse it back before anything else.
  if (text.startsWith('{') && text.includes('"type":"Buffer"')) {
    try {
      const obj = JSON.parse(text) as { type?: string; data?: unknown[] };
      if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
        return new Uint8Array(obj.data.map((n) => Number(n) & 0xff));
      }
    } catch { /* fall through to hex/text handling */ }
  }
  // \xDEADBEEF / x'DEADBEEF' / 0xDEADBEEF hex literal forms.
  const hexMatch = /^(?:\\x|x'|0x)([0-9a-fA-F]+)'?$/.exec(text);
  if (hexMatch) return hexToBytes(hexMatch[1]);
  // Plain long hex string without spaces (≥32 chars) — treat as hex too.
  if (text.length >= 32 && /^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
    return hexToBytes(text);
  }
  return null;
};

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

/** Image sniffing by magic bytes (JPEG / PNG / GIF / WEBP / BMP). */
export const detectImageMime = (bytes: Uint8Array): string | null => {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
};

/** Classic hex dump: 16 bytes per line, offset + hex + printable ASCII. */
export const toHexDump = (bytes: Uint8Array, maxBytes = 4096): string => {
  const lines: string[] = [];
  const view = bytes.subarray(0, maxBytes);
  for (let offset = 0; offset < view.length; offset += 16) {
    const chunk = view.subarray(offset, offset + 16);
    const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > maxBytes) lines.push(`… ${bytes.length - maxBytes} more bytes`);
  return lines.join('\n');
};

// --- Content format detection & charset-aware text decode (DBeaver-aligned) ---

export type BlobContentKind = 'image' | 'pdf' | 'zip' | 'gzip' | 'text' | 'binary';

export interface BlobContentFormat {
  kind: BlobContentKind;
  mime: string | null;
}

/** Charset choices for the viewer's text preview; 'auto' runs the sniffing chain. */
export const BLOB_TEXT_ENCODINGS = [
  { id: 'auto' },
  { id: 'utf-8' },
  { id: 'gb18030' },
  { id: 'big5' },
  { id: 'shift_jis' },
  { id: 'windows-1252' },
  { id: 'utf-16le' },
  { id: 'utf-16be' },
] as const;

export type BlobEncodingId = (typeof BLOB_TEXT_ENCODINGS)[number]['id'];

/** Preview bytes decoded for the text tab; anything beyond is reported as truncated. */
export const TEXT_PREVIEW_CAP = 32_768;

/** Decoded content must clear this printable ratio to count as text (vs binary garbage). */
const TEXT_RATIO_THRESHOLD = 0.85;

/**
 * Fraction of printable characters: whitespace/newlines, ASCII graphics, and
 * anything ≥ U+00A0 (CJK etc.). C0/C1 control bytes and U+FFFD count against it.
 */
export const printableRatio = (text: string): number => {
  if (!text.length) return 0;
  let printable = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code < 0x7f) || code >= 0xa0) {
      printable += 1;
    }
  }
  return printable / [...text].length;
};

const strictDecode = (bytes: Uint8Array, encoding: string): string | null => {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** Charset sniffing: BOMs first, then strict-decode attempts gated by the text ratio. */
const detectTextEncoding = (bytes: Uint8Array): string | null => {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const utf8 = strictDecode(bytes, 'utf-8');
  if (utf8 !== null && printableRatio(utf8) >= TEXT_RATIO_THRESHOLD) return 'utf-8';
  // GB18030 covers GBK/GB2312; it accepts most byte pairs, so the ratio gate is
  // what filters garbage — an odd trailing byte breaks pairing and fails strict.
  const gb = strictDecode(bytes, 'gb18030');
  if (gb !== null && printableRatio(gb) >= TEXT_RATIO_THRESHOLD) return 'gb18030';
  const cp1252 = strictDecode(bytes, 'windows-1252');
  if (cp1252 !== null && printableRatio(cp1252) >= TEXT_RATIO_THRESHOLD) return 'windows-1252';
  return null;
};

/** Sniff the cell bytes into a viewer format; unknown byte soup stays 'binary'. */
export const detectContentFormat = (bytes: Uint8Array): BlobContentFormat => {
  const imageMime = detectImageMime(bytes);
  if (imageMime) return { kind: 'image', mime: imageMime };
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return { kind: 'pdf', mime: 'application/pdf' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { kind: 'zip', mime: 'application/zip' };
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return { kind: 'gzip', mime: 'application/gzip' };
  }
  if (detectTextEncoding(bytes)) return { kind: 'text', mime: null };
  return { kind: 'binary', mime: null };
};

/** Images and readable text preview inline; documents/archives land on the hex tab. */
export const defaultTabForFormat = (format: BlobContentFormat): 'preview' | 'hex' =>
  format.kind === 'image' || format.kind === 'text' ? 'preview' : 'hex';

/**
 * Decode a text preview capped at TEXT_PREVIEW_CAP bytes. The cap backs off to a
 * full-character boundary so the cut never spawns a replacement char. 'auto'
 * walks BOM → utf-8 → gb18030 → windows-1252; explicit ids decode directly
 * (lenient, so stray corrupt bytes render as U+FFFD instead of throwing).
 */
export const decodeTextPreview = (
  bytes: Uint8Array,
  encodingId: BlobEncodingId,
): { text: string; encoding: string; truncated: number } => {
  const encoding = encodingId === 'auto' ? detectTextEncoding(bytes) ?? 'windows-1252' : encodingId;
  let consumed = Math.min(bytes.length, TEXT_PREVIEW_CAP);
  // Strict-decode the prefix, backing off up to 4 bytes so a split trailing
  // multibyte char is dropped instead of becoming U+FFFD at the cut.
  let text: string | null = null;
  for (let backoff = 0; backoff < 4 && consumed > 0; backoff += 1) {
    text = strictDecode(bytes.subarray(0, consumed), encoding);
    if (text !== null) break;
    consumed -= 1;
  }
  if (text === null) {
    // Corrupt mid-prefix bytes (not a boundary issue): decode leniently.
    text = new TextDecoder(encoding).decode(bytes.subarray(0, consumed));
  }
  return { text, encoding, truncated: bytes.length - consumed };
};
