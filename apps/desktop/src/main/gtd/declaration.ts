/**
 * The declaration as one validated object (the spec's §5): what the model read from the form pages (the numbers), merged with
 * what the program read from the clean text (the footer, the item names). Amounts are decimals kept as text; a graph the scan
 * does not show is null, never guessed. The object is what every check, the cost allocation and the posting proposal work from.
 */
import type { GtdReadInput } from "@platform/shared";

import { type Dec, dec, fixed, plain } from "./decimal.js";
import type { DeclarationPages } from "./pages.js";
import { splitName } from "./pages.js";
import { type Regime, detectRegime, declarationKey } from "./regime.js";

export interface Charge {
  /** Graph 47 type: "10" is the customs fee. */
  type: string;
  base: Dec | null;
  rate_text: string | null;
  amount: Dec | null;
  payment_type: string | null;
  /** null: a declaration-level line (TD-1); a number: the line is on that item's TD-2 sheet. */
  item_no: number | null;
}

export interface Item {
  no: number;
  hs: string | null;
  name_en: string | null;
  name_ru: string | null;
  /** Where the names came from: the clean back pages, or (when the PDF has no text layer) the model's reading. */
  name_source: "pdf" | "model" | null;
  qty: Dec | null;
  unit_code: string | null;
  gross_kg: Dec | null;
  net_kg: Dec | null;
  /** Graph 42, in the invoice currency. */
  value: Dec | null;
  procedure: string | null;
  statistical_value: Dec | null;
  condition: "new" | "used";
}

export interface Declaration {
  declaration_no: string | null;
  form_no: string | null;
  date: string | null;
  regime: Regime;
  customs_post: string | null;
  exporter: { name: string | null; country: string | null };
  importer: { name: string | null; inn: string | null };
  contract: { no: string | null; date: string | null };
  invoice: { no: string | null; date: string | null; currency: string | null; amount: Dec | null };
  fx_rate: Dec | null;
  customs_value_uzs: Dec | null;
  items_declared: number | null;
  preceding_document: string | null;
  warehouse: { licence: string | null; date: string | null; release_deadline: string | null } | null;
  charges: Charge[];
  items: Item[];
}

/** Things the merge noticed that the checks do not cover: shown to the accountant with the warnings. */
export interface BuildNotes {
  /** Fields that were given but are not numbers. */
  unreadable: string[];
  /** Items whose name the program has from nowhere. */
  nameless: number[];
  /** The footer and the model's reading of the header disagree. */
  headerConflicts: string[];
}

const text = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** ISO date from "2025-11-04" or "04.11.2025"; null when it is neither. */
export function isoDate(value: string | null | undefined): string | null {
  const t = text(value);
  if (!t) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const dmy = /^(\d{2})[./](\d{2})[./](\d{4})/.exec(t);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : [];
  if (!y || !m || !d) return null;
  const date = `${y}-${m}-${d}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || Number(m) > 12 || Number(d) > 31 ? null : date;
}

const USED_TEXT = /(?:^|[^\p{L}])б\s*\/\s*у(?![\p{L}])|(?:^|[^\p{L}])used(?![\p{L}])/iu;

/** The HS code as ten digits when it is written with spaces or dots; as given otherwise (V5 judges it). */
const hsOf = (value: string | null | undefined): string | null => {
  const t = text(value);
  if (!t) return null;
  const digits = t.replace(/[\s.]/g, "");
  return /^\d+$/.test(digits) ? digits : t;
};

export interface BuildOptions {
  /** IM 74 declarations already read for this company. */
  warehouse: (declarationNo: string) => boolean;
}

export function buildDeclaration(
  input: GtdReadInput,
  pages: DeclarationPages | null,
  options: BuildOptions,
): { declaration: Declaration; notes: BuildNotes } {
  const notes: BuildNotes = { unreadable: [], nameless: [], headerConflicts: [] };
  const num = (value: string | null | undefined, what: string): Dec | null => {
    const t = text(value);
    if (t === null) return null;
    const d = dec(t);
    if (!d) notes.unreadable.push(`${what}: «${t}»`);
    return d;
  };

  // The footer is clean on every page: it wins over the model's reading of the same header.
  const footer = pages?.footer ?? null;
  const readNo = declarationKey(input.declaration_no);
  const readDate = isoDate(input.date);
  if (footer && readNo && readNo !== footer.declarationNo)
    notes.headerConflicts.push(
      `declaration number: the footer says ${footer.declarationNo}, the form was read as ${readNo}`,
    );
  if (footer && readDate && readDate !== footer.date)
    notes.headerConflicts.push(`date: the footer says ${footer.date}, the form was read as ${readDate}`);

  const byNo = new Map((pages?.items ?? []).map((i) => [i.no, i]));
  const items: Item[] = input.items
    .map((raw) => {
      const fromPdf = byNo.get(raw.no);
      const modelEn = text(raw.name_en);
      const modelRu = text(raw.name_ru);
      let en = fromPdf?.nameEn ?? null;
      let ru = fromPdf?.nameRu ?? null;
      let source: Item["name_source"] = fromPdf ? "pdf" : null;
      if (!fromPdf && (modelEn || modelRu)) {
        // No text layer: the model's reading of graph 31, split the same way.
        const split = splitName(modelEn && modelRu ? `${modelEn}/${modelRu}` : (modelEn ?? modelRu ?? ""));
        en = split.en || null;
        ru = split.ru || null;
        source = "model";
      }
      if (!source) notes.nameless.push(raw.no);
      const used = fromPdf?.used ?? USED_TEXT.test(`${modelEn ?? ""} ${modelRu ?? ""}`);
      const label = `item ${raw.no}`;
      return {
        no: raw.no,
        hs: hsOf(raw.hs),
        name_en: en,
        name_ru: ru,
        name_source: source,
        qty: num(raw.qty, `${label} quantity`),
        unit_code: text(raw.unit_code),
        gross_kg: num(raw.gross_kg, `${label} gross weight`),
        net_kg: num(raw.net_kg, `${label} net weight`),
        value: num(raw.value, `${label} value (graph 42)`),
        procedure: text(raw.procedure),
        statistical_value: num(raw.statistical_value, `${label} statistical value (graph 46)`),
        condition: used ? ("used" as const) : ("new" as const),
      };
    })
    .sort((a, b) => a.no - b.no);

  const charges: Charge[] = input.charges.map((c, i) => ({
    type: c.type.trim(),
    base: num(c.base, `charge ${i + 1} base`),
    rate_text: text(c.rate_text),
    amount: num(c.amount, `charge ${i + 1} amount`),
    payment_type: text(c.payment_type),
    item_no: c.item_no ?? null,
  }));

  const preceding = text(input.preceding_document);
  const regime = detectRegime({
    text: input.regime,
    procedures: items.map((i) => i.procedure),
    preceding,
    warehouse: options.warehouse,
  });
  const warehouse = input.warehouse
    ? {
        licence: text(input.warehouse.licence),
        date: isoDate(input.warehouse.date) ?? text(input.warehouse.date),
        release_deadline: isoDate(input.warehouse.release_deadline) ?? text(input.warehouse.release_deadline),
      }
    : null;

  return {
    declaration: {
      declaration_no: footer?.declarationNo ?? readNo,
      form_no: text(input.form_no),
      date: footer?.date ?? readDate,
      regime,
      customs_post: footer?.post ?? text(input.customs_post),
      exporter: { name: text(input.exporter?.name), country: text(input.exporter?.country) },
      importer: {
        name: text(input.importer?.name),
        inn: text(input.importer?.inn)?.replace(/\D/g, "") || null,
      },
      contract: {
        no: text(input.contract?.no),
        date: isoDate(input.contract?.date) ?? text(input.contract?.date),
      },
      invoice: {
        no: text(input.invoice?.no),
        date: isoDate(input.invoice?.date) ?? text(input.invoice?.date),
        currency: text(input.invoice?.currency)?.toUpperCase() ?? null,
        amount: num(input.invoice?.amount, "invoice amount"),
      },
      fx_rate: num(input.fx_rate, "exchange rate (graph 23)"),
      customs_value_uzs: num(input.customs_value_uzs, "customs value"),
      items_declared: input.items_declared ?? null,
      preceding_document: preceding,
      warehouse,
      charges,
      items,
    },
    notes,
  };
}

/** The declaration as the spec's JSON (§5): decimals as strings, nothing a float. */
export function declarationJson(
  d: Declaration,
  checks: { rule: string; ok: boolean }[],
): Record<string, unknown> {
  const money = (v: Dec | null) => (v ? fixed(v, 2) : null);
  const usd = d.invoice.currency === "USD";
  return {
    declaration_no: d.declaration_no,
    form_no: d.form_no,
    date: d.date,
    regime: { type: d.regime.type, code: d.regime.code, kind: d.regime.kind },
    customs_post: d.customs_post,
    exporter: d.exporter,
    importer: d.importer,
    contract: d.contract,
    invoice: {
      no: d.invoice.no,
      date: d.invoice.date,
      currency: d.invoice.currency,
      amount: money(d.invoice.amount),
    },
    fx_rate: d.fx_rate ? plain(d.fx_rate) : null,
    customs_value_uzs: money(d.customs_value_uzs),
    preceding_document: d.preceding_document
      ? (declarationKey(d.preceding_document) ?? d.preceding_document)
      : null,
    warehouse: d.warehouse,
    charges: d.charges.map((c) => ({
      type: c.type,
      base: c.base ? plain(c.base) : null,
      rate_text: c.rate_text,
      amount: money(c.amount),
      payment_type: c.payment_type,
      item_no: c.item_no,
    })),
    items: d.items.map((i) => ({
      no: i.no,
      hs: i.hs,
      name_en: i.name_en,
      name_ru: i.name_ru,
      qty: i.qty ? plain(i.qty) : null,
      unit_code: i.unit_code,
      gross_kg: i.gross_kg ? plain(i.gross_kg) : null,
      net_kg: i.net_kg ? plain(i.net_kg) : null,
      value: money(i.value),
      value_usd: usd ? money(i.value) : null,
      condition: i.condition,
    })),
    checks,
  };
}
