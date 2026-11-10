/**
 * Documents read from Didox itself (its API), instead of from files the accountant attaches: the lists of
 * incoming and outgoing documents are paged through, each document's own JSON is read, and the result is the
 * same `DidoxDocument` that the archives give, so everything built on those (the summary, the checks, entering
 * into 1C) works on them unchanged. Reads only: nothing is changed in Didox.
 */
import type { DidoxClient } from "./client.js";
import { type DidoxDocument, isDidoxJson, parseDidoxDocument } from "./document.js";

export type Direction = "incoming" | "outgoing" | "both";

export interface FetchOptions {
  /** YYYY-MM-DD, inclusive; by the document's own date. */
  from?: string | undefined;
  to?: string | undefined;
  direction: Direction;
  /** The most documents to read (each one is a request to Didox). */
  limit: number;
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
  /** The oldest and the newest date seen in Didox's list ("" when a list gave none): shows how far back the walk got. */
  oldestListed: string;
  newestListed: string;
  /** Pages of the list read, and whether the walk stopped at the most pages it reads (older documents may lie further back). */
  pagesRead: number;
  stoppedAtPageLimit: boolean;
  /** Documents Didox would not give (id and why). */
  failed: { id: string; message: string }[];
  /** The limit was reached: there are more in this period. */
  truncated: boolean;
}

const PAGE = 100;
/** Pages of one list read at most (the dates cannot always be asked of Didox, so this bounds the walk). */
const MAX_PAGES = 100;
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

export async function fetchDidoxDocuments(
  client: DidoxClient,
  options: FetchOptions,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const owners = options.direction === "incoming" ? [0] : options.direction === "outgoing" ? [1] : [0, 1];
  const entries = new Map<string, Record<string, unknown>>();
  let truncated = false;
  let newerThanPeriod = 0;
  let oldestListed = "";
  let newestListed = "";
  let pagesRead = 0;
  let stoppedAtPageLimit = false;

  for (const owner of owners) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (signal?.aborted) break;
      const items = itemsOf(
        await client.listDocuments({
          owner: owner as 0 | 1,
          page,
          limit: PAGE,
          // Didox filters by the update date: a document is never updated before its own date, so
          // `dateFrom` is safe, but `dateTo` would lose documents signed after the period ends.
          ...(options.from ? { dateFrom: options.from } : {}),
        }),
      );
      if (items.length === 0) break;
      pagesRead += 1;
      let older = 0;
      for (const item of items) {
        const id = idOf(item);
        if (!id || entries.has(id)) continue;
        const { day, exact } = dayOf(item);
        if (day) {
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
      if (items.length < PAGE || older === items.length) break;
      if (entries.size >= options.limit) {
        truncated = true;
        break;
      }
      if (page === MAX_PAGES) stoppedAtPageLimit = true;
    }
  }

  let listed = entries.size;
  let ids = [...entries.keys()];
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
      if (!parsed) {
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
    oldestListed,
    newestListed,
    pagesRead,
    stoppedAtPageLimit,
    failed,
    truncated,
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
      `${result.unreadable} documents were found in the period but are of a kind the app does not read (or Didox gave no JSON for them).`,
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
  else if (result.pagesRead > 0 && result.oldestListed && result.oldestListed > from)
    parts.push(
      `Didox's list goes back only to ${result.oldestListed}: it holds nothing older for this company through its API; for ${from} attach Didox's archive.`,
    );
  if (parts.length === 0) parts.push(`Didox holds no document of this company for ${from} - ${to}.`);
  return parts.join(" ");
}
