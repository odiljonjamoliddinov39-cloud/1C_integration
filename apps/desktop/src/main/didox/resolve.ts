/**
 * Didox documents turned into received invoices ready for 1C, with no AI: the counterparty, the
 * contract and each line's item are looked up in 1C here. What is certain goes on a card; what is
 * not is handed to the model as a short list of choices, so that it settles those only, with a few
 * references, instead of writing every invoice out again.
 *
 * An IKPU code names a kind of goods, not one item (every size of a diaper has the same code), so
 * a code alone never decides a goods line: the supplier's name has to fit the item too.
 */
import { InvoiceReceivedDraft, type RunQueryInput } from "@platform/shared";

import { type DidoxDocument, type DidoxLine, didoxKey } from "./document.js";

export type QueryOutcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

export interface ResolverDeps {
  query(input: RunQueryInput): Promise<QueryOutcome>;
  describe(objects: string[]): Promise<QueryOutcome>;
}

export interface Candidate {
  ref: string;
  name: string;
}

export interface Problem {
  /** The document as the summary names it: "312318957/24". */
  document: string;
  line?: number;
  code:
    | "NOT_THIS_COMPANY"
    | "CHECK"
    | "COUNTERPARTY_NOT_FOUND"
    | "COUNTERPARTY_AMBIGUOUS"
    | "CONTRACT_NOT_FOUND"
    | "CONTRACT_AMBIGUOUS"
    | "ITEM_NOT_FOUND"
    | "ITEM_CHOOSE"
    | "VALIDATION";
  message: string;
  candidates?: Candidate[];
}

/** What the model decided for what the program could not: references only. */
export interface Overrides {
  items?: { document: string; line: number; ref: string }[];
  counterparties?: { document: string; ref: string }[];
  contracts?: { document: string; ref: string }[];
}

export interface Resolved {
  ready: { doc: DidoxDocument; draft: InvoiceReceivedDraft }[];
  problems: Problem[];
}

/** What is learned from 1C once per base: which attribute of the nomenclature holds the IKPU code. */
export interface ResolverCache {
  ikpuAttribute?: string | null;
}

/** Problems of the supplier's own figures stop a document; an unusual VAT rate is only shown. */
const BLOCKING = new Set([
  "LINE_AMOUNT",
  "LINE_VAT",
  "LINE_TOTAL",
  "NO_LINES",
  "NO_NUMBER",
  "ACT_DIFFERS",
  "TIN_FORMAT",
]);

// --- Matching the supplier's name to an item -------------------------------------------------

/** Words and numbers of a name, lower case, "ё" as "е", without quotes and punctuation. */
export function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

const isNumber = (t: string) => /\d/.test(t);

/** Two words of a name are the same when they match, or differ by one letter (CRISTAL, CRYSTAL). */
function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  if (isNumber(a) || isNumber(b) || a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1)
    return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const rest = (s: string, from: number) => s.slice(from);
  return rest(a, i + 1) === rest(b, i + 1) || rest(a, i + 1) === rest(b, i) || rest(a, i) === rest(b, i + 1);
}

/** Share of the words the two names have in common (0–1). */
export function similarity(a: string, b: string): number {
  const ta = [...new Set(tokens(a))];
  const tb = [...new Set(tokens(b))];
  if (ta.length === 0 || tb.length === 0) return 0;
  const common = ta.filter((x) => tb.some((y) => sameToken(x, y))).length;
  return common / (ta.length + tb.length - common);
}

/** The numbers of the item (volume, size, count) that the supplier's name does not have: another product. */
function conflicting(supplier: string, item: string): boolean {
  const have = new Set(tokens(supplier).filter(isNumber));
  return tokens(item)
    .filter(isNumber)
    .some((n) => !have.has(n));
}

export type ItemMatch =
  { kind: "match"; ref: string } | { kind: "choose"; candidates: Candidate[] } | { kind: "none" };

/**
 * One item out of the ones that share the line's IKPU code. Certain only when the name is the same,
 * or clearly the best fit; a service is free text under a category code, so a single candidate is
 * enough for it. Anything else is left to the model, with the best few.
 */
export function matchItem(supplierName: string, candidates: Candidate[], service: boolean): ItemMatch {
  if (candidates.length === 0) return { kind: "none" };
  const normalized = tokens(supplierName).join(" ");
  const exact = candidates.filter((c) => tokens(c.name).join(" ") === normalized);
  const [onlyExact] = exact;
  if (exact.length === 1 && onlyExact) return { kind: "match", ref: onlyExact.ref };
  const [onlyCandidate] = candidates;
  if (candidates.length === 1 && service && onlyCandidate) return { kind: "match", ref: onlyCandidate.ref };

  const scored = candidates
    .map((c) => ({ c, score: similarity(supplierName, c.name), clash: conflicting(supplierName, c.name) }))
    .sort((x, y) => y.score - x.score);
  const [best, second] = scored;
  const clearest =
    best !== undefined &&
    !best.clash &&
    best.score >= (candidates.length === 1 ? 0.5 : 0.6) &&
    (second === undefined || best.score - second.score >= 0.15);
  if (clearest) return { kind: "match", ref: best.c.ref };
  return { kind: "choose", candidates: scored.slice(0, 5).map((s) => s.c) };
}

// --- Lines and drafts ------------------------------------------------------------------------

/** A service line goes to the services table of the document. */
export const isService = (l: DidoxLine) =>
  /^(услуг|xizmat|работ)/i.test(l.unit) || /^(услуг|работ|xizmat)/i.test(l.catalogName);

const sum = (tiyin: number) => Math.round(tiyin) / 100;

export function draftOf(
  doc: DidoxDocument,
  counterparty: { ref: string } | { inn: string },
  contract: { ref: string } | { number: string; date?: string } | undefined,
  itemRefs: string[],
): InvoiceReceivedDraft {
  return {
    number: doc.number,
    date: doc.date,
    counterparty,
    ...(contract ? { contract } : {}),
    lines: doc.lines.map((l, i) => ({
      item: { ref: itemRefs[i] ?? "" },
      kind: isService(l) ? ("service" as const) : ("goods" as const),
      ...(l.unit ? { unit: l.unit } : {}),
      quantity: l.qty,
      price: sum(l.price),
      amount: sum(l.amount),
      vatRate: l.vatRate,
      vatAmount: sum(l.vat),
      total: sum(l.total),
    })),
    comment: `Didox ${doc.kind} ${doc.number}`,
  } as InvoiceReceivedDraft;
}

// --- Looking up 1C ---------------------------------------------------------------------------

const CHUNK = 150;
const chunks = <T>(list: T[], size = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

interface Row {
  cells: unknown[];
}

/** Rows of a query that takes a list of values as parameters (a list in a 1C query is spelled out). */
async function lookup(
  deps: ResolverDeps,
  text: (placeholders: string) => string,
  values: string[],
): Promise<Row[] | null> {
  const rows: Row[] = [];
  for (const part of chunks(values)) {
    const params: Record<string, string> = {};
    part.forEach((v, i) => {
      params[`п${i}`] = v;
    });
    const outcome = await deps.query({
      query: text(part.map((_, i) => `&п${i}`).join(", ")),
      params,
      limit: 1000,
      refs: true,
    });
    if (!outcome.ok) return null;
    const data = outcome.data as { rows?: unknown[][] };
    for (const cells of data.rows ?? []) rows.push({ cells });
  }
  return rows;
}

const refOf = (cell: unknown): string | null =>
  cell && typeof cell === "object" && typeof (cell as { ref?: unknown }).ref === "string"
    ? (cell as { ref: string }).ref
    : null;
const textOf = (cell: unknown): string =>
  typeof cell === "string"
    ? cell
    : cell && typeof cell === "object" && typeof (cell as { name?: unknown }).name === "string"
      ? (cell as { name: string }).name
      : "";

/** The attribute of the nomenclature that holds the IKPU code, found by its name or its title on the form. */
async function ikpuAttribute(deps: ResolverDeps, cache: ResolverCache): Promise<string | null> {
  if (cache.ikpuAttribute !== undefined) return cache.ikpuAttribute;
  const outcome = await deps.describe(["Справочник.Номенклатура"]);
  let found: string | null = null;
  if (outcome.ok) {
    const objects = outcome.data as { attributes?: { name: string; synonym: string }[] }[];
    const attributes = objects[0]?.attributes ?? [];
    found =
      attributes.find((a) => /икпу/i.test(a.name) || /икпу/i.test(a.synonym))?.name ??
      attributes.find((a) => /классификатор/i.test(a.synonym) && !/назван|наимен/i.test(a.synonym))?.name ??
      attributes.find((a) => /классификатор/i.test(a.name) && !/назван|наимен/i.test(a.name))?.name ??
      null;
  }
  // A failed look is not remembered: the base may have been busy.
  if (outcome.ok) cache.ikpuAttribute = found;
  return found;
}

const day = (iso: string) => iso.slice(0, 10);
const contractTitle = (number: string, date: string) =>
  `№${number}${date ? ` от ${day(date).split("-").reverse().join(".")}` : ""}`;

/**
 * Looks everything up and sorts the documents: those ready for a card, with their drafts, and what
 * is left for the model, each with the little it needs to decide.
 */
export async function resolveDocuments(
  docs: DidoxDocument[],
  options: { companyInn?: string; overrides?: Overrides; cache?: ResolverCache },
  deps: ResolverDeps,
): Promise<Resolved> {
  const problems: Problem[] = [];
  const overrides = options.overrides ?? {};
  const cache = options.cache ?? {};
  const problem = (
    doc: DidoxDocument,
    code: Problem["code"],
    message: string,
    extra: Partial<Problem> = {},
  ) => problems.push({ document: didoxKey(doc), code, message, ...extra });

  // 1. Whose documents these are, and whether the supplier's own figures add up.
  let live: DidoxDocument[] = [];
  for (const doc of docs) {
    if (options.companyInn && doc.buyer.tin !== options.companyInn) {
      problem(
        doc,
        "NOT_THIS_COMPANY",
        `the buyer is ${doc.buyer.name} (INN ${doc.buyer.tin}), this base is for INN ${options.companyInn}: not entered here`,
      );
      continue;
    }
    const blocking = doc.issues.filter((i) => BLOCKING.has(i.code));
    if (blocking.length > 0) {
      problem(
        doc,
        "CHECK",
        blocking.map((i) => (i.line === null ? "" : `line ${i.line}: `) + i.message).join("; "),
      );
      continue;
    }
    live.push(doc);
  }

  // 2. Counterparties by INN.
  const inns = [...new Set(live.map((d) => d.seller.tin))];
  const found = new Map<string, Candidate[]>();
  const counterparties = inns.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.ИНН КАК ИНН, Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.Контрагенты КАК Т ГДЕ Т.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
        inns,
      )
    : [];
  const counterpartyRef = new Map<string, { ref: string } | { inn: string }>();
  if (counterparties) {
    for (const { cells } of counterparties) {
      const ref = refOf(cells[1]);
      if (ref)
        found.set(String(cells[0]), [
          ...(found.get(String(cells[0])) ?? []),
          { ref, name: textOf(cells[2]) },
        ]);
    }
  }
  const stillLive: DidoxDocument[] = [];
  for (const doc of live) {
    const chosen = overrides.counterparties?.find((o) => o.document === didoxKey(doc));
    if (chosen) {
      counterpartyRef.set(didoxKey(doc), { ref: chosen.ref });
      stillLive.push(doc);
      continue;
    }
    if (!counterparties) {
      // 1C could not be asked: the extension looks the counterparty up by INN when it writes.
      counterpartyRef.set(didoxKey(doc), { inn: doc.seller.tin });
      stillLive.push(doc);
      continue;
    }
    const matches = found.get(doc.seller.tin) ?? [];
    const [only] = matches;
    if (matches.length === 1 && only) {
      counterpartyRef.set(didoxKey(doc), { ref: only.ref });
      stillLive.push(doc);
    } else if (matches.length === 0) {
      problem(
        doc,
        "COUNTERPARTY_NOT_FOUND",
        `no counterparty with INN ${doc.seller.tin} (${doc.seller.name}) in 1C: create it first`,
      );
    } else {
      problem(
        doc,
        "COUNTERPARTY_AMBIGUOUS",
        `${matches.length} counterparties have INN ${doc.seller.tin}: choose one`,
        {
          candidates: matches,
        },
      );
    }
  }
  live = stillLive;

  // 3. Contracts by number and date.
  const contractRef = new Map<string, { ref: string } | { number: string; date?: string } | undefined>();
  const withContract = live.filter((d) => d.contract);
  const contractRows = withContract.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.Владелец.ИНН КАК ИНН, Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата ИЗ Справочник.ДоговорыКонтрагентов КАК Т ГДЕ Т.Владелец.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
        [...new Set(withContract.map((d) => d.seller.tin))],
      )
    : [];
  const afterContracts: DidoxDocument[] = [];
  for (const doc of live) {
    const key = didoxKey(doc);
    if (!doc.contract) {
      contractRef.set(key, undefined);
      afterContracts.push(doc);
      continue;
    }
    const chosen = overrides.contracts?.find((o) => o.document === key);
    if (chosen) {
      contractRef.set(key, { ref: chosen.ref });
      afterContracts.push(doc);
      continue;
    }
    if (!contractRows) {
      contractRef.set(key, {
        number: doc.contract.number,
        ...(doc.contract.date ? { date: doc.contract.date } : {}),
      });
      afterContracts.push(doc);
      continue;
    }
    const own = contractRows
      .filter(({ cells }) => String(cells[0]) === doc.seller.tin)
      .map(({ cells }) => ({
        ref: refOf(cells[1]) ?? "",
        number: textOf(cells[2]).trim(),
        date: textOf(cells[3]),
      }));
    const wanted = doc.contract;
    const same = own.filter(
      (c) =>
        c.number.toUpperCase() === wanted.number.trim().toUpperCase() &&
        (!wanted.date || !c.date || day(c.date) === wanted.date),
    );
    const [theContract] = same;
    if (same.length === 1 && theContract?.ref) {
      contractRef.set(key, { ref: theContract.ref });
      afterContracts.push(doc);
    } else {
      const candidates = own.map((c) => ({ ref: c.ref, name: contractTitle(c.number, c.date) }));
      problem(
        doc,
        same.length === 0 ? "CONTRACT_NOT_FOUND" : "CONTRACT_AMBIGUOUS",
        `${same.length === 0 ? "no contract" : "several contracts"} ${contractTitle(doc.contract.number, doc.contract.date)} of ${doc.seller.name} in 1C`,
        { candidates: candidates.slice(0, 8) },
      );
    }
  }
  live = afterContracts;

  // 4. Items: by the exact name, else by the IKPU code with the name to tell which.
  const lines = live.flatMap((doc) => doc.lines.map((line) => ({ doc, line })));
  const attribute = lines.length ? await ikpuAttribute(deps, cache) : null;
  const byName = new Map<string, Candidate[]>();
  const byCode = new Map<string, Candidate[]>();
  const names = [...new Set(lines.map(({ line }) => line.name).filter(Boolean))];
  const nameRows = names.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.Наименование КАК Наименование, Т.Ссылка КАК Ссылка ИЗ Справочник.Номенклатура КАК Т ГДЕ Т.Наименование В (${ph}) И НЕ Т.ПометкаУдаления И НЕ Т.ЭтоГруппа`,
        names,
      )
    : [];
  for (const { cells } of nameRows ?? []) {
    const ref = refOf(cells[1]);
    if (ref)
      byName.set(textOf(cells[0]).toLowerCase(), [
        ...(byName.get(textOf(cells[0]).toLowerCase()) ?? []),
        { ref, name: textOf(cells[0]) },
      ]);
  }
  const codes = [...new Set(lines.map(({ line }) => line.catalogCode).filter(Boolean))];
  if (attribute && codes.length) {
    const codeRows = await lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.${attribute} КАК Код, Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.Номенклатура КАК Т ГДЕ Т.${attribute} В (${ph}) И НЕ Т.ПометкаУдаления И НЕ Т.ЭтоГруппа`,
      codes,
    );
    for (const { cells } of codeRows ?? []) {
      const ref = refOf(cells[1]);
      const code = textOf(cells[0]).trim();
      if (ref) byCode.set(code, [...(byCode.get(code) ?? []), { ref, name: textOf(cells[2]) }]);
    }
  }

  const ready: Resolved["ready"] = [];
  for (const doc of live) {
    const key = didoxKey(doc);
    const refs: string[] = [];
    let open = 0;
    for (const line of doc.lines) {
      const chosen = overrides.items?.find((o) => o.document === key && o.line === line.n);
      if (chosen) {
        refs.push(chosen.ref);
        continue;
      }
      const sameName = byName.get(line.name.toLowerCase()) ?? [];
      const sameCode = byCode.get(line.catalogCode) ?? [];
      let ref: string | null = null;
      const [named] = sameName;
      if (
        sameName.length === 1 &&
        named &&
        (sameCode.length === 0 || sameCode.some((c) => c.ref === named.ref))
      ) {
        ref = named.ref;
      } else {
        const match = matchItem(line.name, sameCode, isService(line));
        if (match.kind === "match") ref = match.ref;
        else {
          open += 1;
          const what = `"${line.name}" (IKPU ${line.catalogCode || "-"}, ${line.qty} ${line.unit})`;
          if (match.kind === "choose") {
            problem(doc, "ITEM_CHOOSE", `${what}: ${sameCode.length} items share the code, none is certain`, {
              line: line.n,
              candidates: match.candidates,
            });
          } else {
            problem(
              doc,
              "ITEM_NOT_FOUND",
              `${what}: no item in 1C${attribute ? "" : " (the IKPU attribute of the nomenclature was not found, so only exact names are looked up)"}`,
              { line: line.n },
            );
          }
        }
      }
      refs.push(ref ?? "");
    }
    if (open > 0) continue;
    const counterparty = counterpartyRef.get(key);
    if (!counterparty) continue;
    const draft = draftOf(doc, counterparty, contractRef.get(key), refs);
    const valid = InvoiceReceivedDraft.safeParse(draft);
    if (!valid.success) {
      problem(
        doc,
        "VALIDATION",
        valid.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
      continue;
    }
    ready.push({ doc, draft: valid.data });
  }
  return { ready, problems };
}
