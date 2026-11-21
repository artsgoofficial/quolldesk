import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitSqlStatements } from './splitSqlStatements';

test('splits two statements on a top-level semicolon', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT 1; SELECT 2', 'mysql'),
    ['SELECT 1', 'SELECT 2'],
  );
});

test('does not split on a semicolon inside a single-quoted string', () => {
  assert.deepEqual(
    splitSqlStatements("SELECT 'a;b' AS v; SELECT 2", 'mysql'),
    ["SELECT 'a;b' AS v", 'SELECT 2'],
  );
});

test('doubled quote escape keeps one string literal', () => {
  assert.deepEqual(
    splitSqlStatements("SELECT 'it''s;fine'; SELECT 3", 'postgresql'),
    ["SELECT 'it''s;fine'", 'SELECT 3'],
  );
});

test('backslash escape keeps one string literal', () => {
  assert.deepEqual(
    splitSqlStatements("SELECT 'a\\';b'; SELECT 4", 'mysql'),
    ["SELECT 'a\\';b'", 'SELECT 4'],
  );
});

test('backtick identifier with semicolon stays one statement', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT `a;b` FROM t; SELECT 5', 'mysql'),
    ['SELECT `a;b` FROM t', 'SELECT 5'],
  );
});

test('double-quoted identifier with semicolon stays one statement', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT "col;name" FROM t; SELECT 6', 'postgresql'),
    ['SELECT "col;name" FROM t', 'SELECT 6'],
  );
});

test('line comment semicolons are ignored', () => {
  assert.deepEqual(
    splitSqlStatements('-- a; comment\nSELECT 7; SELECT 8', 'mysql'),
    ['-- a; comment\nSELECT 7', 'SELECT 8'],
  );
});

test('mysql hash comment swallows semicolons until newline', () => {
  // Statements are verbatim source slices: a trailing comment stays on its
  // statement, same as the leading-comment cases below.
  assert.deepEqual(
    splitSqlStatements('SELECT 9 # note; here\n; SELECT 10', 'mysql'),
    ['SELECT 9 # note; here', 'SELECT 10'],
  );
});

test('comment-only segment between statements is dropped', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT 1; -- just a note\n; SELECT 2', 'mysql'),
    ['SELECT 1', 'SELECT 2'],
  );
  assert.deepEqual(
    splitSqlStatements('SELECT 1; /* note */ ; SELECT 2', 'postgresql'),
    ['SELECT 1', 'SELECT 2'],
  );
});

test('block comment semicolons are ignored', () => {
  assert.deepEqual(
    splitSqlStatements('/* a;b */ SELECT 11; SELECT 12', 'postgresql'),
    ['/* a;b */ SELECT 11', 'SELECT 12'],
  );
});

test('pg dollar-quoted string with semicolon stays one statement', () => {
  assert.deepEqual(
    splitSqlStatements("SELECT $$a;b$$ AS v; SELECT 13", 'postgresql'),
    ["SELECT $$a;b$$ AS v", 'SELECT 13'],
  );
});

test('pg tagged dollar-quote with semicolon stays one statement', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT $fn$a;b$fn$ AS v; SELECT 14', 'postgresql'),
    ['SELECT $fn$a;b$fn$ AS v', 'SELECT 14'],
  );
});

test('pg #> operator is not treated as a comment', () => {
  assert.deepEqual(
    splitSqlStatements("SELECT data #> '{}' FROM t; SELECT 15", 'postgresql'),
    ["SELECT data #> '{}' FROM t", 'SELECT 15'],
  );
});

test('drops empty and whitespace-only statements', () => {
  assert.deepEqual(splitSqlStatements(';;;   \n;  SELECT 16 ;;', 'mysql'), ['SELECT 16']);
  assert.deepEqual(splitSqlStatements('   \n\t ', 'mysql'), []);
});

test('keeps internal newlines of a statement intact', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT 17,\n       18; SELECT 19', 'mysql'),
    ['SELECT 17,\n       18', 'SELECT 19'],
  );
});

test('single statement without trailing semicolon is returned whole', () => {
  assert.deepEqual(splitSqlStatements('  SELECT 20  ', 'postgresql'), ['SELECT 20']);
});

// ——— mariadb shares the mysql lexer (hash comments, backslash escapes) ———

test('mariadb hash comment swallows semicolons until newline', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT 9 # note; here\n; SELECT 10', 'mariadb'),
    ['SELECT 9 # note; here', 'SELECT 10'],
  );
});

test('mariadb backslash escape keeps one string literal', () => {
  assert.deepEqual(
    splitSqlStatements("SELECT 'a\\';b'; SELECT 4", 'mariadb'),
    ["SELECT 'a\\';b'", 'SELECT 4'],
  );
});

// ——— mssql: bracketed identifiers never produce a split ———

test('bracketed identifier with semicolon stays one statement', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT [a;b] FROM t; SELECT 21', 'mssql'),
    ['SELECT [a;b] FROM t', 'SELECT 21'],
  );
});

test('doubled closing bracket escape keeps one bracketed identifier', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT [weird]]name;ok] FROM t; SELECT 22', 'mssql'),
    ['SELECT [weird]]name;ok] FROM t', 'SELECT 22'],
  );
});

test('mssql # is not a line comment', () => {
  assert.deepEqual(
    splitSqlStatements('SELECT 23 # note; SELECT 24', 'mssql'),
    ['SELECT 23 # note', 'SELECT 24'],
  );
});

test('sqlite does not treat # as a comment or split dollar quotes', () => {
  // No mysql-family hash comments off the mysql family...
  assert.deepEqual(
    splitSqlStatements('SELECT 25 # note; SELECT 26', 'sqlite'),
    ['SELECT 25 # note', 'SELECT 26'],
  );
  // ...and no pg dollar-quoting outside postgresql: an untagged $pair does not
  // guard a semicolon ($$ only ever opens a dollar-quote on pg).
  assert.deepEqual(
    splitSqlStatements("SELECT $$a;b$$ AS v; SELECT 27", 'sqlite'),
    ["SELECT $$a", "b$$ AS v", 'SELECT 27'],
  );
});

test('pg dollar-quote stays postgresql-only', () => {
  // mysql splits inside $$...$$ (it has no dollar quoting).
  assert.deepEqual(
    splitSqlStatements("SELECT $$a;b$$ AS v; SELECT 13", 'mysql'),
    ['SELECT $$a', "b$$ AS v", 'SELECT 13'],
  );
});
