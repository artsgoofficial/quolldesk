import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  BLOB_TEXT_ENCODINGS,
  decodeTextPreview,
  defaultTabForFormat,
  detectContentFormat,
  detectImageMime,
  isBinaryCellValue,
  parseCellValueToBytes,
  printableRatio,
  toHexDump,
} from './blobViewer';

test('parses the JSON Buffer string from serializeCellValue (grid shape)', () => {
  const bytes = parseCellValueToBytes('{"type":"Buffer","data":[72,101,108,108,111]}');
  assert.ok(bytes);
  assert.equal(new TextDecoder().decode(bytes), 'Hello');
});

test('isBinaryCellValue agrees with parseCellValueToBytes on every shape (render gate)', () => {
  const cases: unknown[] = [
    '{"type":"Buffer","data":[72,101,108,108,111]}',
    '{"type":"Buffer","data":"not-an-array"}',
    { type: 'Buffer', data: [65] },
    { type: 'Other', data: [65] },
    '\\xDEADBEEF', "x'DEADBEEF'", '0xDEADBEEF',
    'a'.repeat(32),                       // plain hex run → binary
    'a'.repeat(31),                       // too short → text
    'abcdefghij klmnopqrstuvwxyz012345',  // space breaks the hex run → text
    'hello world', '', null, undefined, 42, [1, 2, 3],
    'not json {broken',
  ];
  for (const value of cases) {
    assert.equal(
      isBinaryCellValue(value),
      parseCellValueToBytes(value) != null,
      `mismatch for ${JSON.stringify(value)}`,
    );
  }
});

test('also accepts the raw Buffer object shape defensively', () => {
  const bytes = parseCellValueToBytes({ type: 'Buffer', data: [65] });
  assert.ok(bytes);
  assert.equal(bytes[0], 65);
});

test('parses hex literal forms: backslash-x, 0x, and x-quoted', () => {
  const bytes = parseCellValueToBytes('\\xDEADBEEF');
  assert.deepEqual([...bytes!], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual([...parseCellValueToBytes('0xCAFEBABE')!], [0xca, 0xfe, 0xba, 0xbe]);
  assert.deepEqual([...parseCellValueToBytes("x'CAFE'")!], [0xca, 0xfe]);
});

test('parses long bare hex strings (≥32 chars, even length)', () => {
  const long = 'ab'.repeat(16);
  const bytes = parseCellValueToBytes(long);
  assert.deepEqual([...bytes!], new Array(16).fill(0xab));
  // Short hex-ish text ("abc") is NOT binary — stays null.
  assert.equal(parseCellValueToBytes('abc'), null);
});

test('non-binary values yield null (text passes through the grid untouched)', () => {
  assert.equal(parseCellValueToBytes('plain text'), null);
  assert.equal(parseCellValueToBytes(12345), null);
  assert.equal(parseCellValueToBytes(null), null);
  assert.equal(parseCellValueToBytes(['array']), null);
});

test('detectImageMime sniffs by magic bytes', () => {
  assert.equal(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.equal(detectImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38])), 'image/gif');
  assert.equal(detectImageMime(new Uint8Array([0x42, 0x4d, 0x00, 0x00])), 'image/bmp');
  assert.equal(detectImageMime(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(detectImageMime(new Uint8Array([1])), null);
});

test('toHexDump renders offset + hex + ascii columns', () => {
  const bytes = new Uint8Array(17).map((_, i) => (i === 0 ? 0x48 : i));
  const dump = toHexDump(bytes);
  assert.match(dump, /^00000000  48 01 02/);
  assert.match(dump, /H\.{15}/); // printable 'H' then dots
  assert.match(dump, /00000010  10/); // second line carries byte 17
});

test('toHexDump truncates with a remaining-bytes note', () => {
  const bytes = new Uint8Array(5000).fill(0xab);
  const dump = toHexDump(bytes, 4096);
  assert.match(dump, /… 904 more bytes/);
});

test('SqlTableData wires the blob viewer: binary cells get a BLOB button + dialog', () => {
  const grid = readFileSync(new URL('./SqlTableData.tsx', import.meta.url), 'utf8');
  // The render path uses the non-allocating predicate (the full parser stays
  // in BlobViewerDialog, which needs the actual bytes).
  assert.match(grid, /isBinaryCellValue\(cell\.value\)/);
  assert.match(grid, /BlobViewerDialog/);
  assert.match(grid, /db\.blob\.open/);
});

test('BlobViewerDialog wires format-aware tabs, charset selector and copy-as-text', () => {
  const dialog = readFileSync(new URL('./BlobViewerDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /defaultTabForFormat/, 'initial tab follows the sniffed format');
  assert.match(dialog, /detectContentFormat/, 'format badge drives the default view');
  assert.match(dialog, /decodeTextPreview/, 'text preview goes through the charset-aware decoder');
  assert.match(dialog, /db\.blob\.encoding/, 'charset selector is rendered');
  assert.match(dialog, /db\.blob\.copyText/, 'copy-as-text action is rendered');
  assert.match(dialog, /STORAGE_KEY_DB_BLOB_ENCODING/, 'charset choice persists');
  // No raw TextDecoder in the component: all decoding goes through blobViewer helpers.
  assert.doesNotMatch(dialog, /new TextDecoder/);
});

// --- DBeaver-aligned viewer: format detection + charset selection ---

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// GB18030/GBK byte sequences for '中文数据' (verified against TextDecoder('gb18030')).
const GBK_BYTES = [0xd6, 0xd0, 0xce, 0xc4, 0xca, 0xfd, 0xbe, 0xdd];

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e]; // %PDF-1.
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const GZIP_MAGIC = [0x1f, 0x8b, 0x08, 0x00];

test('detectContentFormat keeps image magic as image kind', () => {
  assert.equal(detectContentFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).kind, 'image');
  assert.equal(detectContentFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).mime, 'image/jpeg');
  assert.equal(detectContentFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).kind, 'image');
});

test('detectContentFormat detects document and archive formats', () => {
  assert.deepEqual(detectContentFormat(new Uint8Array(PDF_MAGIC)), { kind: 'pdf', mime: 'application/pdf' });
  assert.deepEqual(detectContentFormat(new Uint8Array(ZIP_MAGIC)), { kind: 'zip', mime: 'application/zip' });
  assert.deepEqual(detectContentFormat(new Uint8Array(GZIP_MAGIC)), { kind: 'gzip', mime: 'application/gzip' });
});

test('detectContentFormat classifies utf-8 and multi-encoding text as text', () => {
  assert.equal(detectContentFormat(utf8('中文数据 #db\n')).kind, 'text');
  assert.equal(detectContentFormat(new Uint8Array(GBK_BYTES)).kind, 'text');
  assert.equal(detectContentFormat(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e])).kind, 'text'); // UTF-16LE BOM + '中'
  assert.equal(detectContentFormat(new Uint8Array([0x63, 0x61, 0x66, 0xe9])).kind, 'text'); // cp1252 'café'
});

test('detectContentFormat marks control-byte and unpaired data as binary', () => {
  assert.equal(detectContentFormat(new Uint8Array([0x00, 0x01, 0x02, 0x03])).kind, 'binary');
  // Odd tail byte breaks GB18030 pairing; cp1252 ratio stays below the text threshold.
  assert.equal(detectContentFormat(new Uint8Array([0x00, 0xc8, 0xd2, 0xaa, 0xe1])).kind, 'binary');
  assert.equal(detectContentFormat(new Uint8Array([])).kind, 'binary');
});

test('printableRatio counts text chars and rejects control bytes', () => {
  assert.equal(printableRatio('abc\t\n'), 1);
  assert.ok(printableRatio('\u0001\u0002abc') < 0.85);
  assert.equal(printableRatio('中文'), 1);
});

test('decodeTextPreview auto chain picks gb18030 for GBK bytes', () => {
  const result = decodeTextPreview(new Uint8Array(GBK_BYTES), 'auto');
  assert.equal(result.text, '中文数据');
  assert.equal(result.encoding, 'gb18030');
  assert.equal(result.truncated, 0);
});

test('decodeTextPreview auto chain picks utf-8 for utf-8 text', () => {
  const result = decodeTextPreview(utf8('中文数据 hello'), 'auto');
  assert.equal(result.text, '中文数据 hello');
  assert.equal(result.encoding, 'utf-8');
});

test('decodeTextPreview auto chain honors utf-16 BOM', () => {
  const result = decodeTextPreview(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]), 'auto');
  assert.equal(result.text, '中文');
  assert.equal(result.encoding, 'utf-16le');
});

test('decodeTextPreview decodes with an explicit encoding', () => {
  assert.equal(decodeTextPreview(new Uint8Array(GBK_BYTES), 'gb18030').text, '中文数据');
  assert.equal(decodeTextPreview(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'windows-1252').text, 'café');
});

test('decodeTextPreview truncates at the 32KB cap', () => {
  const result = decodeTextPreview(utf8('a'.repeat(40_000)), 'auto');
  assert.equal(result.text.length, 32_768);
  assert.equal(result.truncated, 40_000 - 32_768);
});

test('decodeTextPreview truncation never splits a multibyte char', () => {
  const result = decodeTextPreview(utf8('a'.repeat(32_766) + '中'), 'auto');
  assert.ok(!result.text.includes('\uFFFD'), 'no replacement char at the cut');
  assert.ok(result.text.endsWith('a'));
  assert.equal(result.truncated, 3);
});

test('defaultTabForFormat sends images and text to preview, the rest to hex', () => {
  assert.equal(defaultTabForFormat({ kind: 'image', mime: 'image/png' }), 'preview');
  assert.equal(defaultTabForFormat({ kind: 'text', mime: null }), 'preview');
  assert.equal(defaultTabForFormat({ kind: 'pdf', mime: 'application/pdf' }), 'hex');
  assert.equal(defaultTabForFormat({ kind: 'zip', mime: 'application/zip' }), 'hex');
  assert.equal(defaultTabForFormat({ kind: 'gzip', mime: 'application/gzip' }), 'hex');
  assert.equal(defaultTabForFormat({ kind: 'binary', mime: null }), 'hex');
});

test('BLOB_TEXT_ENCODINGS covers auto plus the manual charset list', () => {
  const ids = BLOB_TEXT_ENCODINGS.map((entry) => entry.id);
  assert.deepEqual(ids, ['auto', 'utf-8', 'gb18030', 'big5', 'shift_jis', 'windows-1252', 'utf-16le', 'utf-16be']);
  // Every manual id must be a TextDecoder-supported label so the selector can never fail.
  for (const id of ids) {
    if (id !== 'auto') new TextDecoder(id);
  }
});
