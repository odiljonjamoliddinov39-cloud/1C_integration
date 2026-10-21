/**
 * The company's own Didox documents (it is the seller) entered into 1C as sales, with no AI. The buyer, its
 * contract and every line's item are looked up here, and the sale is written the way the company already writes
 * its sales: the newest posted «Реализация» to the same buyer (else the newest of all) is copied, and only what
 * belongs to this document changes: its date, buyer, contract, lines and amounts. The accounts, the warehouse, the
 * operation and the VAT habit of the line are the company's own, from the line of the earlier sale that has the same
 * item (else its first line). The sale is made unposted, for the accountant to check; the issued invoice follows from
 * the posted sale with the tool that makes it.
 */
import type { ChangeInput } from "@platform/shared";

import { type BankDeps, refTo, snapshot as bankSnapshot, writable } from "../bank/resolve.js";
import type { Template } from "../bank/resolve.js";
import { type DidoxDocument, type DidoxLine, didoxKey } from "./document.js";
import {
  type Candidate,
  type LineRules,
  type Overrides,
  type Problem,
  type ResolverCache,
  isService,
  itemFor,
  lookup,
  lookupItems,
  percentOfName,
  refOf,
  textOf,
  vatRatesOf,
} from "./resolve.js";

export type SalesDeps = BankDeps;

export interface SalesCache extends ResolverCache {
  /** The enumeration of VAT rates: percent → the value to write. */
  vatValues?: Map<number, string> | null;
  snapshots?: Map<string, Template | null>;
  lists?: Map<string, string[]>;
}

export interface SalesResolved {
  ready: { doc: DidoxDocument; change: ChangeInput; note: string }[];
  problems: Problem[];
  /** Documents whose sale is already in 1C (same buyer, day and amount). */
  alreadyIn1c: string[];
}

const SALE = "Документ.РеализацияТоваровУслуг";
const day = (iso: string) => iso.slice(0, 10);
const sum = (tiyin: number) => Math.round(tiyin) / 100;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Attributes of a copied sale that belong to the earlier document alone. */
const NOT_COPIED =
  /^(Number|Номер|Posted|Проведен|DeletionMark|ПометкаУдаления|Date|Дата|СчетФактура|ДокументОснование|ВходящийНомер|ДатаВходящего)/;

const SERVICES = /услуг|xizmat/i;
const GOODS = /товар|tovar/i;

const tableFor = (template: Template, kind: "goods" | "service"): string | null => {
  const names = Object.keys(template.tables).filter((n) => (template.tables[n]?.length ?? 0) > 0);
  const want = kind === "service" ? SERVICES : GOODS;
  return names.find((n) => want.test(n)) ?? null;
};

/** The earlier sales to copy from: this buyer's first, else the company's newest. */
async function saleList(deps: SalesDeps, cache: SalesCache, inn: string | null): Promise<string[]> {
  cache.lists ??= new Map();
  const key = inn ?? "*";
  const known = cache.lists.get(key);
  if (known) return known;
  const outcome = await deps.query({
    query: `ВЫБРАТЬ ПЕРВЫЕ 10 Т.Ссылка КАК Ссылка ИЗ ${SALE} КАК Т ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления${inn ? " И Т.Контрагент.ИНН = &инн" : ""} УПОРЯДОЧИТЬ ПО Т.Дата УБЫВ`,
    ...(inn ? { params: { инн: inn } } : {}),
    limit: 10,
    refs: true,
  });
  const refs = outcome.ok
    ? ((outcome.data as { rows?: unknown[][] }).rows ?? []).flatMap((cells) => {
        const ref = refOf(cells[0]);
        return ref ? [ref] : [];
      })
    : [];
  cache.lists.set(key, refs);
  return refs;
}

/** The newest sale of the buyer (else of the company) that has the tables the document needs filled. */
async function pickTemplate(
  deps: SalesDeps,
  cache: SalesCache,
  inn: string,
  need: { goods: boolean; service: boolean },
): Promise<Template | null> {
  const bankCache = { lists: new Map(), snapshots: (cache.snapshots ??= new Map()) };
  for (const scope of [inn, null]) {
    for (const ref of (await saleList(deps, cache, scope)).slice(0, 6)) {
      const template = await bankSnapshot(deps, bankCache, SALE, ref);
      if (!template) continue;
      if ((!need.goods || tableFor(template, "goods")) && (!need.service || tableFor(template, "service")))
        return template;
    }
  }
  return null;
}

async function vatValues(deps: SalesDeps, cache: SalesCache): Promise<Map<number, string> | null> {
  if (cache.vatValues !== undefined) return cache.vatValues;
  const outcome = await deps.query({
    query: "ВЫБРАТЬ Т.Ссылка КАК Ссылка ИЗ Перечисление.СтавкиНДС КАК Т",
    limit: 50,
    refs: true,
  });
  if (!outcome.ok) return null;
  const values = new Map<number, string>();
  for (const cells of (outcome.data as { rows?: unknown[][] }).rows ?? []) {
    const cell = cells[0] as { ref?: unknown; name?: unknown } | undefined;
    if (cell && typeof cell.ref === "string" && typeof cell.name === "string") {
      const percent = percentOfName(cell.name);
      // "Без НДС" and "0%" both read as 0: the plain "0%" wins.
      if (!values.has(percent) || /\d/.test(cell.name)) values.set(percent, cell.ref);
    }
  }
  if (values.size === 0) return null;
  cache.vatValues = values;
  return values;
}

export async function resolveSales(
  docs: DidoxDocument[],
  options: {
    companyInn: string;
    overrides?: Overrides;
    cache?: SalesCache;
    rules?: LineRules;
    warehouse?: string;
  },
  deps: SalesDeps,
): Promise<SalesResolved> {
  const problems: Problem[] = [];
  const overrides = options.overrides ?? {};
  const cache = options.cache ?? {};
  const alreadyIn1c: string[] = [];
  const problem = (
    doc: DidoxDocument,
    code: Problem["code"],
    message: string,
    extra: Partial<Problem> = {},
  ) => problems.push({ document: didoxKey(doc), code, message, ...extra });

  // 1. Our documents only, and only when the supplier-side figures (ours) add up.
  let live: DidoxDocument[] = [];
  for (const doc of docs) {
    if (doc.seller.tin !== options.companyInn) {
      problem(
        doc,
        "NOT_THIS_COMPANY",
        `the seller is ${doc.seller.name} (INN ${doc.seller.tin}), this base is for INN ${options.companyInn}: not entered here`,
      );
      continue;
    }
    const blocking = doc.issues.filter((i) =>
      ["LINE_AMOUNT", "LINE_VAT", "LINE_TOTAL", "NO_LINES", "NO_NUMBER", "TIN_FORMAT"].includes(i.code),
    );
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

  // 2. Buyers by INN.
  const inns = [...new Set(live.map((d) => d.buyer.tin))];
  const buyers = inns.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.ИНН КАК ИНН, Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.Контрагенты КАК Т ГДЕ Т.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
        inns,
      )
    : [];
  const buyerRef = new Map<string, string>();
  const stillLive: DidoxDocument[] = [];
  for (const doc of live) {
    const key = didoxKey(doc);
    const chosen = overrides.counterparties?.find((o) => o.document === key);
    if (chosen) {
      buyerRef.set(key, chosen.ref);
      stillLive.push(doc);
      continue;
    }
    if (!buyers) {
      problem(doc, "COUNTERPARTY_NOT_FOUND", "1C could not be asked for the buyer");
      continue;
    }
    const matches: Candidate[] = buyers
      .filter(({ cells }) => String(cells[0]) === doc.buyer.tin)
      .flatMap(({ cells }) => {
        const ref = refOf(cells[1]);
        return ref ? [{ ref, name: textOf(cells[2]) }] : [];
      });
    const [only] = matches;
    if (matches.length === 1 && only) {
      buyerRef.set(key, only.ref);
      stillLive.push(doc);
    } else if (matches.length === 0) {
      problem(
        doc,
        "COUNTERPARTY_NOT_FOUND",
        `no counterparty with INN ${doc.buyer.tin} (${doc.buyer.name}) in 1C: create it first`,
      );
    } else {
      problem(
        doc,
        "COUNTERPARTY_AMBIGUOUS",
        `${matches.length} counterparties have INN ${doc.buyer.tin}: choose one`,
        { candidates: matches },
      );
    }
  }
  live = stillLive;

  // 3. The buyer's contract: the one the document names, else the only one it has.
  const contractRows = live.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.Владелец.ИНН КАК ИНН, Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата ИЗ Справочник.ДоговорыКонтрагентов КАК Т ГДЕ Т.Владелец.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
        [...new Set(live.map((d) => d.buyer.tin))],
      )
    : [];
  const contractRef = new Map<string, string | null>();
  const afterContracts: DidoxDocument[] = [];
  for (const doc of live) {
    const key = didoxKey(doc);
    const chosen = overrides.contracts?.find((o) => o.document === key);
    if (chosen) {
      contractRef.set(key, chosen.ref);
      afterContracts.push(doc);
      continue;
    }
    if (!contractRows) {
      contractRef.set(key, null);
      afterContracts.push(doc);
      continue;
    }
    const own = contractRows
      .filter(({ cells }) => String(cells[0]) === doc.buyer.tin)
      .map(({ cells }) => ({
        ref: refOf(cells[1]) ?? "",
        number: textOf(cells[2]).trim(),
        date: textOf(cells[3]),
      }));
    const title = (c: { number: string; date: string }) =>
      `№${c.number}${c.date ? ` от ${day(c.date).split("-").reverse().join(".")}` : ""}`;
    const wanted = doc.contract;
    const named = wanted
      ? own.filter(
          (c) =>
            c.number.toUpperCase() === wanted.number.trim().toUpperCase() &&
            (!wanted.date || !c.date || day(c.date) === wanted.date),
        )
      : own;
    const [theContract] = named;
    if (named.length === 1 && theContract?.ref) {
      contractRef.set(key, theContract.ref);
      afterContracts.push(doc);
    } else {
      problem(
        doc,
        named.length === 0 ? "CONTRACT_NOT_FOUND" : "CONTRACT_AMBIGUOUS",
        doc.contract && named.length === 0
          ? `no contract ${title(doc.contract as { number: string; date: string })} of ${doc.buyer.name} in 1C (it has ${own.length === 0 ? "none" : own.map(title).join(", ")})`
          : own.length === 0
            ? `${doc.buyer.name} has no contract in 1C: make «№б/н» of the kind with the buyer first`
            : `${named.length} contracts of ${doc.buyer.name}: choose one`,
        { candidates: own.map((c) => ({ ref: c.ref, name: title(c) })).slice(0, 8) },
      );
    }
  }
  live = afterContracts;

  // 4. The VAT rates the base has.
  const rates = live.length > 0 ? await vatRatesOf(deps, cache) : null;
  if (rates) {
    const kept: DidoxDocument[] = [];
    for (const doc of live) {
      const missing = [
        ...new Set(
          doc.lines
            .map((l) => options.rules?.vatRateMap?.[l.vatRate] ?? l.vatRate)
            .filter((r) => !rates.includes(r)),
        ),
      ];
      if (missing.length === 0) kept.push(doc);
      else
        problem(
          doc,
          "VAT_RATE_MISSING",
          `the lines have VAT ${missing.map((r) => `${r}%`).join(", ")}, which this 1C does not have (it has ${rates.map((r) => `${r}%`).join(", ")}): ask the accountant once which of its rates to write them under (vatRateMap {from, to}), then call again`,
        );
    }
    live = kept;
  }

  // 5. Items, and the sales 1C already has.
  const items = await lookupItems(
    live.flatMap((d) => d.lines),
    deps,
    cache,
  );
  const sold = new Set<string>();
  if (live.length > 0) {
    const dates = live.map((d) => d.date).sort();
    const outcome = await deps.query({
      query: `ВЫБРАТЬ Т.Контрагент.ИНН КАК ИНН, Т.Дата КАК Дата, Т.СуммаДокумента КАК Сумма ИЗ ${SALE} КАК Т ГДЕ Т.Дата МЕЖДУ &начало И &конец И НЕ Т.ПометкаУдаления`,
      params: { начало: `${dates[0]}T00:00:00`, конец: `${dates.at(-1)}T23:59:59` },
      limit: 2000,
      refs: true,
    });
    if (outcome.ok)
      for (const cells of (outcome.data as { rows?: unknown[][] }).rows ?? [])
        if (typeof cells[2] === "number")
          sold.add(
            `${textOf(cells[0]) || String(cells[0])}|${day(String(cells[1]))}|${Math.round(cells[2] * 100)}`,
          );
  }
  const values = live.length > 0 ? await vatValues(deps, cache) : null;
  // The default unit of each item, by its name: a sale line without one is refused by 1C's filling check.
  const units = new Map<string, unknown>();
  const unitRows = live.length
    ? await lookup(
        deps,
        (ph) =>
          `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.ЕдиницаИзмерения КАК Единица ИЗ Справочник.Номенклатура КАК Т ГДЕ Т.Наименование В (${ph}) И НЕ Т.ПометкаУдаления`,
        [...new Set(live.flatMap((d) => d.lines.map((l) => l.name)).filter(Boolean))],
      )
    : [];
  for (const { cells } of unitRows ?? []) {
    const ref = refOf(cells[0]);
    if (ref && cells[1] && typeof cells[1] === "object") units.set(ref, cells[1]);
  }

  const ready: SalesResolved["ready"] = [];
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
      const found = itemFor(line, items);
      if (found.ref === null) {
        open += 1;
        problem(doc, found.code, found.message, {
          line: line.n,
          ...(found.candidates ? { candidates: found.candidates } : {}),
        });
        refs.push("");
      } else refs.push(found.ref);
    }
    if (open > 0) continue;
    if (sold.has(`${doc.buyer.tin}|${doc.date}|${Math.round(doc.totals.total)}`)) {
      alreadyIn1c.push(key);
      continue;
    }
    const kindOf = (l: DidoxLine) =>
      isService(l) || doc.kind === "act" ? ("service" as const) : ("goods" as const);
    const need = {
      goods: doc.lines.some((l) => kindOf(l) === "goods"),
      service: doc.lines.some((l) => kindOf(l) === "service"),
    };
    const template = await pickTemplate(deps, cache, doc.buyer.tin, need);
    if (!template) {
      problem(
        doc,
        "NO_TEMPLATE",
        `1C has no posted sale with ${need.goods && need.service ? "goods and services" : need.service ? "services" : "goods"} to copy: enter this one with propose_changes from the company's practice`,
      );
      continue;
    }
    const built = buildSale(doc, template, {
      buyer: buyerRef.get(key) ?? "",
      contract: contractRef.get(key) ?? null,
      refs,
      kindOf,
      rules: options.rules,
      values,
      units,
      ...(options.warehouse ? { warehouse: options.warehouse } : {}),
    });
    if (!built.ok) {
      problem(doc, "BAD_TEMPLATE", built.message);
      continue;
    }
    ready.push({ doc, change: built.change, note: built.note });
  }
  return { ready, problems, alreadyIn1c };
}

interface BuildContext {
  buyer: string;
  contract: string | null;
  refs: string[];
  kindOf: (l: DidoxLine) => "goods" | "service";
  rules: LineRules | undefined;
  values: Map<number, string> | null;
  units: Map<string, unknown>;
  warehouse?: string;
}

const firstKey = (keys: string[], have: Record<string, unknown>) => keys.find((k) => k in have);

function buildSale(
  doc: DidoxDocument,
  template: Template,
  ctx: BuildContext,
): { ok: true; change: ChangeInput; note: string } | { ok: false; message: string } {
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(template.fields)) {
    if (!NOT_COPIED.test(name)) fields[name] = writable(value);
  }
  fields[firstKey(["Дата", "Date"], template.fields) ?? "Дата"] = doc.date;
  const buyerKey = firstKey(["Контрагент"], template.fields);
  if (buyerKey) fields[buyerKey] = refTo(template.fields[buyerKey], ctx.buyer, "Справочник.Контрагенты");
  const contractKey = firstKey(["ДоговорКонтрагента", "Договор"], template.fields);
  if (contractKey && ctx.contract)
    fields[contractKey] = refTo(
      template.fields[contractKey],
      ctx.contract,
      "Справочник.ДоговорыКонтрагентов",
    );
  else if (contractKey) fields[contractKey] = undefined;
  const warehouseKey = firstKey(["Склад"], template.fields);
  if (warehouseKey && ctx.warehouse)
    fields[warehouseKey] = refTo(template.fields[warehouseKey], ctx.warehouse, "Справочник.Склады");
  const commentKey = firstKey(["Комментарий"], template.fields);
  if (commentKey) fields[commentKey] = `Didox ${doc.kind} ${doc.number}`;
  const totalKey = firstKey(["СуммаДокумента"], template.fields);
  if (totalKey) fields[totalKey] = sum(doc.totals.total);
  // Whether the line's amount already holds the VAT is the company's own setting of the sale.
  const includesVat = template.fields["СуммаВключаетНДС"] === true;

  const tables: Record<string, Record<string, unknown>[]> = {};
  const seenTables = new Set<string>();
  for (const [index, line] of doc.lines.entries()) {
    const kind = ctx.kindOf(line);
    const name = tableFor(template, kind);
    if (!name)
      return {
        ok: false,
        message: `the earlier sale ${template.ref} has no ${kind === "service" ? "services" : "goods"} table with a line to copy`,
      };
    seenTables.add(name);
    const prototypes = template.tables[name] ?? [];
    const itemRef = ctx.refs[index] ?? "";
    const prototype = prototypes.find((row) => refOf(row["Номенклатура"]) === itemRef) ?? prototypes[0] ?? {};
    const row: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(prototype)) row[column] = writable(value);
    const rate = ctx.rules?.vatRateMap?.[line.vatRate] ?? line.vatRate;
    const set = (names: string[], value: unknown) => {
      const at = firstKey(names, prototype);
      if (at) row[at] = value;
    };
    set(["Номенклатура"], refTo(prototype["Номенклатура"], itemRef, "Справочник.Номенклатура"));
    set(["Количество"], line.qty);
    const amount = includesVat ? sum(line.total) : sum(line.amount);
    set(["Сумма"], amount);
    set(["Цена"], line.qty > 0 ? round2(amount / line.qty) : amount);
    set(["СуммаНДС"], sum(line.vat));
    set(["Всего", "СуммаВсего", "СуммаСНДС"], sum(line.total));
    const rateValue = ctx.values?.get(rate);
    if (firstKey(["СтавкаНДС"], prototype)) {
      if (rateValue === undefined) return { ok: false, message: `the base has no VAT rate of ${rate}%` };
      row["СтавкаНДС"] = rateValue;
    }
    const unit = ctx.units.get(itemRef);
    if (unit) {
      const at = firstKey(["ЕдиницаИзмерения", "Единица"], prototype);
      if (at) row[at] = writable(unit);
    }
    tables[name] = [...(tables[name] ?? []), row];
  }
  const from = `${template.fields["Номер"] ?? template.ref} of ${day(String(template.fields["Дата"] ?? ""))}`;
  return {
    ok: true,
    change: { action: "create", object: SALE, fields, tables, post: false },
    note: `sale copied from the company's ${from}: its accounts, warehouse and operation are kept; check them`,
  };
}
