/**
 * What the model needs to enter the documents this company issued (read from Didox) into 1C as sales, read by the
 * program in one go instead of by the model one query per step: the warehouses, the buyer and its contracts, the
 * items by the names on the Didox lines, the VAT rates the base has against those on the lines, the sales already in
 * 1C for the period, and the newest posted sale to copy. A read that fails is left out (the model asks for it
 * itself); nothing is changed in 1C.
 */
import type { QueryOutcome, ResolverDeps } from "./resolve.js";
import { lookup, refOf, textOf } from "./resolve.js";
import type { DidoxDocument } from "./document.js";

const day = (cell: unknown): string => (typeof cell === "string" ? cell.slice(0, 10) : "");

const rows = (outcome: QueryOutcome): unknown[][] =>
  outcome.ok ? ((outcome.data as { rows?: unknown[][] }).rows ?? []) : [];

const bool = (cell: unknown) => (cell === true ? "yes" : cell === false ? "no" : "");

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

export async function readSaleKit(deps: ResolverDeps, docs: DidoxDocument[]): Promise<string> {
  const issued = docs.filter((d) => d.kind === "invoice" || d.kind === "act");
  if (issued.length === 0) return "";
  const buyers = unique(issued.map((d) => d.buyer.tin));
  const names = unique(issued.flatMap((d) => d.lines.map((l) => l.name)));
  const dates = issued.map((d) => d.date).sort();
  const from = dates[0] ?? "";
  const to = dates.at(-1) ?? "";
  const rates = unique(issued.flatMap((d) => d.lines.map((l) => String(l.vatRate))));

  const [warehouses, counterparties, contracts, items, vat, sales, latest] = await Promise.all([
    deps.query({
      query:
        "ВЫБРАТЬ ПЕРВЫЕ 10 Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование ИЗ Справочник.Склады КАК Т ГДЕ НЕ Т.ПометкаУдаления",
      limit: 10,
      refs: true,
    }),
    lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование, Т.ИНН КАК ИНН ИЗ Справочник.Контрагенты КАК Т ГДЕ Т.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
      buyers,
    ),
    lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Владелец.ИНН КАК ИНН, Т.Номер КАК Номер, Т.Дата КАК Дата, Т.ВидДоговора КАК Вид ИЗ Справочник.ДоговорыКонтрагентов КАК Т ГДЕ Т.Владелец.ИНН В (${ph}) И НЕ Т.ПометкаУдаления`,
      buyers,
    ),
    lookup(
      deps,
      (ph) =>
        `ВЫБРАТЬ Т.Ссылка КАК Ссылка, Т.Наименование КАК Наименование, Т.ЕдиницаИзмерения КАК Ед, Т.СтавкаНДС КАК НДС, Т.Услуга КАК Услуга ИЗ Справочник.Номенклатура КАК Т ГДЕ Т.Наименование В (${ph}) И НЕ Т.ПометкаУдаления`,
      names,
    ),
    deps.query({
      query:
        "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК Представление ИЗ Перечисление.СтавкиНДС КАК Т УПОРЯДОЧИТЬ ПО Т.Порядок",
      limit: 20,
    }),
    deps.query({
      query:
        "ВЫБРАТЬ ПЕРВЫЕ 30 Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата, Т.Проведен КАК Проведен, Т.СуммаДокумента КАК Сумма, Т.Контрагент.ИНН КАК ИНН " +
        "ИЗ Документ.РеализацияТоваровУслуг КАК Т ГДЕ Т.Дата МЕЖДУ &с И &по И НЕ Т.ПометкаУдаления",
      params: { с: `${from}T00:00:00`, по: `${to}T23:59:59` },
      limit: 30,
      refs: true,
    }),
    deps.query({
      query:
        "ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ссылка, Т.Номер КАК Номер, Т.Дата КАК Дата ИЗ Документ.РеализацияТоваровУслуг КАК Т ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления УПОРЯДОЧИТЬ ПО Т.Дата УБЫВ",
      limit: 1,
      refs: true,
    }),
  ]);

  const out = [
    "Entering the issued documents as sales: what the program read from 1C (no need to query it again):",
  ];
  const warehouseRows = rows(warehouses);
  if (warehouseRows.length > 0)
    out.push(
      `Warehouses: ${warehouseRows.map((c) => `${textOf(c[1]) || textOf(c[0])} [${refOf(c[0])}]`).join("; ")}`,
    );

  if (counterparties) {
    for (const buyer of buyers) {
      const found = counterparties.filter((r) => textOf(r.cells[2]) === buyer || r.cells[2] === buyer);
      const name = issued.find((d) => d.buyer.tin === buyer)?.buyer.name ?? buyer;
      if (found.length === 0) out.push(`Buyer ${name} (INN ${buyer}): not in 1C, create it first.`);
      else {
        const ref = refOf(found[0]?.cells[0]);
        const list = (contracts ?? [])
          .filter((r) => r.cells[1] === buyer || textOf(r.cells[1]) === buyer)
          .map(
            (r) =>
              `№${textOf(r.cells[2])} of ${day(r.cells[3])} (${textOf(r.cells[4])}) [${refOf(r.cells[0])}]`,
          );
        out.push(
          `Buyer ${name} (INN ${buyer}): [${ref}]${found.length > 1 ? ` (${found.length} with this INN)` : ""}; contracts: ${list.length > 0 ? list.join("; ") : "none, make «№б/н от <date>» of the kind with the buyer first"}`,
        );
      }
    }
  }

  if (items) {
    out.push("Items by the Didox line name:");
    for (const name of names) {
      const found = items.filter((r) => textOf(r.cells[1]) === name);
      out.push(
        found.length === 0
          ? `- «${name}»: not in 1C`
          : `- «${name}»: ${found.map((r) => `[${refOf(r.cells[0])}] unit ${textOf(r.cells[2]) || "-"}, VAT ${textOf(r.cells[3]) || "-"}, ${bool(r.cells[4]) === "yes" ? "service" : "goods"}`).join(" | ")}`,
      );
    }
  }

  const baseRates = rows(vat)
    .map((c) => textOf(c[0]))
    .filter(Boolean);
  if (baseRates.length > 0) {
    const missing = rates.filter((r) => !baseRates.some((b) => new RegExp(`(^|\\D)${r}(\\D|$)`).test(b)));
    out.push(
      `VAT rates the base has: ${baseRates.join(", ")}. On the Didox lines: ${rates.map((r) => `${r}%`).join(", ")}.` +
        (missing.length > 0
          ? ` The base has no ${missing.map((r) => `${r}%`).join(", ")}: do not probe for it, say so and let the accountant decide.`
          : ""),
    );
  }

  const saleRows = rows(sales);
  out.push(
    saleRows.length > 0
      ? `Sales already in 1C for ${from} – ${to}: ${saleRows.map((c) => `${textOf(c[1])} of ${day(c[2])}${c[3] === true ? " posted" : ""}, ${c[4]}, INN ${textOf(c[5])}`).join("; ")}`
      : `No sales in 1C for ${from} – ${to}.`,
  );
  const last = rows(latest)[0];
  out.push(
    last
      ? `Newest posted sale to copy as the template: ${textOf(last[1])} of ${day(last[2])} [${refOf(last[0])}] (read it with get_object).`
      : "1C has no posted sale to copy: build it from the company's learned practice (ledger accounts) and say which accounts you chose.",
  );
  return out.join("\n");
}
