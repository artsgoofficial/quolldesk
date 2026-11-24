import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
  parseShowGrantsReply,
  privilegesOnDatabase,
  showGrantsSql,
  usersQuery,
} from './sqlUsers';

test('users list queries exist for pg/mysql only', () => {
  const pg = usersQuery('postgresql')!;
  assert.match(pg.list, /pg_roles/);
  // Reserved pg_* roles must be excluded with a single LIKE escape ('pg\_%').
  // A double backslash matches a literal backslash, never hits, and leaks
  // system roles like pg_use_reserved_connections into the list.
  assert.ok(pg.list.includes("NOT LIKE 'pg\\_%'"), pg.list);
  assert.ok(!pg.list.includes('pg\\\\_%'));
  assert.match(usersQuery('mysql')!.list, /mysql\.user/);
  assert.equal(usersQuery('mssql'), null);
  assert.equal(usersQuery('sqlite'), null);
});

test('create user statements quote and strip dangerous chars', () => {
  assert.equal(buildCreateUserSql('postgresql', 'app_user', "p'a'ss"), 'CREATE ROLE "app_user" LOGIN PASSWORD \'p\'\'a\'\'ss\'');
  assert.equal(buildCreateUserSql('mysql', 'app_user', 'p1'), "CREATE USER 'app_user'@'%' IDENTIFIED BY 'p1'");
  // Injection-ish names lose their quotes so they cannot escape the
  // identifier — the dangerous text stays inside the quoted name.
  assert.equal(buildCreateUserSql('postgresql', 'x"; DROP SCHEMA s; --', 'p'),
    'CREATE ROLE "x; DROP SCHEMA s; --" LOGIN PASSWORD \'p\'');
  assert.equal(buildCreateUserSql('postgresql', '   ', 'p'), '');
});

test('drop user statements per dialect', () => {
  assert.equal(buildDropUserSql('postgresql', 'legacy'), 'DROP ROLE "legacy"');
  assert.equal(buildDropUserSql('mysql', 'legacy'), "DROP USER 'legacy'@'%'");
  assert.equal(buildDropUserSql('postgresql', ''), '');
  // mysql accounts are per-host: the drop must honor the row's host.
  assert.equal(buildDropUserSql('mysql', 'legacy', '10.0.0.5'), "DROP USER 'legacy'@'10.0.0.5'");
});

test('SqlUsersPanel wires list/create/drop through the query channel', () => {
  const panel = readFileSync(new URL('./SqlUsersPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /usersQuery\(dialect\)/);
  assert.match(panel, /buildCreateUserSql\(dialect, newName, newPassword\)/);
  assert.match(panel, /armedUser/);
  assert.match(panel, /db\.users\.title/);
  // v2: privileges dialog wiring (pg attrs+memberships / mysql grant diffing)
  assert.match(panel, /openPrivs/);
  assert.match(panel, /privilegesOnDatabase/);
  assert.match(panel, /buildAlterRoleSql/);
  assert.match(panel, /buildGrantMembershipSql/);
  assert.match(panel, /showGrantsSql\(dialect/);
  assert.match(panel, /db\.users\.privsTitle/);
  // batch operations: row selection + batch drop + pg batch role grant
  assert.match(panel, /db\.users\.selected/);
  assert.match(panel, /db\.users\.batchDrop/);
  assert.match(panel, /db\.users\.batchDone/);
  assert.match(panel, /buildDropUserSql\(dialect, name, host\)/);
  const workbench = readFileSync(new URL('./DatabaseWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(workbench, /SqlUsersPanel/);
  assert.match(workbench, /'users'/);
});

test('mysql grants: parse reply and derive per-database privileges', () => {
  const grants = parseShowGrantsReply({
    resultSets: [{
      columns: ['Grants for u@%'],
      rows: [
        ["GRANT SELECT, INSERT ON *.* TO 'u'@'%'"],
        ["GRANT UPDATE, DELETE ON `shop`.* TO 'u'@'%' WITH GRANT OPTION"],
        ["GRANT ALL PRIVILEGES ON `app`.* TO 'u'@'%'"],
      ],
    }],
  });
  assert.deepEqual(grants, [
    "GRANT SELECT, INSERT ON *.* TO 'u'@'%'",
    "GRANT UPDATE, DELETE ON `shop`.* TO 'u'@'%' WITH GRANT OPTION",
    "GRANT ALL PRIVILEGES ON `app`.* TO 'u'@'%'",
  ]);
  assert.deepEqual(privilegesOnDatabase(grants, 'shop'), ['UPDATE', 'DELETE']);
  assert.deepEqual(privilegesOnDatabase(grants, 'app'), ['ALL']);
  assert.deepEqual(privilegesOnDatabase(grants, 'other'), []);
  assert.deepEqual(privilegesOnDatabase([], 'shop'), []);
});

test('SHOW GRANTS statement per dialect', () => {
  assert.equal(showGrantsSql('mysql', 'app_user', '10.0.0.5'), "SHOW GRANTS FOR 'app_user'@'10.0.0.5'");
  assert.equal(showGrantsSql('mysql', 'app_user', ''), "SHOW GRANTS FOR 'app_user'@'%'");
  assert.equal(showGrantsSql('postgresql', 'u', ''), null);
});

test('grant/revoke privilege statements quote and sanitize (mysql)', () => {
  assert.equal(
    buildGrantPrivsSql('mysql', 'app_user', '%', 'shop', ['SELECT', 'CREATE VIEW']),
    "GRANT SELECT, CREATE VIEW ON `shop`.* TO 'app_user'@'%'",
  );
  assert.equal(
    buildRevokePrivsSql('mysql', 'app_user', '%', 'shop', ['SELECT']),
    "REVOKE SELECT ON `shop`.* FROM 'app_user'@'%'",
  );
  // Privilege names are restricted to identifier charset — anything else
  // makes the statement refuse to build.
  assert.equal(buildGrantPrivsSql('mysql', 'app_user', '%', 'shop', ['SEL;DROP']), '');
  assert.equal(buildGrantPrivsSql('mysql', 'app_user', '%', '', ['SELECT']), '');
  assert.equal(buildGrantPrivsSql('postgresql', 'u', '', 'db', ['SELECT']), '');
});

test('pg role attributes: ALTER ROLE emits the full attribute set', () => {
  assert.equal(
    buildAlterRoleSql('postgresql', 'app_user', { login: true, superuser: false, createdb: true, createrole: false }),
    'ALTER ROLE "app_user" WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE',
  );
  assert.equal(
    buildAlterRoleSql('postgresql', 'x"; DROP SCHEMA s; --', { login: true, superuser: true, createdb: false, createrole: false }),
    'ALTER ROLE "x; DROP SCHEMA s; --" WITH LOGIN SUPERUSER NOCREATEDB NOCREATEROLE',
  );
  assert.equal(
    attributesQuery('postgresql', 'app_user'),
    "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'app_user'",
  );
  assert.equal(attributesQuery('mysql', 'u'), null);
});

test('pg role membership: queries and grant/revoke statements', () => {
  assert.match(membershipsQuery('postgresql', 'app_user')!, /pg_auth_members/);
  assert.match(membershipsQuery('postgresql', 'app_user')!, /m\.rolname = 'app_user'/);
  assert.equal(membershipsQuery('mysql', 'u'), null);
  const avail = availableRolesQuery('postgresql')!;
  assert.match(avail, /pg_roles/);
  assert.ok(avail.includes("NOT LIKE 'pg\\_%'"), avail);
  assert.ok(!avail.includes('pg\\\\_%'));
  assert.equal(availableRolesQuery('mysql'), null);
  assert.equal(buildGrantMembershipSql('postgresql', 'readers', 'app_user'), 'GRANT "readers" TO "app_user"');
  assert.equal(buildRevokeMembershipSql('postgresql', 'readers', 'app_user'), 'REVOKE "readers" FROM "app_user"');
  assert.equal(buildGrantMembershipSql('postgresql', '', 'app_user'), '');
});
