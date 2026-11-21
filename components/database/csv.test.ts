import assert from 'node:assert/strict';
import { test } from 'node:test';

import { downloadCsv, downloadInserts, downloadJson } from './csv';

// Stub the download plumbing so export helpers can run under node --test:
// a fake Blob (synchronous parts access), and a fake anchor whose click()
// records filename + blob into `downloads`.
type FakeBlob = { parts: string[]; type: string };
type CapturedDownload = { filename: string; mime: string; blob: FakeBlob };

const downloads: CapturedDownload[] = [];
let currentBlob: FakeBlob | null = null;

class StubBlob {
  parts: string[];
  type: string;
  constructor(parts: BlobPart[], options?: { type?: string }) {
    this.parts = parts.map(String);
    this.type = options?.type ?? '';
  }
}

(globalThis as any).Blob = StubBlob;
(globalThis as any).document = {
  createElement() {
    return {
      href: '',
      download: '',
      click() {
        downloads.push({ filename: this.download, mime: currentBlob?.type ?? '', blob: currentBlob! });
      },
    };
  },
};
URL.createObjectURL = ((blob: FakeBlob) => {
  currentBlob = blob;
  return 'blob:unit-test';
}) as any;
URL.revokeObjectURL = (() => {}) as any;

const lastDownload = (): CapturedDownload => downloads[downloads.length - 1];

test('downloadCsv emits a BOM, CRLF lines and Excel-safe escaping', () => {
  downloadCsv(
    'orders.csv',
    ['id', 'name', 'note'],
    [
      [1, 'plain', 'ok'],
      [2, 'comma, inside', 'quote " and \nnewline'],
      [3, null, undefined],
    ],
  );
  const dl = lastDownload();
  assert.equal(dl.filename, 'orders.csv');
  assert.equal(dl.mime, 'text/csv;charset=utf-8');
  const text = dl.blob.parts.join('');
  assert.ok(text.startsWith('\uFEFF'), 'UTF-8 BOM present');
  const body = text.slice(1);
  assert.deepEqual(body.split('\r\n'), [
    'id,name,note',
    '1,plain,ok',
    '2,"comma, inside","quote "" and \nnewline"',
    '3,,',
  ]);
});

test('downloadJson writes one object per row with null for empty cells', () => {
  downloadJson(
    'rows.json',
    ['a', 'b'],
    [
      [1, 'x'],
      [2, null],
      [3],
    ],
  );
  const dl = lastDownload();
  assert.equal(dl.filename, 'rows.json');
  assert.equal(dl.mime, 'application/json;charset=utf-8');
  const text = dl.blob.parts.join('');
  assert.ok(text.endsWith('\n'));
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, [
    { a: 1, b: 'x' },
    { a: 2, b: null },
    { a: 3, b: null },
  ]);
  assert.ok(text.startsWith('[\n  '), 'pretty-printed with two-space indent');
});

test('downloadInserts escapes single quotes and maps null cells to NULL', () => {
  downloadInserts(
    'inserts.sql',
    'public.users',
    ['id', 'name'],
    [
      [1, 'O\'Brien'],
      [2, null],
    ],
  );
  const dl = lastDownload();
  assert.equal(dl.filename, 'inserts.sql');
  assert.equal(dl.mime, 'text/plain;charset=utf-8');
  const text = dl.blob.parts.join('');
  // Numbers are also rendered as quoted literals — only null maps to bare NULL.
  assert.equal(text, [
    "INSERT INTO public.users (id, name) VALUES ('1', 'O''Brien');",
    "INSERT INTO public.users (id, name) VALUES ('2', NULL);",
    '',
  ].join('\n'));
});
