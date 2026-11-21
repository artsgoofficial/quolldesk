import { ChevronDown, ChevronRight, Table2, View } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { ContextMenu, ContextMenuTrigger } from '../ui/context-menu';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { fetchSqlSchemaTree } from '@/infrastructure/services/sqlSchemaTreeCache';
import {
  SqlDatabaseContextMenuContent,
  SqlDatabaseContextMenuHandlers,
  SqlObjectContextMenuHandlers,
  SqlTableContextMenuContent,
  SqlViewContextMenuContent,
  SqlViewContextMenuHandlers,
} from './DatabaseTreeContextMenus';

interface SqlSchemaTreeProps {
  connectionId: string;
  dialect: 'mysql' | 'postgresql';
  onSelectTable: (table: string, kind: 'table' | 'view', schema?: string) => void;
  refreshToken?: number;
  /** Present for SQL dialects: opens the visual table designer in create mode. */
  onCreateTable?: () => void;
  /** Selected tree "database" (mysql db / pg schema) for row highlight. */
  selectedDatabase?: string;
  /** Clicking a database row reports it so workbench-scoped actions follow it. */
  onSelectDatabase?: (name: string) => void;
  /** Right-click menus; omitting them keeps the tree context-menu-free. */
  dbMenu?: SqlDatabaseContextMenuHandlers;
  tableMenu?: SqlObjectContextMenuHandlers;
  viewMenu?: SqlViewContextMenuHandlers;
}

const SqlSchemaTree: React.FC<SqlSchemaTreeProps> = ({
  connectionId,
  dialect,
  onSelectTable,
  refreshToken,
  onCreateTable,
  selectedDatabase,
  onSelectDatabase,
  dbMenu,
  tableMenu,
  viewMenu,
}) => {
  const { t } = useI18n();
  const [databases, setDatabases] = useState<{ name: string; tables: string[]; views: string[] }[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    // Shared cache: the query editor's intellisense consumes the same
    // snapshot without a second round trip.
    fetchSqlSchemaTree(dialect, connectionId, refreshToken ?? 0)
      .then((tree) => { if (alive) setDatabases(tree.databases); })
      .catch((err) => { if (alive) setError(dbErrorMessage(err)); });
    return () => { alive = false; };
  }, [connectionId, dialect, refreshToken]);

  const total = useMemo(() => databases.reduce((acc, d) => acc + d.tables.length + d.views.length, 0), [databases]);

  return (
    <>
      {onCreateTable && (
        <div className="px-2 py-1 border-b border-border/60 flex items-center shrink-0">
          <button type="button" title={t('db.designer.newTable')}
            className="h-6 w-6 ml-auto rounded border border-input text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            onClick={onCreateTable}>
            +
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto p-1 text-xs">
        {error && <p className="text-destructive px-2 py-1">{error}</p>}
        {!error && total === 0 && <p className="text-muted-foreground px-2 py-1">{t('db.workbench.noTables')}</p>}
      {databases.map((db) => (
        <div key={db.name}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <button type="button"
                className={`flex items-center gap-1 w-full px-2 py-1 font-medium hover:bg-foreground/5 ${selectedDatabase === db.name ? 'text-foreground bg-foreground/10' : 'text-foreground/80'}`}
                onClick={() => { setCollapsed((prev) => ({ ...prev, [db.name]: !prev[db.name] })); onSelectDatabase?.(db.name); }}>
                {collapsed[db.name] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {db.name}
              </button>
            </ContextMenuTrigger>
            {dbMenu && <SqlDatabaseContextMenuContent name={db.name} dialect={dialect} {...dbMenu} />}
          </ContextMenu>
          {!collapsed[db.name] && (
            <>
              {db.tables.map((table) => (
                <ContextMenu key={`t/${db.name}/${table}`}>
                  <ContextMenuTrigger asChild>
                    <button type="button" className="flex items-center gap-1.5 w-full px-4 py-0.5 text-left hover:bg-foreground/5 truncate"
                      onClick={() => onSelectTable(table, 'table', dialect === 'postgresql' ? db.name : undefined)}>
                      <Table2 size={11} className="text-muted-foreground flex-shrink-0" />
                      <span className="truncate">{table}</span>
                    </button>
                  </ContextMenuTrigger>
                  {tableMenu && (
                    <SqlTableContextMenuContent table={table} schema={dialect === 'postgresql' ? db.name : undefined} {...tableMenu} />
                  )}
                </ContextMenu>
              ))}
              {db.views.map((view) => (
                <ContextMenu key={`v/${db.name}/${view}`}>
                  <ContextMenuTrigger asChild>
                    <button type="button" className="flex items-center gap-1.5 w-full px-4 py-0.5 text-left hover:bg-foreground/5 truncate"
                      onClick={() => onSelectTable(view, 'view', dialect === 'postgresql' ? db.name : undefined)}>
                      <View size={11} className="text-muted-foreground flex-shrink-0" />
                      <span className="truncate">{view}</span>
                    </button>
                  </ContextMenuTrigger>
                  {viewMenu && (
                    <SqlViewContextMenuContent view={view} schema={dialect === 'postgresql' ? db.name : undefined} {...viewMenu} />
                  )}
                </ContextMenu>
              ))}
            </>
          )}
        </div>
      ))}
      </div>
    </>
  );
};

export default SqlSchemaTree;
