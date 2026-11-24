/**
 * User management v1 (pg/mysql): list users/roles, create and drop through
 * generated statements executed on the existing query channel. mssql/sqlite
 * are not covered in v1 (server-principal semantics differ; sqlite has none).
 */
import type { SqlEngineId } from '../../domain/models/dbEngines';
import { quoteIdent } from './sqlIdent';
import { sqlLiteral } from './csv';

export interface UsersQuerySet {
  list: string;
  columns: { name: string; label: string }[];
}

const QUERY_SETS: Partial<Record<SqlEngineId, UsersQuerySet>> = {
  postgresql: {
    // Single LIKE escape ('pg\_%'): a double backslash matches a literal
    // backslash, never hits, and leaks reserved pg_* roles into the list.
    list: "SELECT rolname AS name, CASE WHEN rolcanlogin THEN 'yes' ELSE 'no' END AS can_login, CASE WHEN rolsuper THEN 'yes' ELSE 'no' END AS super FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname",
    columns: [
      { name: 'name', label: 'user' },
      { name: 'can_login', label: 'login' },
      { name: 'super', label: 'super' },
    ],
  },
  mysql: {
    list: 'SELECT user AS name, host AS host FROM mysql.user ORDER BY user, host',
    columns: [
      { name: 'name', label: 'user' },
      { name: 'host', label: 'host' },
    ],
  },
};

export const usersQuery = (dialect: SqlEngineId): UsersQuerySet | null => QUERY_SETS[dialect] ?? null;

/** mysql users are `'name'@'%'` literals; elsewhere the engine's identifier quoting. */
const quoteUser = (dialect: SqlEngineId, name: string): string =>
  dialect === 'mysql' ? `'${name}'@'%'` : quoteIdent(dialect, name);

/** CREATE USER / ROLE statement for the dialect. */
export const buildCreateUserSql = (dialect: SqlEngineId, name: string, password: string): string => {
  const safe = name.replace(/["'`]/g, '').trim();
  if (!safe) return '';
  const pass = sqlLiteral(password);
  if (dialect === 'mysql') return `CREATE USER '${safe}'@'%' IDENTIFIED BY ${pass}`;
  return `CREATE ROLE ${quoteIdent(dialect, safe)} LOGIN PASSWORD ${pass}`;
};

/** DROP USER / ROLE statement for the dialect. */
export const buildDropUserSql = (dialect: SqlEngineId, name: string, host = ''): string => {
  const safe = name.replace(/["'`]/g, '').trim();
  if (!safe) return '';
  if (dialect === 'mysql') {
    // mysql accounts are per-host: honor the row's host (default '%').
    const safeHost = (host.replace(/["'`]/g, '') || '%');
    return `DROP USER '${safe}'@'${safeHost}'`;
  }
  return `DROP ROLE ${quoteIdent(dialect, safe)}`;
};

// ---------- v2: privilege viewing / editing ----------

/** Common MySQL privileges managed on the current database. */
export const MYSQL_COMMON_PRIVS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES',
] as const;

const PRIV_NAME_OK = /^[A-Z_ ]+$/;

/** mysql users are `'name'@'host'` literals (host may differ per account row). */
const quoteUserHost = (name: string, host: string): string =>
  `'${name.replace(/["'`]/g, '')}'@'${host.replace(/["'`]/g, '') || '%'}'`;

/** Extract grant statements from a SHOW GRANTS reply (first column per row). */
export const parseShowGrantsReply = (reply: unknown): string[] => {
  const rows = (reply as { resultSets?: { rows?: unknown[][] }[] } | null)?.resultSets?.[0]?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => String(Array.isArray(r) ? r[0] ?? '' : r)).filter(Boolean);
};

/** SHOW GRANTS statement for one MySQL account. */
export const showGrantsSql = (dialect: SqlEngineId, name: string, host: string): string | null =>
  dialect === 'mysql' ? `SHOW GRANTS FOR ${quoteUserHost(name, host)}` : null;

/** Privileges a set of grant statements grants on one database (`db`.*). */
export const privilegesOnDatabase = (grants: string[], database: string): string[] => {
  const out: string[] = [];
  for (const g of grants) {
    const m = /\bGRANT\s+(.+?)\s+ON\s+(.+?)\.\*/i.exec(g);
    if (!m) continue;
    const target = m[2].replace(/`/g, '').trim();
    if (target !== database) continue;
    const list = m[1].replace(/\s+WITH\s+GRANT\s+OPTION\s*$/i, '').trim();
    if (/^ALL(\s+PRIVILEGES)?$/i.test(list)) {
      if (!out.includes('ALL')) out.push('ALL');
      continue;
    }
    for (const p of list.split(',')) {
      const name = p.trim().toUpperCase();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
};

/** GRANT privilege list on a database for a MySQL user (invalid priv names refuse to build). */
export const buildGrantPrivsSql = (dialect: SqlEngineId, name: string, host: string, database: string, privs: string[]): string => {
  if (dialect !== 'mysql' || !database.trim()) return '';
  const list = privs.filter((p) => PRIV_NAME_OK.test(p));
  if (!list.length) return '';
  const safeDb = database.replace(/["'`]/g, '');
  return `GRANT ${list.join(', ')} ON \`${safeDb}\`.* TO ${quoteUserHost(name, host)}`;
};

/** REVOKE privilege list on a database for a MySQL user. */
export const buildRevokePrivsSql = (dialect: SqlEngineId, name: string, host: string, database: string, privs: string[]): string => {
  if (dialect !== 'mysql' || !database.trim()) return '';
  const list = privs.filter((p) => PRIV_NAME_OK.test(p));
  if (!list.length) return '';
  const safeDb = database.replace(/["'`]/g, '');
  return `REVOKE ${list.join(', ')} ON \`${safeDb}\`.* FROM ${quoteUserHost(name, host)}`;
};

// ---------- pg role attributes + membership ----------

export interface PgRoleAttributes {
  login: boolean;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
}

const PG_ATTRS: { key: keyof PgRoleAttributes; name: string }[] = [
  { key: 'login', name: 'LOGIN' },
  { key: 'superuser', name: 'SUPERUSER' },
  { key: 'createdb', name: 'CREATEDB' },
  { key: 'createrole', name: 'CREATEROLE' },
];

/** ALTER ROLE emitting the full attribute set (true → X, false → NOX). */
export const buildAlterRoleSql = (dialect: SqlEngineId, name: string, attrs: PgRoleAttributes): string => {
  if (dialect !== 'postgresql') return '';
  const safe = name.replace(/["'`]/g, '').trim();
  if (!safe) return '';
  const parts = PG_ATTRS.map(({ key, name: attr }) => (attrs[key] ? attr : `NO${attr}`));
  return `ALTER ROLE ${quoteIdent(dialect, safe)} WITH ${parts.join(' ')}`;
};

/** Current role attribute flags for one pg role. */
export const attributesQuery = (dialect: SqlEngineId, name: string): string | null => {
  if (dialect !== 'postgresql') return null;
  const safe = name.replace(/["'`]/g, '').trim();
  return `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = '${safe}'`;
};

/** Roles one pg role is a member of (pg_auth_members). */
export const membershipsQuery = (dialect: SqlEngineId, name: string): string | null => {
  if (dialect !== 'postgresql') return null;
  const safe = name.replace(/["'`]/g, '').trim();
  return `SELECT r.rolname AS role FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member WHERE m.rolname = '${safe}' ORDER BY r.rolname`;
};

/** Grantable roles (non-system) for the membership picker. */
export const availableRolesQuery = (dialect: SqlEngineId): string | null =>
  dialect === 'postgresql'
    ? "SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname"
    : null;

/** GRANT role TO member (pg role membership). */
export const buildGrantMembershipSql = (dialect: SqlEngineId, role: string, member: string): string => {
  if (dialect !== 'postgresql') return '';
  const r = role.replace(/["'`]/g, '').trim();
  const m = member.replace(/["'`]/g, '').trim();
  if (!r || !m) return '';
  return `GRANT ${quoteIdent(dialect, r)} TO ${quoteIdent(dialect, m)}`;
};

/** REVOKE role FROM member (pg role membership). */
export const buildRevokeMembershipSql = (dialect: SqlEngineId, role: string, member: string): string => {
  if (dialect !== 'postgresql') return '';
  const r = role.replace(/["'`]/g, '').trim();
  const m = member.replace(/["'`]/g, '').trim();
  if (!r || !m) return '';
  return `REVOKE ${quoteIdent(dialect, r)} FROM ${quoteIdent(dialect, m)}`;
};
