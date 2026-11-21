const test = require("node:test");
const assert = require("node:assert/strict");
const { splitSqlStatements, sqlLiteral, buildInsertStatements } = require("./sqlDump.cjs");

test("sqlLiteral preserves pg-parsed json objects and arrays", () => {
  const { sqlLiteral } = require("./sqlDump.cjs");
  assert.equal(sqlLiteral({ a: 1, b: "x\"y" }), `'{"a":1,"b":"x\\"y"}'`);
  assert.equal(sqlLiteral(["a", "b"]), `'["a","b"]'`);
  assert.equal(sqlLiteral({ nested: { deep: true } }), `'{"nested":{"deep":true}}'`);
});

test("splitSqlStatements respects strings, comments and semicolons", () => {
  // `;` inside a single-quoted string does not split.
  assert.deepEqual(
    splitSqlStatements("INSERT INTO t VALUES ('a;b');"),
    ["INSERT INTO t VALUES ('a;b')"],
  );
  // Doubled quotes stay inside the literal; the statement ends at the real one.
  assert.deepEqual(
    splitSqlStatements("INSERT INTO t VALUES ('it''s');"),
    ["INSERT INTO t VALUES ('it''s')"],
  );
  // Line comments and block comments are dropped; comment-only input → [].
  assert.deepEqual(splitSqlStatements("-- header\nSELECT 1;\n/* block\ncomment */ UPDATE t SET x=1;"), [
    "SELECT 1",
    "UPDATE t SET x=1",
  ]);
  assert.deepEqual(splitSqlStatements("-- only\n\n  ;\n/* comments */"), []);
  // Double-quoted identifiers with "" doubling survive a `;` inside quotes.
  assert.deepEqual(splitSqlStatements('CREATE TABLE "a""b" ("x" int);'), ['CREATE TABLE "a""b" ("x" int)']);
  // Empty input → [].
  assert.deepEqual(splitSqlStatements(""), []);
});

test("splitSqlStatements backslash handling follows the dialect flag", () => {
  // MySQL: \' is an escaped quote — the literal continues past it, so the
  // `;` after it does NOT terminate the statement.
  assert.deepEqual(
    splitSqlStatements("INSERT INTO t VALUES ('a\\'b; c');", { backslashEscapes: true }),
    ["INSERT INTO t VALUES ('a\\'b; c')"],
  );
  // pg (standard_conforming_strings): backslashes are plain characters — the
  // first unescaped ' closes the literal, so `);` terminates the statement
  // right after the backslash and the rest splits off as its own statement.
  const pg = splitSqlStatements("INSERT INTO t VALUES ('a\\'); SELECT 1;", { backslashEscapes: false });
  assert.deepEqual(pg, ["INSERT INTO t VALUES ('a\\')", "SELECT 1"]);
  // The same text under MySQL semantics keeps `; SELECT 1;` inside the
  // literal; the file simply ends with an unterminated string (its trailing
  // `;` was inside the string, so the whole remainder stays one statement).
  assert.deepEqual(
    splitSqlStatements("INSERT INTO t VALUES ('a\\'); SELECT 1;", { backslashEscapes: true }),
    ["INSERT INTO t VALUES ('a\\'); SELECT 1;"],
  );
  // A pg string ending in a backslash stays intact (no phantom escape).
  assert.deepEqual(
    splitSqlStatements("INSERT INTO t VALUES ('c:\\path\\');", { backslashEscapes: false }),
    ["INSERT INTO t VALUES ('c:\\path\\')"],
  );
});

test("sqlLiteral escapes per dialect and renders typed values", () => {
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(undefined), "NULL");
  assert.equal(sqlLiteral(5), "5");
  assert.equal(sqlLiteral(-1.5), "-1.5");
  assert.equal(sqlLiteral(true), "TRUE");
  assert.equal(sqlLiteral(false), "FALSE");
  // Quotes always double; backslash doubles only for MySQL.
  assert.equal(sqlLiteral("it's", { escapeBackslash: true }), "'it''s'");
  assert.equal(sqlLiteral("a\\b'c", { escapeBackslash: true }), "'a\\\\b''c'");
  assert.equal(sqlLiteral("a\\b", { escapeBackslash: false }), "'a\\b'");
  // Dates render local 'YYYY-MM-DD HH:MM:SS'.
  assert.equal(sqlLiteral(new Date(2026, 0, 2, 3, 4, 5)), "'2026-01-02 03:04:05'");
  // Buffers: hex literal for MySQL, bytea hex input for pg.
  assert.equal(sqlLiteral(Buffer.from("AB", "utf8"), { escapeBackslash: true }), "X'4142'");
  assert.equal(sqlLiteral(Buffer.from("AB", "utf8"), { escapeBackslash: false }), "'\\x4142'::bytea");
  // Non-finite numbers degrade to their string form (documented).
  assert.equal(sqlLiteral(NaN), "'NaN'");
});

test("buildInsertStatements batches rows and honours the batch size", () => {
  const quote = (id) => `\`${id}\``;
  const literal = (v) => sqlLiteral(v, { escapeBackslash: true });
  const rows = [[1, "x"], [2, "y'z"], [3, null]];
  const statements = buildInsertStatements({ tableRef: "`db`.`t`", quote, columns: ["a", "b"], rows, literal, batchSize: 2 });
  assert.equal(statements.length, 2);
  assert.equal(statements[0], "INSERT INTO `db`.`t` (`a`, `b`) VALUES\n  (1, 'x'),\n  (2, 'y''z');");
  assert.equal(statements[1], "INSERT INTO `db`.`t` (`a`, `b`) VALUES\n  (3, NULL);");
  assert.deepEqual(buildInsertStatements({ tableRef: "t", quote, columns: ["a"], rows: [], literal }), []);
  assert.deepEqual(buildInsertStatements({ tableRef: "t", quote, columns: [], rows: [[1]], literal }), []);
});
