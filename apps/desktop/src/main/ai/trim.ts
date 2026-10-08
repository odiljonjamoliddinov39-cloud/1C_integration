/**
 * The result trimmer: what a query may bring back, and how it goes to the model. Row limits come
 * from the policy (a default when the model sets none, and a hard cap), and a result goes up as a
 * TOON table with a note when it was cut, so the model aggregates or narrows instead of paging.
 */
import { type AiPolicy, type QueryResult, type RunQueryInput } from "@platform/shared";

import { encodeTable } from "./toon.js";

/** The query with its row limit set from the policy. */
export function clampQuery(input: RunQueryInput, policy: AiPolicy): RunQueryInput {
  const limit = Math.min(input.limit ?? policy.defaultRows, policy.maxRows);
  return { ...input, limit };
}

function isQueryResult(data: unknown): data is QueryResult {
  const d = data as Partial<QueryResult> | null;
  return Array.isArray(d?.columns) && Array.isArray(d?.rows);
}

/** A run_query result as the text the model reads; null for results that stay JSON. */
export function shapeQueryResult(data: unknown, policy: AiPolicy): string | null {
  if (!isQueryResult(data)) return null;
  const table = encodeTable(data.columns, data.rows);
  if (!data.truncated) return table;
  return (
    `${table}\n[The result was cut at ${data.rows.length} rows; more exist. Do not page through them: ` +
    `aggregate in the query (sums, groups), narrow the filter, or set "limit" up to ${policy.maxRows}. ` +
    `If you answer from a cut list, say so.]`
  );
}
