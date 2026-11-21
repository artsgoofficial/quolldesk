const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGridWhere, MAX_GRID_FILTERS } = require("./gridWhere.cjs");

const mysqlCtx = { quote: (id) => `\`${id}\``, placeholder: () => "?" };
const pgCtx = { quote: (id) => `"${id}"`, placeholder: (n) => `$${n}` };

test("no filters yields an empty where and values", () => {
  assert.deepEqual(buildGridWhere([], mysqlCtx), { where: "", values: [] });
  assert.deepEqual(buildGridWhere(null, mysqlCtx), { where: "", values: [] });
  assert.deepEqual(buildGridWhere(undefined, mysqlCtx), { where: "", values: [] });
});

test("comparison ops bind values as placeholders, never inline", () => {
  const { where, values } = buildGridWhere(
    [{ column: "name", op: "eq", value: "x" }],
    mysqlCtx,
  );
  assert.equal(where, " WHERE `name` = ?");
  assert.deepEqual(values, ["x"]);
});

test("all allowlisted operators compile", () => {
  const ops = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=", like: "LIKE" };
  for (const [op, opSql] of Object.entries(ops)) {
    const { where, values } = buildGridWhere([{ column: "c", op, value: "v" }], mysqlCtx);
    assert.equal(where, ` WHERE \`c\` ${opSql} ?`);
    assert.deepEqual(values, op === "like" ? ["%v%"] : ["v"]);
  }
});

test("ops are case-insensitive", () => {
  const { where, values } = buildGridWhere([{ column: "c", op: "EQ", value: "1" }], mysqlCtx);
  assert.equal(where, " WHERE `c` = ?");
  assert.deepEqual(values, ["1"]);
});

test("pg placeholders number by bind index", () => {
  const { where, values } = buildGridWhere(
    [
      { column: "a", op: "gte", value: 10 },
      { column: "b", op: "like", value: "ab" },
    ],
    pgCtx,
  );
  assert.equal(where, ' WHERE "a" >= $1 AND "b" LIKE $2');
  assert.deepEqual(values, ["10", "%ab%"], "values are bound as strings, placeholders carry the typing");
});

test("null checks carry no bound values", () => {
  const { where, values } = buildGridWhere(
    [
      { column: "a", op: "nul" },
      { column: "b", op: "nnul" },
    ],
    mysqlCtx,
  );
  assert.equal(where, " WHERE `a` IS NULL AND `b` IS NOT NULL");
  assert.deepEqual(values, []);
});

test("like wraps the value with % on both sides", () => {
  const { values } = buildGridWhere([{ column: "c", op: "like", value: "ab" }], mysqlCtx);
  assert.deepEqual(values, ["%ab%"]);
});

test("nullish values bind as empty strings", () => {
  const { values } = buildGridWhere(
    [
      { column: "a", op: "eq", value: null },
      { column: "b", op: "eq" },
    ],
    mysqlCtx,
  );
  assert.deepEqual(values, ["", ""]);
});

test("unknown ops and invalid filters are ignored", () => {
  const { where, values } = buildGridWhere(
    [
      { column: "c", op: "DROP TABLE", value: "x" },
      { column: "c", value: "x" },
      null,
      { op: "eq", value: "x" },
      { column: "", op: "eq", value: "x" },
      { column: 42, op: "eq", value: "x" },
    ],
    mysqlCtx,
  );
  assert.equal(where, "");
  assert.deepEqual(values, []);
});

test("filter list is capped at MAX_GRID_FILTERS", () => {
  const filters = Array.from({ length: MAX_GRID_FILTERS + 5 }, (_, i) => ({
    column: `c${i}`,
    op: "eq",
    value: i,
  }));
  const { where, values } = buildGridWhere(filters, mysqlCtx);
  assert.equal(values.length, MAX_GRID_FILTERS);
  assert.equal(where.match(/ AND /g)?.length, MAX_GRID_FILTERS - 1);
  assert.ok(!where.includes("c10"), "filters past the cap never reach the SQL");
});
