import { ChevronDown, ChevronRight, Plus, Search, Table2, View } from 'lucide-react';
import { ToolbarTextButton } from '../ui/toolbar-item-layout';
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { SQL_ENGINE_BY_ID, type SqlEngineId } from '../../domain/models/dbEngines';
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
  dialect: SqlEngineId;
  onSelectTable: (table: string, kind: 'table' | 'view', schema?: string) => void;
  refreshToken?: number;
  /** Present for SQL dialects: opens the visual table designer in create mode. */
  onCreateTable?: () => void;
  /** Present for SQL dialects: opens the database-wide search panel. */
  onOpenSearch?: () => void;
  /** Selected tree "database" (mysql db / pg+mssql schema) for row highlight. */
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
  onOpenSearch,
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
          <div className="ml-auto flex items-center gap-1">
            {onOpenSearch && (
              <ToolbarTextButton icon={<Search size={12} />} label={t('db.search.openSearch')}
                title={t('db.search.openSearch')} onClick={onOpenSearch} />
            )}
            {onCreateTable && (
              <ToolbarTextButton icon={<Plus size={12} />} label={t('db.designer.newTable')}
                title={t('db.designer.newTable')} onClick={onCreateTable} />
            )}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-auto p-1 text-xs">
        {error && <p className="text-destructive px-2 py-1">{error}</p>}
        {!error && total === 0 && <p className="text-muted-foreground px-2 py-1">{t('db.workbench.noTables')}</p>}
      {databases.map((db) => {
        // Schema pass-through: only schema-qualified engines (pg/mssql) treat
        // the tree's database node as the objects' schema qualifier.
        const schema = SQL_ENGINE_BY_ID[dialect]?.schemaQualified ? db.name : undefined;
        return (
        <div key={db.name}>
          <ContextMenu>
            <ContextMenuTrigger
              asChild
              onContextMenu={(e) => {
                // Radix composeEventHandlers checks defaultPrevented before
                // its internal open handler: preventDefault here (event came
                // from a nested table/view row) keeps the parent menu closed
                // so the child's own menu stays up.
                if ((e.target as HTMLElement).closest?.('[data-tree-row]')) e.preventDefault();
              }}
            >
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
                  {/* Radix triggers do not stopPropagation: without this the
                      event bubbles to the schema row's trigger and its menu
                      overwrites the table menu (nested menu bug). */}
                  <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
                    <button type="button" data-tree-row="1" className="flex items-center gap-1.5 w-full px-4 py-0.5 text-left hover:bg-foreground/5 truncate"
                      onClick={() => onSelectTable(table, 'table', schema)}>
                      <Table2 size={11} className="text-muted-foreground flex-shrink-0" />
                      <span className="truncate">{table}</span>
                    </button>
                  </ContextMenuTrigger>
                  {tableMenu && (
                    <SqlTableContextMenuContent table={table} schema={schema} {...tableMenu} />
                  )}
                </ContextMenu>
              ))}
              {db.views.map((view) => (
                <ContextMenu key={`v/${db.name}/${view}`}>
                  <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
                    <button type="button" data-tree-row="1" className="flex items-center gap-1.5 w-full px-4 py-0.5 text-left hover:bg-foreground/5 truncate"
                      onClick={() => onSelectTable(view, 'view', schema)}>
                      <View size={11} className="text-muted-foreground flex-shrink-0" />
                      <span className="truncate">{view}</span>
                    </button>
                  </ContextMenuTrigger>
                  {viewMenu && (
                    <SqlViewContextMenuContent view={view} schema={schema} {...viewMenu} />
                  )}
                </ContextMenu>
              ))}
            </>
          )}
        </div>
        );
      })}
      </div>
    </>
  );
};

export default SqlSchemaTree;
