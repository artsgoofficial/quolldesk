import React, { useState } from 'react';
import { ClipboardCopy, FileInput, Replace } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { toast } from '../ui/toast';
import { emitSqlEditorAction } from '../../application/state/sqlEditorBridge';

/**
 * Insert/replace/copy actions under an assistant message that proposed SQL
 * (database AI chats only). Emits through sqlEditorBridge — the query editor
 * in the workbench consumes it; the AI column opens via the workbench listener.
 */
const SqlMessageActions: React.FC<{ blocks: string[] }> = ({ blocks }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  if (!blocks.length) return null;
  const sql = blocks[blocks.length - 1];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('db.ai.sql.copy'));
    }
  };

  return (
    <div className="flex items-center gap-1 mt-1 flex-wrap">
      <button
        type="button"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/5"
        onClick={() => emitSqlEditorAction({ kind: 'insert', sql })}
      >
        <FileInput size={12} />{t('db.ai.sql.insert')}
      </button>
      <button
        type="button"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/5"
        onClick={() => emitSqlEditorAction({ kind: 'replace', sql })}
      >
        <Replace size={12} />{t('db.ai.sql.replace')}
      </button>
      <button
        type="button"
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs hover:bg-foreground/5 ${copied ? 'text-emerald-600' : 'text-muted-foreground hover:text-foreground'}`}
        onClick={() => void copy()}
      >
        <ClipboardCopy size={12} />{t('db.ai.sql.copy')}
      </button>
    </div>
  );
};

export default SqlMessageActions;
