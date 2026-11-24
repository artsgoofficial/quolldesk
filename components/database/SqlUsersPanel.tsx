/**
 * User management panel (pg/mysql): list users/roles, create (name +
 * password dialog), drop (two-click confirm) and per-user privileges —
 * pg edits role attributes (ALTER ROLE) + role membership (GRANT/REVOKE
 * role), mysql diffs common privileges on the current database against
 * SHOW GRANTS. Everything runs through the existing query channel.
 * The workbench hides the tab for engines without user management
 * (registry `features.users`).
 */
import { UserPlus } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { SqlEngineId } from '../../domain/models/dbEngines';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import {
  attributesQuery,
  availableRolesQuery,
  buildAlterRoleSql,
  buildCreateUserSql,
  buildDropUserSql,
  buildGrantMembershipSql,
  buildGrantPrivsSql,
  buildRevokeMembershipSql,
  buildRevokePrivsSql,
  membershipsQuery,
  MYSQL_COMMON_PRIVS,
  parseShowGrantsReply,
  privilegesOnDatabase,
  showGrantsSql,
  usersQuery,
  type PgRoleAttributes,
} from './sqlUsers';
import SqlPanelHeader from './SqlPanelHeader';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { toast } from '../ui/toast';

interface SqlUsersPanelProps {
  connectionId: string;
  dialect: SqlEngineId;
  onClose: () => void;
}

interface PrivUser {
  name: string;
  host: string;
}

const PG_ATTR_ITEMS: { key: keyof PgRoleAttributes; label: string }[] = [
  { key: 'login', label: 'login' },
  { key: 'superuser', label: 'superuser' },
  { key: 'createdb', label: 'createdb' },
  { key: 'createrole', label: 'createrole' },
];

/** pg bridge booleans may arrive as true / 't' / 'true'. */
const flag = (v: unknown): boolean => v === true || v === 't' || v === 'true';

export const SqlUsersPanel: React.FC<SqlUsersPanelProps> = ({ connectionId, dialect, onClose }) => {
  const { t } = useI18n();
  const querySet = usersQuery(dialect);
  // Rows are plain cell arrays aligned 1:1 with querySet.columns (name first).
  const [users, setUsers] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [armedUser, setArmedUser] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  // batch operations: row selection keyed by name (mysql also carries host)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchArmed, setBatchArmed] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchRoleSel, setBatchRoleSel] = useState('');

  // v2 privileges dialog state
  const [privUser, setPrivUser] = useState<PrivUser | null>(null);
  const [privLoading, setPrivLoading] = useState(false);
  const [privBusy, setPrivBusy] = useState(false);
  const [privDb, setPrivDb] = useState('');
  const [grants, setGrants] = useState<string[]>([]);
  const [privSel, setPrivSel] = useState<Set<string>>(new Set());
  const [attrs, setAttrs] = useState<PgRoleAttributes | null>(null);
  const [memberships, setMemberships] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [newRole, setNewRole] = useState('');

  const load = useCallback(async () => {
    if (!querySet) return;
    setLoading(true);
    setError(null);
    try {
      const res = await databaseClient[dialect].query({ connectionId, sql: querySet.list });
      const rs = res.resultSets?.[0];
      setUsers((rs?.rows ?? []).map((r) => r.map((v) => (v == null ? '' : String(v)))));
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, dialect, querySet]);

  useEffect(() => { void load(); }, [load]);

  // Batch role dropdown needs the grantable roles up front (pg only).
  useEffect(() => {
    if (dialect !== 'postgresql') return;
    databaseClient[dialect].query({ connectionId, sql: availableRolesQuery(dialect)! })
      .then((res) => setRoles((res.resultSets?.[0]?.rows ?? []).map((r) => String(r[0] ?? ''))))
      .catch(() => setRoles([]));
  }, [connectionId, dialect]);

  const exec = useCallback(async (sql: string, successMsg: string) => {
    try {
      await databaseClient[dialect].query({ connectionId, sql });
      toast.success(successMsg);
      await load();
    } catch (err) {
      toast.error(dbErrorMessage(err), t('db.users.execFailed'));
    }
  }, [connectionId, dialect, load, t]);

  const createUser = useCallback(async () => {
    const sql = buildCreateUserSql(dialect, newName, newPassword);
    if (!sql) return;
    setBusyUser('__create__');
    await exec(sql, t('db.users.created'));
    setCreating(false);
    setNewName('');
    setNewPassword('');
    setBusyUser(null);
  }, [dialect, newName, newPassword, exec, t]);

  const dropUser = useCallback(async (name: string, host: string) => {
    if (armedUser !== name) { setArmedUser(name); return; }
    setBusyUser(name);
    setArmedUser(null);
    await exec(buildDropUserSql(dialect, name, host), t('db.users.dropped'));
    setBusyUser(null);
  }, [dialect, armedUser, exec, t]);

  // mysql accounts are per-host: the selection key carries the host.
  const rowKey = useCallback((row: string[]): string =>
    dialect === 'mysql' ? `${row[0] ?? ''}|${row[1] ?? ''}` : row[0] ?? '', [dialect]);
  const allKeys = users.map(rowKey);
  const allSelected = users.length > 0 && allKeys.every((k) => selected.has(k));
  const toggleRowKey = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const toggleAllRows = () => setSelected(allSelected ? new Set() : new Set(allKeys));

  useEffect(() => { if (selected.size === 0) setBatchArmed(false); }, [selected]);

  /** Batch: sequential drop of every selected user/role (per-row error capture). */
  const batchDrop = useCallback(async () => {
    if (!batchArmed) { setBatchArmed(true); return; }
    setBatchArmed(false);
    if (!selected.size) return;
    setBatchBusy(true);
    let ok = 0;
    let failed = 0;
    for (const row of users) {
      if (!selected.has(rowKey(row))) continue;
      const name = row[0] ?? '';
      const host = row[1] ?? '';
      const sql = buildDropUserSql(dialect, name, host);
      if (!sql) { failed += 1; continue; }
      try {
        await databaseClient[dialect].query({ connectionId, sql });
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBatchBusy(false);
    setSelected(new Set());
    if (failed === 0) toast.success(t('db.users.batchDone', { ok, failed }));
    else toast.error(t('db.users.batchDone', { ok, failed }));
    await load();
  }, [batchArmed, selected, users, rowKey, dialect, connectionId, load, t]);

  /** Batch: grant/revoke one role to/from every selected pg role. */
  const batchRole = useCallback(async (mode: 'grant' | 'revoke') => {
    const role = batchRoleSel;
    if (!role || !selected.size) return;
    setBatchBusy(true);
    let ok = 0;
    let failed = 0;
    for (const row of users) {
      if (!selected.has(rowKey(row))) continue;
      const member = row[0] ?? '';
      const sql = mode === 'grant'
        ? buildGrantMembershipSql(dialect, role, member)
        : buildRevokeMembershipSql(dialect, role, member);
      if (!sql) { failed += 1; continue; }
      try {
        await databaseClient[dialect].query({ connectionId, sql });
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBatchBusy(false);
    setSelected(new Set());
    setBatchRoleSel('');
    if (failed === 0) toast.success(t('db.users.batchDone', { ok, failed }));
    else toast.error(t('db.users.batchDone', { ok, failed }));
    await load();
  }, [batchRoleSel, selected, users, rowKey, dialect, connectionId, load, t]);

  const openPrivs = useCallback(async (name: string, host: string) => {
    setPrivUser({ name, host });
    setPrivLoading(true);
    setPrivDb('');
    setGrants([]);
    setPrivSel(new Set());
    setAttrs(null);
    setMemberships([]);
    setRoles([]);
    setNewRole('');
    try {
      if (dialect === 'mysql') {
        const dbRes = await databaseClient[dialect].query({ connectionId, sql: 'SELECT DATABASE()' });
        const currentDb = String(dbRes.resultSets?.[0]?.rows?.[0]?.[0] ?? '');
        const gRes = await databaseClient[dialect].query({
          connectionId,
          sql: showGrantsSql(dialect, name, host)!,
        });
        const list = parseShowGrantsReply(gRes);
        setPrivDb(currentDb);
        setGrants(list);
        setPrivSel(new Set(privilegesOnDatabase(list, currentDb)));
      } else {
        const aRes = await databaseClient[dialect].query({ connectionId, sql: attributesQuery(dialect, name)! });
        const row = aRes.resultSets?.[0]?.rows?.[0] ?? [];
        setAttrs({
          login: flag(row[0]),
          superuser: flag(row[1]),
          createdb: flag(row[2]),
          createrole: flag(row[3]),
        });
        const mRes = await databaseClient[dialect].query({ connectionId, sql: membershipsQuery(dialect, name)! });
        setMemberships((mRes.resultSets?.[0]?.rows ?? []).map((r) => String(r[0] ?? '')));
        const rRes = await databaseClient[dialect].query({ connectionId, sql: availableRolesQuery(dialect)! });
        setRoles((rRes.resultSets?.[0]?.rows ?? []).map((r) => String(r[0] ?? '')));
      }
    } catch (err) {
      toast.error(dbErrorMessage(err), t('db.users.execFailed'));
      setPrivUser(null);
    } finally {
      setPrivLoading(false);
    }
  }, [connectionId, dialect, t]);

  /** mysql: diff the checkbox selection against SHOW GRANTS → GRANT/REVOKE. */
  const applyPrivs = useCallback(async () => {
    if (!privUser) return;
    const current = privilegesOnDatabase(grants, privDb);
    const normalize = (list: string[]) => (list.includes('ALL') ? ['ALL'] : list);
    const added = normalize([...privSel].filter((p) => !current.includes(p)));
    const removed = normalize(current.filter((p) => !privSel.has(p)));
    const stmts = [
      buildRevokePrivsSql(dialect, privUser.name, privUser.host, privDb, removed),
      buildGrantPrivsSql(dialect, privUser.name, privUser.host, privDb, added),
    ].filter(Boolean);
    if (!stmts.length) return;
    setPrivBusy(true);
    try {
      for (const sql of stmts) await databaseClient[dialect].query({ connectionId, sql });
      toast.success(t('db.users.privsUpdated'));
      await openPrivs(privUser.name, privUser.host);
    } catch (err) {
      toast.error(dbErrorMessage(err), t('db.users.execFailed'));
    } finally {
      setPrivBusy(false);
    }
  }, [privUser, grants, privDb, privSel, dialect, connectionId, openPrivs, t]);

  /** pg: ALTER ROLE with the full attribute set from the checkboxes. */
  const applyAttrs = useCallback(async () => {
    if (!privUser || !attrs) return;
    const sql = buildAlterRoleSql(dialect, privUser.name, attrs);
    if (!sql) return;
    setPrivBusy(true);
    try {
      await databaseClient[dialect].query({ connectionId, sql });
      toast.success(t('db.users.privsUpdated'));
      await openPrivs(privUser.name, privUser.host);
    } catch (err) {
      toast.error(dbErrorMessage(err), t('db.users.execFailed'));
    } finally {
      setPrivBusy(false);
    }
  }, [privUser, attrs, dialect, connectionId, openPrivs, t]);

  /** pg: grant/revoke one role membership, then reload the dialog. */
  const changeMembership = useCallback(async (role: string, mode: 'grant' | 'revoke') => {
    if (!privUser || !role) return;
    const sql = mode === 'grant'
      ? buildGrantMembershipSql(dialect, role, privUser.name)
      : buildRevokeMembershipSql(dialect, role, privUser.name);
    if (!sql) return;
    setPrivBusy(true);
    try {
      await databaseClient[dialect].query({ connectionId, sql });
      await openPrivs(privUser.name, privUser.host);
    } catch (err) {
      toast.error(dbErrorMessage(err), t('db.users.execFailed'));
    } finally {
      setPrivBusy(false);
    }
  }, [privUser, dialect, connectionId, openPrivs, t]);

  const togglePriv = (p: string) => {
    setPrivSel((prev) => {
      const next = new Set(prev);
      if (prev.has(p)) {
        next.delete(p);
      } else if (p === 'ALL') {
        return new Set(['ALL']);
      } else {
        next.delete('ALL');
        next.add(p);
      }
      return next;
    });
  };

  const cellCls = 'px-1.5 py-1 font-mono break-all align-top';

  if (!querySet) return null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <SqlPanelHeader titleKey="db.users.title" onClose={onClose} onRefresh={() => void load()} loading={loading}>
        <Button size="sm" className="h-7" onClick={() => setCreating((v) => !v)} title={t('db.users.create')}>
          <UserPlus size={12} className="mr-1" />{t('db.users.create')}
        </Button>
      </SqlPanelHeader>
      <div className="flex-1 min-h-0 overflow-auto p-2 text-xs">
        {error && <p className="text-destructive px-1 py-1">{error}</p>}
        {creating && (
          <div className="flex items-center gap-1.5 pb-2 flex-wrap">
            <Input className="h-7 w-44 font-mono" value={newName} placeholder={t('db.users.name')} autoComplete="off" spellCheck={false}
              onChange={(e) => setNewName(e.target.value)} />
            <Input className="h-7 w-40 font-mono" type="password" value={newPassword} placeholder={t('db.users.password')} autoComplete="new-password"
              onChange={(e) => setNewPassword(e.target.value)} />
            <Button size="sm" className="h-7" disabled={busyUser === '__create__' || !newName.trim()}
              onClick={() => void createUser()}>
              {t('db.users.create')}
            </Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setCreating(false)}>{t('common.cancel')}</Button>
          </div>
        )}
        {!loading && users.length === 0 && !error && (
          <p className="text-muted-foreground px-1 py-1">{t('common.noResultsFound')}</p>
        )}
        {selected.size > 0 && (
          <div className="flex items-center gap-1.5 pb-2 flex-wrap">
            <span className="text-muted-foreground">{t('db.users.selected', { n: selected.size })}</span>
            <Button variant="destructive" size="sm" className="h-7" disabled={batchBusy}
              onClick={() => void batchDrop()}>
              {batchArmed ? t('db.users.dropConfirm') : t('db.users.batchDrop')}
            </Button>
            {dialect === 'postgresql' && (
              <>
                <select className="h-7 rounded-md border border-input bg-background px-1.5 text-xs max-w-40"
                  value={batchRoleSel} onChange={(e) => setBatchRoleSel(e.target.value)}>
                  <option value="">{t('db.users.rolesPlaceholder')}</option>
                  {roles.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <Button variant="ghost" size="sm" className="h-7" disabled={batchBusy || !batchRoleSel}
                  onClick={() => void batchRole('grant')}>{t('db.users.addRole')}</Button>
                <Button variant="ghost" size="sm" className="h-7" disabled={batchBusy || !batchRoleSel}
                  onClick={() => void batchRole('revoke')}>{t('db.users.removeRole')}</Button>
              </>
            )}
          </div>
        )}
        {users.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-muted-foreground">
                <th className="px-1.5 py-0.5">
                  <input type="checkbox" checked={allSelected} onChange={toggleAllRows} />
                </th>
                {querySet.columns.map((c) => (
                  <th key={c.name} className="text-left font-normal px-1.5 py-0.5">{t(`db.users.col.${c.label}`)}</th>
                ))}
                <th className="px-1.5 py-0.5" />
              </tr>
            </thead>
            <tbody>
              {users.map((row, i) => {
                const name = row[0] ?? '';
                const key = rowKey(row);
                return (
                  <tr key={`${name}-${i}`} className="hover:bg-foreground/5 align-top">
                    <td className="px-1.5 py-1">
                      <input type="checkbox" checked={selected.has(key)} disabled={batchBusy}
                        onChange={() => toggleRowKey(key)} />
                    </td>
                    {row.map((cell, j) => (
                      <td key={j} className={cellCls}>{cell}</td>
                    ))}
                    <td className="px-1.5 py-1 whitespace-nowrap">
                      <button type="button"
                        className="px-1 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                        title={t('db.users.privs')}
                        onClick={() => void openPrivs(name, row[1] ?? '')}>
                        {t('db.users.privs')}
                      </button>
                      <button type="button"
                        className={`px-1 rounded text-[10px] disabled:opacity-40 ${armedUser === name ? 'bg-destructive text-destructive-foreground' : 'text-muted-foreground hover:text-destructive hover:bg-foreground/5'}`}
                        disabled={busyUser === name}
                        title={armedUser === name ? t('db.users.dropConfirm') : t('db.users.drop')}
                        onClick={() => void dropUser(name, row[1] ?? '')}>
                        {armedUser === name ? t('db.users.dropConfirm') : t('db.users.drop')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {privUser && (
        <Dialog open onOpenChange={(open) => { if (!open) setPrivUser(null); }}>
          <DialogContent className="max-w-[480px]">
            <DialogHeader>
              <DialogTitle className="truncate">{t('db.users.privsTitle', { name: privUser.name })}</DialogTitle>
            </DialogHeader>
            {privLoading ? (
              <p className="text-muted-foreground text-xs py-3">{t('db.users.privs')}…</p>
            ) : dialect === 'postgresql' && attrs ? (
              <div className="text-xs space-y-3">
                <div>
                  <p className="font-medium mb-1.5">{t('db.users.roleAttrs')}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {PG_ATTR_ITEMS.map(({ key, label }) => (
                      <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={attrs[key]} disabled={privBusy}
                          onChange={(e) => setAttrs({ ...attrs, [key]: e.target.checked })} />
                        {t(`db.users.attr.${label}`)}
                      </label>
                    ))}
                  </div>
                  <Button size="sm" className="h-7 mt-2" disabled={privBusy} onClick={() => void applyAttrs()}>
                    {t('db.users.applyPrivs')}
                  </Button>
                </div>
                <div>
                  <p className="font-medium mb-1.5">{t('db.users.memberOf')}</p>
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {memberships.length === 0 && <span className="text-muted-foreground">—</span>}
                    {memberships.map((r) => (
                      <span key={r} className="inline-flex items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 font-mono">
                        {r}
                        <button type="button" disabled={privBusy}
                          className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                          title={t('db.users.removeRole')}
                          onClick={() => void changeMembership(r, 'revoke')}>×</button>
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select className="h-7 rounded-md border border-input bg-background px-1.5 text-xs max-w-44"
                      value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                      <option value="">{t('db.users.rolesPlaceholder')}</option>
                      {roles.filter((r) => !memberships.includes(r)).map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                    <Button size="sm" className="h-7" disabled={!newRole || privBusy}
                      onClick={() => void changeMembership(newRole, 'grant')}>
                      {t('db.users.addRole')}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs space-y-3">
                <div>
                  <p className="font-medium mb-1.5">{t('db.users.commonPrivs')}</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {['ALL', ...MYSQL_COMMON_PRIVS].map((p) => (
                      <label key={p} className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={privSel.has(p)} disabled={privBusy}
                          onChange={() => togglePriv(p)} />
                        {p === 'ALL' ? t('db.users.privAll') : p}
                      </label>
                    ))}
                  </div>
                  <Button size="sm" className="h-7 mt-2" disabled={privBusy} onClick={() => void applyPrivs()}>
                    {t('db.users.applyPrivs')}
                  </Button>
                </div>
                <div>
                  <p className="font-medium mb-1.5">{t('db.users.grants')}</p>
                  <pre className="max-h-32 overflow-auto rounded bg-foreground/5 p-1.5 font-mono text-[10px] whitespace-pre-wrap">
                    {grants.join('\n') || '—'}
                  </pre>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};

export default SqlUsersPanel;
