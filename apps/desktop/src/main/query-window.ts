/**
 * Rows of a period from 1C, however many there are. One query returns at most 1000 rows (the connector refuses a larger
 * limit), so a period that has more is split in halves until every part fits; a part is read again only when it came back
 * full. A single day that alone fills the limit is returned as it is (more of one day cannot be split).
 */
import type { RunQueryInput } from "@platform/shared";

import type { QueryOutcome } from "./didox/resolve.js";

export const QUERY_LIMIT = 1000;

const MS_DAY = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * `query` has the parameters &начало and &конец (the first and the last moment of the part). Null when 1C refused a part:
 * nothing is then said about the period.
 */
export async function rowsOfPeriod(
  deps: { query: (input: RunQueryInput) => Promise<QueryOutcome> },
  query: string,
  from: string,
  to: string,
): Promise<unknown[][] | null> {
  const outcome = await deps.query({
    query,
    params: { начало: `${from}T00:00:00`, конец: `${to}T23:59:59` },
    limit: QUERY_LIMIT,
    refs: true,
  });
  if (!outcome.ok) return null;
  const data = outcome.data as { rows?: unknown[][]; truncated?: boolean };
  const rows = data.rows ?? [];
  if (rows.length < QUERY_LIMIT && !data.truncated) return rows;
  if (from >= to) return rows;
  const middle = iso(at(from) + Math.floor((at(to) - at(from)) / MS_DAY / 2) * MS_DAY);
  const first = await rowsOfPeriod(deps, query, from, middle);
  const second = await rowsOfPeriod(deps, query, iso(at(middle) + MS_DAY), to);
  return first && second ? [...first, ...second] : null;
}
