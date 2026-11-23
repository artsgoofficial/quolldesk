/**
 * BLOB viewer dialog (DBeaver-aligned): opens a binary grid cell as
 * preview / hex dump tabs with a charset selector for the text view.
 * Readable text and images preview inline; documents/archives land on
 * the hex tab with a format badge instead of a mojibake wall. Value
 * parsing, format sniffing and decoding are delegated to blobViewer.ts.
 */
import { Copy, Download } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { STORAGE_KEY_DB_BLOB_ENCODING } from '../../infrastructure/config/storageKeys';
import {
  BLOB_TEXT_ENCODINGS,
  decodeTextPreview,
  defaultTabForFormat,
  detectContentFormat,
  parseCellValueToBytes,
  printableRatio,
  toHexDump,
  type BlobContentFormat,
  type BlobEncodingId,
} from './blobViewer';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { toast } from '../ui/toast';

interface BlobViewerDialogProps {
  columnName: string;
  value: unknown;
  onClose: () => void;
}

type ViewTab = 'preview' | 'hex';

/** Decoded text must clear the printable threshold to render as text. */
const READABLE_RATIO = 0.85;

const isEncodingId = (value: string | null): value is BlobEncodingId =>
  BLOB_TEXT_ENCODINGS.some((entry) => entry.id === value);

const readStoredEncoding = (): BlobEncodingId => {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY_DB_BLOB_ENCODING) ?? null;
    return isEncodingId(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
};

const storeEncoding = (id: BlobEncodingId) => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY_DB_BLOB_ENCODING, id);
  } catch { /* persistence is best-effort */ }
};

/** Chunked base64 data URL: spreading 2M args into fromCharCode overflows the stack. */
const bytesToDataUrl = (bytes: Uint8Array, mime: string): string => {
  let binary = '';
  const view = bytes.subarray(0, 2_000_000);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
};

const FORMAT_LABEL_KEYS: Record<Exclude<BlobContentFormat['kind'], 'image' | 'text'>, string> = {
  pdf: 'db.blob.fmt.pdf',
  zip: 'db.blob.fmt.zip',
  gzip: 'db.blob.fmt.gzip',
  binary: 'db.blob.fmt.binary',
};

const ENCODING_LABEL_KEYS: Record<Exclude<BlobEncodingId, 'auto'>, string> = {
  'utf-8': 'db.blob.enc.utf8',
  gb18030: 'db.blob.enc.gb18030',
  big5: 'db.blob.enc.big5',
  shift_jis: 'db.blob.enc.shiftJis',
  'windows-1252': 'db.blob.enc.cp1252',
  'utf-16le': 'db.blob.enc.utf16le',
  'utf-16be': 'db.blob.enc.utf16be',
};

export const BlobViewerDialog: React.FC<BlobViewerDialogProps> = ({ columnName, value, onClose }) => {
  const { t } = useI18n();
  const bytes = useMemo(() => parseCellValueToBytes(value), [value]);
  const format = useMemo(() => (bytes ? detectContentFormat(bytes) : null), [bytes]);
  const [tab, setTab] = useState<ViewTab>(() => (bytes ? defaultTabForFormat(detectContentFormat(bytes)) : 'preview'));
  const [encodingId, setEncodingId] = useState<BlobEncodingId>(readStoredEncoding);
  const decoded = useMemo(
    () => (bytes && format?.kind !== 'image' ? decodeTextPreview(bytes, encodingId) : null),
    [bytes, format, encodingId],
  );
  const readable = decoded ? printableRatio(decoded.text) >= READABLE_RATIO : false;
  const mime = format?.mime ?? null;
  const dataUrl = useMemo(() => (bytes && mime ? bytesToDataUrl(bytes, mime) : null), [bytes, mime]);
  const hexDump = useMemo(() => (bytes ? toHexDump(bytes) : ''), [bytes]);

  const changeEncoding = (id: BlobEncodingId) => {
    setEncodingId(id);
    storeEncoding(id);
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => toast.success(t('common.copied'))).catch(() => {});
  };
  const download = () => {
    if (!bytes) return;
    const ext = mime ? `.${mime.split('/')[1]}` : '.bin';
    const blob = new Blob([new Uint8Array(bytes)], { type: mime ?? 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${columnName}${ext}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const formatBadge = format && (format.kind === 'image' || format.kind === 'text')
    ? null
    : format?.kind
      ? t(FORMAT_LABEL_KEYS[format.kind])
      : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{t('db.blob.title')} · {columnName}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 text-xs">
          {(['preview', 'hex'] as ViewTab[]).map((which) => (
            <button key={which} type="button"
              className={`px-2 py-1 rounded-t ${tab === which ? 'bg-foreground/10 text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setTab(which)}>
              {t(which === 'preview' ? 'db.blob.preview' : 'db.blob.hex')}
            </button>
          ))}
          {bytes && (
            <label className="flex items-center gap-1 text-muted-foreground ml-2">
              {t('db.blob.encoding')}
              <select
                className="bg-background border border-border/60 rounded px-1 py-0.5 text-xs"
                value={encodingId}
                onChange={(e) => changeEncoding(e.target.value as BlobEncodingId)}>
                {BLOB_TEXT_ENCODINGS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id === 'auto' ? t('db.blob.enc.auto') : t(ENCODING_LABEL_KEYS[entry.id])}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="text-muted-foreground ml-auto flex items-center gap-2">
            {formatBadge && <span className="px-1.5 py-0.5 rounded bg-foreground/10">{formatBadge}</span>}
            {mime && <span>{mime}</span>}
            {bytes ? `${bytes.length} ${t('db.blob.bytes')}` : t('db.blob.notBinary')}
          </span>
        </div>
        <div className="min-h-[200px] max-h-[50vh] overflow-auto border border-border/40 rounded p-2">
          {!bytes && <p className="text-muted-foreground text-xs">{t('db.blob.notBinary')}</p>}
          {bytes && tab === 'preview' && (
            mime && dataUrl && format?.kind === 'image' ? (
              <img src={dataUrl} alt={columnName} className="max-w-full max-h-[45vh]" />
            ) : readable && decoded ? (
              <pre className="text-xs font-mono whitespace-pre-wrap break-all">{decoded.text}</pre>
            ) : (
              <div className="flex flex-col items-center justify-center gap-1 py-10 text-muted-foreground text-xs">
                <p>{formatBadge ?? t('db.blob.fmt.binary')} · {bytes.length} {t('db.blob.bytes')}</p>
                <p>{t('db.blob.downloadHint')}</p>
              </div>
            )
          )}
          {bytes && tab === 'hex' && (
            <pre className="text-[10px] font-mono whitespace-pre">{hexDump}</pre>
          )}
        </div>
        {bytes && decoded && decoded.truncated > 0 && tab === 'preview' && readable && (
          <p className="text-[11px] text-muted-foreground">
            {t('db.blob.truncated', { count: decoded.truncated })}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!bytes} onClick={() => copy(hexDump)}
            title={t('db.blob.copyHex')}>
            <Copy size={12} className="mr-1" />{t('db.blob.copyHex')}
          </Button>
          <Button variant="outline" size="sm" disabled={!readable || !decoded} onClick={() => decoded && copy(decoded.text)}
            title={t('db.blob.copyText')}>
            <Copy size={12} className="mr-1" />{t('db.blob.copyText')}
          </Button>
          <Button variant="outline" size="sm" disabled={!bytes} onClick={download}
            title={t('db.blob.download')}>
            <Download size={12} className="mr-1" />{t('db.blob.download')}
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BlobViewerDialog;
