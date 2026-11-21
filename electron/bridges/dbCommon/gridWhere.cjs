"use strict";

// Grid filter chips (SqlTableData): identifiers only via quote(), operators
// only via this allowlist, values only as placeholders — never interpolated.
const MAX_GRID_FILTERS = 10;
const GRID_FILTER_OPS = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=", like: "LIKE" };

/**
 * Compile grid filter chips into one WHERE fragment. `quote` quotes
 * identifiers (mysql backticks / pg double quotes) and `placeholder` renders
 * the value placeholder for the 1-based bind index (`?` for mysql, `$n` for
 * pg). `nul`/`nnul` carry no value; invalid ops are ignored; the list is
 * capped at MAX_GRID_FILTERS. Returns `{ where, values }` for the driver's
 * placeholder binding.
 */
function buildGridWhere(filters, { quote, placeholder }) {
  const parts = [];
  const values = [];
  if (!Array.isArray(filters)) return { where: "", values };
  for (const filter of filters.slice(0, MAX_GRID_FILTERS)) {
    if (!filter || typeof filter.column !== "string" || !filter.column) continue;
    const op = String(filter.op || "").toLowerCase();
    if (op === "nul") { parts.push(`${quote(filter.column)} IS NULL`); continue; }
    if (op === "nnul") { parts.push(`${quote(filter.column)} IS NOT NULL`); continue; }
    const opSql = GRID_FILTER_OPS[op];
    if (!opSql) continue;
    parts.push(`${quote(filter.column)} ${opSql} ${placeholder(values.length + 1)}`);
    const raw = filter.value == null ? "" : String(filter.value);
    values.push(op === "like" ? `%${raw}%` : raw);
  }
  return { where: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", values };
}

module.exports = { buildGridWhere, MAX_GRID_FILTERS };
