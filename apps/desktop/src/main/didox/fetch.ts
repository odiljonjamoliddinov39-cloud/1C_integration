/**
 * Documents read from Didox itself (its API), instead of from files the accountant attaches: the lists of
 * incoming and outgoing documents are paged through, each document's own JSON is read, and the result is the
 * same `DidoxDocument` that the archives give, so everything built on those (the summary, the checks, entering
 * into 1C) works on them unchanged. Reads only: nothing is changed in Didox.
 */
import { DidoxError, type DidoxClient } from "./client.js";
import { type DidoxDocument, isDidoxJson, parseDidoxDocument } from "./document.js";

export type Direction = "incoming" | "outgoing" | "both";

export interface FetchOptions {
  /** YYYY-MM-DD, inclusive; by the document's own date. */
  from?: string | undefined;
  to?: string | undefined;
  direction: Direction;
  /** The most documents to read (each one is a request to Didox). */
  limit: number;
  /** Today as YYYY-MM-DD (for tests; the clock otherwise). */
  today?: string;
}

export interface FetchResult {
  documents: DidoxDocument[];
  /** Documents the lists named, before the dates were applied. */
  listed: number;
  /** Documents that are not an invoice, an act or another kind the app reads, or fall outside the dates (the two below together). */
  skipped: number;
  /** Of `skipped`: documents of a kind the app does not read (or whose JSON Didox did not give). */
  unreadable: number;
  /** Of `skipped`: documents read, but dated outside the period. */
  outsidePeriod: number;
  /** List entries left out unread because their own date is after the period (they do not use up the limit). */
  newerThanPeriod: number;
  /** Every distinct document Didox's lists named, before any date or limit (`listed` is after them). */
  seen: number;
  /** The oldest and the newest document date (the document's own, not the day it was changed) seen in Didox's list, "" when the list gave none: shows how far back the walk got. */
  oldestListed: string;
  newestListed: string;
  /** Pages of the list read, and whether the walk stopped at the most pages it reads (older documents may lie further back). */
  pagesRead: number;
  stoppedAtPageLimit: boolean;
  /** Documents Didox would not give (id and why). */
  failed: { id: string; message: string }[];
  /** The limit was reached: there are more in this period. */
  truncated: boolean;
  /**
   * The date Didox's list took: false when the formats tried were answered and none changed its answer, so its list is only the
   * window it chooses itself (the documents are then not asked by date, and older ones may not be given at all). Absent when it
   * could not be found out (no date asked, or the probes failed).
   */
  dateFilter?: boolean;
  /** What each way of asking Didox for a date gave (one line each), when none was found to work: to see why. */
  dateProbe?: string[];
  /** The field names of the first list entry (no values), to see which date fields Didox's list carries. */
  entryFields?: string[];
  /**
   * What the list gave, before anything was kept or dropped, in plain words for the answer: how many entries by year (a "~" year is
   * the day an entry was last changed, the list giving no date of its own, "?" none), by document type, by status, and what each
   * window of the period gave. To tell Didox withholding documents from the program dropping them.
   */
  audit?: { seenByYear: string; byDoctype: string; byStatus: string; windows: string[] };
}

const tally = (map: Map<string, number>): string =>
  [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 24)
    .map(([key, count]) => `${key}:${count}`)
    .join(", ");

const fieldOf = (item: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "?";
};

/** YYYY-MM-DD as Didox's own screens write it: DD.MM.YYYY. */
const dmy = (day: string): string => day.split("-").reverse().join(".");

/** How Didox's list is asked for a period: the two query names, the way a date is written, and whether that was found to work. */
type DateWay = {
  names: [string, string];
  write: (day: string) => string;
  works: boolean | undefined;
  probes: string[];
};

/** Found once per connection (only a verdict, see `dateWay`). */
const dateWays = new WeakMap<DidoxClient, DateWay>();

const DATE_NAMES: [string, string][] = [
  ["dateFrom", "dateTo"],
  ["from", "to"],
  ["fromDate", "toDate"],
  ["startDate", "endDate"],
];

const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** A real calendar day written YYYY-MM-DD (not just a string of that shape). */
export const isDay = (day: string | undefined): day is string =>
  typeof day === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) &&
  new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

const todayOf = (): string => new Date().toISOString().slice(0, 10);

/** Didox did not exist before this: a period is not asked of it from earlier (so a mistaken year costs a few requests, not hundreds). */
const EARLIEST = "2000-01-01";

/**
 * The windows a period is asked of Didox in, newest first: a year each, from the period's start to today (a document can be
 * changed long after its date, and Didox may filter by that). Some Didox lists want both ends of a period and take no more
 * than a year; a window of a year with both ends is what any of them gives.
 */
export function windowsOf(from: string, today = todayOf()): { from: string; to: string }[] {
  const first = from < EARLIEST ? EARLIEST : from;
  const end = today > first ? today : first;
  const list: { from: string; to: string }[] = [];
  for (let start = first; start <= end;) {
    const stop = addDays(start, 364) < end ? addDays(start, 364) : end;
    list.push({ from: start, to: stop });
    start = addDays(stop, 1);
  }
  return list.reverse();
}

/** A failure that says the way of asking was refused (a 4xx but not a rate limit), not that Didox or the connection is in trouble. */
const refusal = (e: unknown): boolean =>
  e instanceof DidoxError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429;

/**
 * Didox does not say it did not understand a date: it falls back to a window of its own (a read of 2020 then gave only the
 * current year). So which way of asking works is found by asking, for each name pair (dateFrom/dateTo, from/to, ...) and way of
 * writing a date (DD.MM.YYYY, YYYY-MM-DD), always with both ends (some lists take neither alone): a year in 2000 and a year in
 * 2099 must both give an empty list (an ignored date gives the newest documents; a list honouring only one end gives them for
 * one of the two) and the last year to today must give documents (within a year: a list may refuse longer periods). Both
 * directions are asked when both are read. A way that gave no such evidence is not a verdict: a failed probe, or one that found
 * nothing at all, is not remembered, and a rate limit or a server error ends the probing instead of asking more of Didox. A
 * verdict is cached once (never replaced by a later one, never taken from a cancelled read). `probes` says what each way gave.
 */
async function dateWay(
  client: DidoxClient,
  owners: number[],
  today: string,
  signal?: AbortSignal,
): Promise<DateWay> {
  const known = dateWays.get(client);
  if (known) return known;
  const probes: string[] = [];
  const ways: DateWay[] = DATE_NAMES.flatMap((names) =>
    [dmy, (day: string) => day].map((write) => ({ names, write, works: undefined, probes })),
  );
  let verdict = true;
  for (const way of ways) {
    if (signal?.aborted) return { ...(ways[1] as DateWay), probes };
    const label = `${way.names.join("/")} ${way.write("2000-01-31") === "31.01.2000" ? "DD.MM.YYYY" : "YYYY-MM-DD"}`;
    try {
      const ask = async (from: string, to: string) => {
        let count = 0;
        for (const owner of owners) {
          const list = await client.listDocuments({
            owner: owner as 0 | 1,
            page: 1,
            limit: 1,
            [way.names[0]]: way.write(from),
            [way.names[1]]: way.write(to),
          });
          listError(list);
          count += itemsOf(list).length;
        }
        return count;
      };
      if ((await ask("2000-01-01", "2000-12-31")) > 0 || (await ask("2099-01-01", "2099-12-31")) > 0) {
        probes.push(
          `${label}: a year in 2000 or 2099 still gave documents (the dates were not both honoured)`,
        );
        continue;
      }
      if ((await ask(addDays(today, -364), today)) > 0) {
        probes.push(`${label}: taken`);
        const found = { ...way, works: true };
        if (!signal?.aborted) dateWays.set(client, found);
        return found;
      }
      probes.push(`${label}: no document in the last year answered`);
      verdict = false;
    } catch (e) {
      probes.push(`${label}: failed (${e instanceof Error ? e.message : String(e)})`);
      verdict = false;
      if (!refusal(e)) break; // Didox or the connection is in trouble: no more asking
    }
  }
  const none = { ...(ways[1] as DateWay), works: verdict ? false : undefined, probes };
  if (verdict && !signal?.aborted && !dateWays.has(client)) dateWays.set(client, none);
  return none;
}

const PAGE = 100;
/**
 * Pages of one list read at most (bounds the walk). Didox may give fewer entries per page than asked (its own screen shows 20),
 * so this is high enough for thousands of documents even then.
 */
const MAX_PAGES = 400;
const PARALLEL = 4;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The documents of a list answer, whether it is a bare array or holds one under `data` or another key. */
export function itemsOf(list: unknown): Record<string, unknown>[] {
  const top = record(list);
  const array = Array.isArray(list)
    ? list
    : (["data", "items", "documents", "result"].map((key) => top[key]).find(Array.isArray) ??
      Object.values(top).find(Array.isArray) ??
      []);
  return (array as unknown[]).map(record);
}

export function idOf(item: Record<string, unknown>): string {
  for (const key of ["_id", "doc_id", "id", "documentId"]) {
    const value = item[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

/**
 * A YYYY-MM-DD date out of whatever date field a list entry has, or "". `exact`: it is the document's own date
 * (not the day it was last changed, which can be much later), so it can keep a document out of a period both ways.
 */
function dayOf(item: Record<string, unknown>): { day: string; exact: boolean } {
  for (const key of ["docdate", "doc_date", "date", "updated", "updatedAt"]) {
    const value = item[key];
    const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
    if (match)
      return { day: `${match[1]}-${match[2]}-${match[3]}`, exact: key === "docdate" || key === "doc_date" };
  }
  return { day: "", exact: false };
}

/** The document JSON in a list entry or a details answer, however it is wrapped; null when there is none. */
export function documentJson(value: unknown): unknown {
  const top = record(value);
  for (const candidate of [value, top.data, top.json, top.document, record(top.data).json]) {
    if (typeof candidate === "string") {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (isDidoxJson(parsed)) return parsed;
      } catch {
        // not JSON: try the next place
      }
    } else if (isDidoxJson(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function inParallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

/**
 * A list answer that is an error envelope (or another shape with no list in it) is not an empty list: it is said so, instead of
 * "Didox holds nothing". Didox answers a real empty list as an empty array (or an object with an empty array in it).
 */
function listError(list: unknown): void {
  if (Array.isArray(list) || itemsOf(list).length > 0) return;
  const top = record(list);
  if (Object.values(top).some(Array.isArray)) return;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const message = text(top.error) || text(top.message) || text(top.msg) || text(record(top.error).message);
  if (message || top.success === false || top.error)
    throw new Error(
      `Didox answered the list with an error, not a list: ${message || JSON.stringify(top).slice(0, 200)}`,
    );
}

export async function fetchDidoxDocuments(
  client: DidoxClient,
  options: FetchOptions,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const owners = options.direction === "incoming" ? [0] : options.direction === "outgoing" ? [1] : [0, 1];
  const today = options.today ?? todayOf();
  const way =
    isDay(options.from) && !signal?.aborted ? await dateWay(client, owners, today, signal) : undefined;
  // Only a way of asking Didox is known to take is used: asking with one it refuses would fail the read. A date that bounds the
  // list also makes the end of the list the end of the walk, whatever order the list is in.
  const bounded = way?.works === true;
  const entries = new Map<string, Record<string, unknown>>();
  let truncated = false;
  let newerThanPeriod = 0;
  const seenIds = new Set<string>();
  let oldestListed = "";
  let newestListed = "";
  let pagesRead = 0;
  let stoppedAtPageLimit = false;
  let entryFields: string[] | undefined;
  const byYear = new Map<string, number>();
  const byDoctype = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const windows: string[] = [];
  const periods: ({ from: string; to: string } | undefined)[] =
    bounded && isDay(options.from) ? windowsOf(options.from, today) : [undefined];

  walking: for (const owner of owners) {
    for (const period of periods) {
      let windowPages = 0;
      let windowEntries = 0;
      const closeWindow = () => {
        if (windows.length < 14)
          windows.push(
            `${owner === 0 ? "in" : "out"} ${period ? `${period.from}..${period.to}` : "no date"}: ${windowPages} pages, ${windowEntries} entries`,
          );
      };
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (signal?.aborted) {
          closeWindow();
          break walking;
        }
        const list = await client.listDocuments({
          owner: owner as 0 | 1,
          page,
          limit: PAGE,
          ...(period && way
            ? { [way.names[0]]: way.write(period.from), [way.names[1]]: way.write(period.to) }
            : {}),
        });
        listError(list);
        const items = itemsOf(list);
        if (items.length === 0) break;
        pagesRead += 1;
        windowPages += 1;
        windowEntries += items.length;
        entryFields ??= Object.keys(items[0] ?? {}).slice(0, 40);
        let older = 0;
        let fresh = 0;
        for (const item of items) {
          const id = idOf(item);
          if (id && !seenIds.has(id)) {
            fresh += 1;
            const own = dayOf(item);
            const year = own.day ? `${own.exact ? "" : "~"}${own.day.slice(0, 4)}` : "?";
            byYear.set(year, (byYear.get(year) ?? 0) + 1);
            const type = fieldOf(item, ["doctype", "doc_type", "type"]);
            byDoctype.set(type, (byDoctype.get(type) ?? 0) + 1);
            const status = fieldOf(item, ["status", "doc_status"]);
            byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
          }
          if (id) seenIds.add(id);
          if (!id || entries.has(id)) continue;
          const { day, exact } = dayOf(item);
          if (day && exact) {
            if (!oldestListed || day < oldestListed) oldestListed = day;
            if (day > newestListed) newestListed = day;
          }
          // Lists come newest first; an entry last changed before the period began is not read.
          if (day && options.from && day < options.from) {
            older += 1;
            continue;
          }
          // A document dated after the period is not one of it, and must not use up the limit: a month two years back
          // lies behind everything issued since.
          if (exact && day && options.to && day > options.to) {
            newerThanPeriod += 1;
            continue;
          }
          entries.set(id, item);
        }
        // Only an empty page, a page that gave nothing new (Didox repeating one) or, when the date does not bound the list,
        // one wholly older than the period ends the walk: a page shorter than asked is not the last.
        if (fresh === 0 || (!bounded && older === items.length)) break;
        if (page === MAX_PAGES) stoppedAtPageLimit = true;
      }
      closeWindow();
    }
  }

  // The limit counts the documents read, not the entries listed: an entry whose own date the list does not give (only the day it
  // was last changed) may be of any year, so those changed near the period are read first, after the entries known to be in it.
  const near = options.to && isDay(options.to) ? addDays(options.to, 400) : today;
  const rank = (item: Record<string, unknown> | undefined): number => {
    const { day, exact } = dayOf(item ?? {});
    return exact ? 0 : day && day <= near ? 1 : 2;
  };
  let listed = entries.size;
  let ids = [...entries.keys()]
    .map((id, order) => ({ id, order, rank: rank(entries.get(id)) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.id);
  if (ids.length > options.limit) {
    truncated = true;
    ids = ids.slice(0, options.limit);
    listed = ids.length;
  }

  const documents: DidoxDocument[] = [];
  const failed: FetchResult["failed"] = [];
  let unreadable = 0;
  let outsidePeriod = 0;
  await inParallel(ids, async (id) => {
    if (signal?.aborted) return;
    try {
      // A list entry sometimes carries the document itself; if not, the document is asked for.
      let json = documentJson(entries.get(id));
      if (json === null) json = documentJson(await client.documentInfo(id));
      const parsed = json === null ? null : parseDidoxDocument(json);
      if (!parsed || !parsed.date) {
        unreadable += 1;
        return;
      }
      if ((options.from && parsed.date < options.from) || (options.to && parsed.date > options.to)) {
        outsidePeriod += 1;
        return;
      }
      documents.push({ ...parsed, id: parsed.id || id });
    } catch (e) {
      failed.push({ id, message: e instanceof Error ? e.message : String(e) });
    }
  });
  documents.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  return {
    documents,
    listed,
    skipped: unreadable + outsidePeriod,
    unreadable,
    outsidePeriod,
    newerThanPeriod,
    seen: seenIds.size,
    oldestListed,
    newestListed,
    pagesRead,
    stoppedAtPageLimit,
    failed,
    truncated,
    ...(way?.works !== undefined ? { dateFilter: way.works } : {}),
    ...(way && way.works !== true ? { dateProbe: way.probes } : {}),
    ...(entryFields ? { entryFields } : {}),
    audit: { seenByYear: tally(byYear), byDoctype: tally(byDoctype), byStatus: tally(byStatus), windows },
  };
}

/**
 * Why a read gave no document, in plain words from the numbers (so the answer never has to guess: "Didox is not connected" is
 * said only by the connection check, never by this). Empty when something was read.
 */
export function explainEmpty(result: FetchResult, from: string, to: string): string {
  if (result.documents.length > 0) return "";
  const parts: string[] = [];
  if (result.pagesRead === 0)
    parts.push("Didox's list for this direction was empty (it gave no document at all).");
  if (result.newerThanPeriod > 0)
    parts.push(`${result.newerThanPeriod} listed documents are dated after ${to} and were not read.`);
  if (result.unreadable > 0)
    parts.push(
      `${result.unreadable} documents were found in the period but are of a kind the app does not read (or Didox gave no JSON or no date for them).`,
    );
  if (result.outsidePeriod > 0)
    parts.push(`${result.outsidePeriod} documents were read but are dated outside ${from} - ${to}.`);
  if (result.failed.length > 0)
    parts.push(`${result.failed.length} documents Didox would not give (see failed).`);
  if (result.truncated)
    parts.push("The limit was reached before the period was; ask for one month at a time.");
  if (result.stoppedAtPageLimit)
    parts.push(
      `The walk stopped at the most pages it reads, back to ${result.oldestListed || "an unknown date"}: documents older than that were not reached; ask for a shorter, more recent period, or attach Didox's archive.`,
    );
  else if (
    result.dateFilter !== false &&
    !result.truncated &&
    result.pagesRead > 0 &&
    result.oldestListed &&
    result.oldestListed > from
  )
    parts.push(
      `Didox's list (read to its end) goes back only to ${result.oldestListed}: it holds nothing older for this company through its API; for ${from} attach Didox's archive.`,
    );
  if (result.dateFilter === false)
    parts.push(
      "Didox's list did not take the date asked of it (neither DD.MM.YYYY nor YYYY-MM-DD changed its answer), so it gives only the window it chooses itself.",
    );
  if (parts.length === 0) parts.push(`Didox holds no document of this company for ${from} - ${to}.`);
  return parts.join(" ");
}

/** A note for a read that found documents but stopped before the period's start, so older ones may exist. Empty otherwise. */
export function partialNote(result: FetchResult, from: string): string {
  if (result.documents.length === 0) return "";
  if (result.stoppedAtPageLimit)
    return `The walk stopped at the most pages it reads, back to ${result.oldestListed || "an unknown date"}: documents older than that, down to ${from}, were not reached. Say so, and ask for a shorter, more recent period.`;
  return "";
}
