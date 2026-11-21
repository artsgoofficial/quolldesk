import {
  Clock,
  Copy,
  Database,
  DatabaseBackup,
  Eye,
  FilePlus2,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react';
import React from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '../ui/context-menu';

/**
 * Right-click menus for the database sidebar trees (Navicat-style). These
 * stay dumb: every item forwards to a handler owned by DatabaseWorkbench /
 * RedisKeyTree, which compose the SQL (see ./sqlIdent) and own the confirm
 * dialogs, execution and toasts.
 */

export type SqlObjectKind = 'table' | 'view';

export interface SqlDatabaseContextMenuHandlers {
  onNewTable: (name: string) => void;
  onNewQuery: (name: string) => void;
  onRefresh: () => void;
  onBackup: (name: string) => void;
  onDrop: (name: string) => void;
}

export const SqlDatabaseContextMenuContent: React.FC<
  SqlDatabaseContextMenuHandlers & { name: string; dialect: 'mysql' | 'postgresql' }
> = ({ name, dialect, onNewTable, onNewQuery, onRefresh, onBackup, onDrop }) => {
  const { t } = useI18n();
  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onNewTable(name)}>
        <Plus className="mr-2 h-4 w-4" /> {t('db.tree.menu.newTable')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onNewQuery(name)}>
        <FilePlus2 className="mr-2 h-4 w-4" /> {t('db.tree.menu.newQuery')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onRefresh}>
        <RefreshCw className="mr-2 h-4 w-4" /> {t('db.action.refresh')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onBackup(name)}>
        <DatabaseBackup className="mr-2 h-4 w-4" /> {t('db.tree.menu.backup')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => onDrop(name)}
        className="text-destructive focus:text-destructive"
      >
        <Database className="mr-2 h-4 w-4" /> {t(dialect === 'postgresql' ? 'db.tree.menu.dropSchema' : 'db.tree.menu.dropDatabase')}
      </ContextMenuItem>
    </ContextMenuContent>
  );
};

export interface SqlObjectContextMenuHandlers {
  onOpenData: (object: string, schema?: string) => void;
  onDesign?: (object: string, schema?: string) => void;
  onOpenStructure: (object: string, schema?: string) => void;
  onNewQuery: (object: string, schema?: string) => void;
  onCopyName: (object: string) => void;
  onTruncate?: (object: string, schema?: string) => void;
  onRename: (object: string, schema?: string) => void;
  onDrop: (object: string, schema?: string) => void;
}

/**
 * Shared table/view menu: design and truncate exist only for tables. Views
 * keep open/query/copy/rename/drop.
 */
export const SqlObjectContextMenuContent: React.FC<
  SqlObjectContextMenuHandlers & { object: string; schema?: string; kind: SqlObjectKind }
> = ({ object, schema, kind, onOpenData, onDesign, onOpenStructure, onNewQuery, onCopyName, onTruncate, onRename, onDrop }) => {
  const { t } = useI18n();
  const isTable = kind === 'table';
  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onOpenData(object, schema)}>
        <Eye className="mr-2 h-4 w-4" /> {t(isTable ? 'db.tree.menu.openTable' : 'db.tree.menu.openView')}
      </ContextMenuItem>
      {isTable && onDesign && (
        <ContextMenuItem onClick={() => onDesign(object, schema)}>
          <Settings2 className="mr-2 h-4 w-4" /> {t('db.tree.menu.design')}
        </ContextMenuItem>
      )}
      {isTable && (
        <ContextMenuItem onClick={() => onOpenStructure(object, schema)}>
          <ListTree className="mr-2 h-4 w-4" /> {t('db.workbench.tab.structure')}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => onNewQuery(object, schema)}>
        <FilePlus2 className="mr-2 h-4 w-4" /> {t('db.tree.menu.newQuery')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopyName(object)}>
        <Copy className="mr-2 h-4 w-4" /> {t('db.tree.menu.copyName')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {kind === 'table' && onTruncate && (
        <ContextMenuItem
          onClick={() => onTruncate(object, schema)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" /> {t('db.tree.menu.truncate')}
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => onRename(object, schema)}>
        <Pencil className="mr-2 h-4 w-4" /> {t('common.rename')}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => onDrop(object, schema)}
        className="text-destructive focus:text-destructive"
      >
        <Trash2 className="mr-2 h-4 w-4" /> {t(isTable ? 'db.tree.menu.dropTable' : 'db.tree.menu.dropView')}
      </ContextMenuItem>
    </ContextMenuContent>
  );
};

export const SqlTableContextMenuContent: React.FC<
  SqlObjectContextMenuHandlers & { table: string; schema?: string }
> = ({ table, schema, ...handlers }) => (
  <SqlObjectContextMenuContent object={table} schema={schema} kind="table" {...handlers} />
);

/** View handlers drop design/truncate (and DROP emits DROP VIEW upstream). */
export type SqlViewContextMenuHandlers = Omit<SqlObjectContextMenuHandlers, 'onDesign' | 'onTruncate'>;

export const SqlViewContextMenuContent: React.FC<
  SqlViewContextMenuHandlers & { view: string; schema?: string }
> = ({ view, schema, ...handlers }) => (
  <SqlObjectContextMenuContent object={view} schema={schema} kind="view" {...handlers} />
);

export interface RedisKeyContextMenuHandlers {
  onOpen: (key: string, nodeId?: string) => void;
  onCopyName: (key: string) => void;
  onTtl: (key: string, nodeId?: string) => void;
  onRemoveExpiry: (key: string, nodeId?: string) => void;
  onRename: (key: string, nodeId?: string) => void;
  onDelete: (key: string, nodeId?: string) => void;
}

export const RedisKeyContextMenuContent: React.FC<
  RedisKeyContextMenuHandlers & { name: string; nodeId?: string }
> = ({ name: key, nodeId, onOpen, onCopyName, onTtl, onRemoveExpiry, onRename, onDelete }) => {
  const { t } = useI18n();
  return (
    <ContextMenuContent>
      <ContextMenuItem onClick={() => onOpen(key, nodeId)}>
        <Eye className="mr-2 h-4 w-4" /> {t('db.tree.menu.openKey')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopyName(key)}>
        <Copy className="mr-2 h-4 w-4" /> {t('db.tree.menu.copyName')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onTtl(key, nodeId)}>
        <Clock className="mr-2 h-4 w-4" /> {t('db.tree.menu.ttl')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onRemoveExpiry(key, nodeId)}>
        <Clock className="mr-2 h-4 w-4" /> {t('db.redis.removeExpiry')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onRename(key, nodeId)}>
        <Pencil className="mr-2 h-4 w-4" /> {t('common.rename')}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => onDelete(key, nodeId)}
        className="text-destructive focus:text-destructive"
      >
        <Trash2 className="mr-2 h-4 w-4" /> {t('common.delete')}
      </ContextMenuItem>
    </ContextMenuContent>
  );
};
