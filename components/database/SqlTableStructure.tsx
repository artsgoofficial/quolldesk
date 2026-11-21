import React, { useEffect, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import type { SqlTableMeta } from '../../types/global/quolldesk-bridge-database';
import { Button } from '../ui/button';

interface SqlTableStructureProps {
  connectionId: string;
  dialect: 'mysql' | 'postgresql';
  table: string | null;
  schema?: string;
  refreshToken?: number;
  /** Present for SQL dialects: opens the table designer prefilled with this table. */
  onEditTable?: () => void;
}

// Structure leaf for SQL workbench tables (and views): columns
// (name/type/nullable/default/key), indexes (name, access method, columns,
// unique marker) and the source definition block — mysql `Create Table` /
// `Create View`, pg `pg_get_viewdef` for views (tables carry ddl: null, their
// index definitions are already listed above). Styling mirrors SqlTableData.
const SqlTableStructure: React.FC<SqlTableStructureProps> = ({ connectionId, dialect, table, schema, refreshToken, onEditTable }) => {
  const { t } = useI18n();
  const [meta, setMeta] = useState<SqlTableMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const client = databaseClient[dialect];

  useEffect(() => {
    if (!table) { setMeta(null); setError(null); return; }
    let alive = true;
    setLoading(true); setError(null);
    (async () => {
      try {
        const result = await client.tableMeta({ connectionId, table, schema });
        if (alive) setMeta(result);
      } catch (err) {
        if (alive) setError(dbErrorMessage(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [connectionId, client, table, schema, refreshToken]);

  if (!table) {
    return <div className="p-4 text-sm text-muted-foreground">{t('db.workbench.noSelection')}</div>;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-1.5 border-b border-border/60 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{schema ? `${schema}.${table}` : table}</span>
        {meta != null && <span>{t('db.workbench.estimateRows', { count: meta.rowCountEstimate })}</span>}
        {onEditTable && (
          <Button variant="outline" size="sm" className="h-7 ml-auto" title={t('db.designer.edit')}
            onClick={onEditTable}>
            {t('db.designer.edit')}
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-xs px-3 py-2">{error}</p>}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b border-border/60">
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">{t('field.name')}</th>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">{t('db.workbench.keyMeta.type')}</th>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">{t('db.workbench.keyMeta.nullable')}</th>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">{t('db.workbench.keyMeta.default')}</th>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">{t('db.workbench.keyMeta.key')}</th>
            </tr>
          </thead>
          <tbody>
            {(meta?.columns ?? []).map((c) => (
              <tr key={c.name} className="border-b border-border/30 hover:bg-foreground/5">
                <td className="px-2 py-1 font-mono">{c.name}</td>
                <td className="px-2 py-1 text-muted-foreground font-mono">{c.type}</td>
                <td className="px-2 py-1 text-muted-foreground">{c.nullable ? '✓' : ''}</td>
                <td className="px-2 py-1 font-mono break-all max-w-[240px]">
                  {c.defaultValue == null ? '' : String(c.defaultValue)}
                </td>
                <td className="px-2 py-1 font-mono">{c.key || ''}</td>
              </tr>
            ))}
            {!loading && !error && meta !== null && meta.columns.length === 0 && (
              <tr><td colSpan={5} className="px-2 py-2 text-muted-foreground">{t('common.noResultsFound')}</td></tr>
            )}
          </tbody>
        </table>
        {meta !== null && meta.indexes.length > 0 && (
          <>
            <div className="px-3 pt-3 pb-1 text-xs font-medium text-foreground/80">{t('db.workbench.section.indexes')}</div>
            <ul className="px-3 pb-2 space-y-1">
              {meta.indexes.map((idx) => (
                <li key={idx.name} className="text-xs font-mono break-all">
                  <span className="text-foreground">{idx.name}</span>
                  {idx.method && <span className="text-muted-foreground"> ({idx.method})</span>}
                  {idx.unique && <span className="ml-1.5 text-amber-500 font-sans">{t('db.workbench.keyMeta.unique')}</span>}
                  <span className="text-muted-foreground">
                    {' — '}{idx.columns.join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {meta?.ddl && (
          <>
            <div className="px-3 pt-3 pb-1 text-xs font-medium text-foreground/80">{t('db.structure.definition')}</div>
            <pre className="mx-3 mb-4 text-xs font-mono whitespace-pre-wrap break-words text-muted-foreground border border-border/40 rounded p-2">{meta.ddl}</pre>
          </>
        )}
      </div>
    </div>
  );
};

export default SqlTableStructure;
