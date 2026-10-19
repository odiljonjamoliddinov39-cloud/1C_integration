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
  /** Documents that are not an invoice, an act or another kind the app reads, or fall outside the dates. */
  skipped: number;
  /** Documents Didox would not give (id and why). */
  failed: { id: string; message: string }[];
  /** The limit was reached: there are more in this period. */
  truncated: boolean;
}

const PAGE = 100;
/** Pages of one list read at most (the dates cannot always be asked of Didox, so this bounds the walk). */
const MAX_PAGES = 30;
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

/** A YYYY-MM-DD date out of whatever date field a list entry has, or "". */
function dayOf(item: Record<string, unknown>): string {
  for (const key of ["docdate", "doc_date", "date", "updated", "updatedAt"]) {
    const value = item[key];
    const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return "";
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
      let older = 0;
      for (const item of items) {
        const id = idOf(item);
        if (!id || entries.has(id)) continue;
        const day = dayOf(item);
        // Lists come newest first; an entry last changed before the period began is not read.
        if (day && options.from && day < options.from) {
          older += 1;
          continue;
        }
        entries.set(id, item);
      }
      if (items.length < PAGE || older === items.length) break;
      if (entries.size >= options.limit) {
        truncated = true;
        break;
      }
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
  let skipped = 0;
  await inParallel(ids, async (id) => {
    if (signal?.aborted) return;
    try {
      // A list entry sometimes carries the document itself; if not, the document is asked for.
      let json = documentJson(entries.get(id));
      if (json === null) json = documentJson(await client.documentInfo(id));
      const parsed = json === null ? null : parseDidoxDocument(json);
      if (!parsed) {
        skipped += 1;
        return;
      }
      if ((options.from && parsed.date < options.from) || (options.to && parsed.date > options.to)) {
        skipped += 1;
        return;
      }
      documents.push({ ...parsed, id: parsed.id || id });
    } catch (e) {
      failed.push({ id, message: e instanceof Error ? e.message : String(e) });
    }
  });
  documents.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  return { documents, listed, skipped, failed, truncated };
}
