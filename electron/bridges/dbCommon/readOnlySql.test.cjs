const test = require("node:test");
const assert = require("node:assert/strict");
const { splitSqlStatements, validateReadOnlySql, readOnlyTransaction } = require("./readOnlySql.cjs");

test("splitSqlStatements handles multi-statement input", () => {
  assert.deepEqual(splitSqlStatements("SELECT 1; SELECT 2;", "mysql"), ["SELECT 1", "SELECT 2"]);
  assert.deepEqual(splitSqlStatements("SELECT 1", "mysql"), ["SELECT 1"]);
  assert.deepEqual(splitSqlStatements("  ;;  ", "mysql"), []);
});

test("splitSqlStatements keeps quotes/comments intact", () => {
  // a `;` inside a -- line comment does NOT separate statements (no newline)
  assert.deepEqual(splitSqlStatements("SELECT ';' -- comment; SELECT 2", "mysql"), ["SELECT ';' -- comment; SELECT 2"]);
  assert.deepEqual(splitSqlStatements("SELECT 1 -- trailing comment\n; SELECT 2", "mysql"), ["SELECT 1 -- trailing comment", "SELECT 2"]);
  assert.deepEqual(splitSqlStatements("SELECT /* a;b */ 1", "mysql"), ["SELECT /* a;b */ 1"]);
  assert.deepEqual(splitSqlStatements("SELECT 'it''s'", "mysql"), ["SELECT 'it''s'"]);
  assert.deepEqual(splitSqlStatements("SELECT 'x\\''", "mysql"), ["SELECT 'x\\''"]);
  // pg: backslash is literal inside standard strings, so the quote still closes
  assert.deepEqual(splitSqlStatements("SELECT 'x\\'", "postgresql"), ["SELECT 'x\\'"]);
  assert.deepEqual(splitSqlStatements('SELECT "col;name" FROM t', "postgresql"), ['SELECT "col;name" FROM t']);
  assert.deepEqual(splitSqlStatements("SELECT `weird;name` FROM t", "mysql"), ["SELECT `weird;name` FROM t"]);
});

test("splitSqlStatements handles pg dollar-quoted bodies with semicolons", () => {
  assert.deepEqual(splitSqlStatements("SELECT * FROM t WHERE body = $$a;b$$", "postgresql"), ["SELECT * FROM t WHERE body = $$a;b$$"]);
  assert.deepEqual(splitSqlStatements("SELECT $tag$;func();$tag$::text", "postgresql"), ["SELECT $tag$;func();$tag$::text"]);
});

test("validateReadOnlySql allows read-only keywords per dialect", () => {
  assert.equal(validateReadOnlySql("mysql", "SELECT 1").ok, true);
  assert.equal(validateReadOnlySql("mysql", "/* c */ WITH x AS (SELECT 1) SELECT * FROM x").ok, true);
  assert.equal(validateReadOnlySql("mysql", "EXPLAIN SELECT 1").ok, true);
  assert.equal(validateReadOnlySql("mysql", "SHOW TABLES").ok, true);
  assert.equal(validateReadOnlySql("mysql", "DESCRIBE t").ok, true);
  assert.equal(validateReadOnlySql("mysql", "DESC t").ok, true);
  assert.equal(validateReadOnlySql("postgresql", "TABLE users").ok, true);
  assert.equal(validateReadOnlySql("postgresql", "VALUES (1),(2)").ok, true);
  assert.equal(validateReadOnlySql("postgresql", "SHOW search_path").ok, true);
});

test("validateReadOnlySql rejects writes", () => {
  for (const bad of [
    "INSERT INTO t VALUES (1)", "UPDATE t SET a=1", "DELETE FROM t", "DROP TABLE t",
    "ALTER TABLE t DROP COLUMN a", "CREATE TABLE t(a int)", "TRUNCATE t",
    "GRANT ALL ON *.* TO x", "REVOKE x", "SET @a=1", "SET search_path = public",
    "START TRANSACTION", "BEGIN", "COMMIT", "ROLLBACK", "CALL p()", "LOCK TABLES t",
    "MERGE INTO t", "COPY t FROM stdin", "VACUUM", "SELECT 1; DELETE FROM t",
    "-- comment\nINSERT INTO t VALUES (1)", "/* c */ UPDATE t SET a=1",
  ]) {
    const result = validateReadOnlySql("mysql", bad);
    assert.equal(result.ok, false, bad);
    assert.equal(result.code, "READ_ONLY_VIOLATION", bad);
  }
  // CTE-writes are rejected at the keyword gate only when the leading keyword
  // is a write; WITH…DELETE keeps "with" as the leading keyword and is left to
  // the READ ONLY transaction (authoritative layer) to block.
  assert.equal(validateReadOnlySql("postgresql", "WITH x AS (SELECT 1) DELETE FROM t USING x").ok, true);
});

test("validateReadOnlySql rejects unknown dialect and empty input", () => {
  assert.equal(validateReadOnlySql("redis", "SELECT 1").code, "INVALID_PARAMS");
  assert.equal(validateReadOnlySql("mysql", "   ").code, "INVALID_PARAMS");
  assert.equal(validateReadOnlySql("mysql", "").code, "INVALID_PARAMS");
});

// EXPLAIN ANALYZE DELETE passes the keyword gate by design — the authoritative
// block is the READ ONLY transaction wrapper applied by databaseService
// (pg: BEGIN READ ONLY; mysql: START TRANSACTION READ ONLY).
test("readOnlyTransaction scripts block writes at the engine level", () => {
  assert.deepEqual(readOnlyTransaction("mysql"), { begin: "START TRANSACTION READ ONLY", end: "ROLLBACK" });
  assert.deepEqual(readOnlyTransaction("postgresql"), { begin: "BEGIN READ ONLY", end: "ROLLBACK" });
});
