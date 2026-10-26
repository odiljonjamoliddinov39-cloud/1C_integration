/**
 * Every number of a declaration is judged before anything is shown or posted. A number read from a scan can be wrong by one
 * digit, and the declaration ties its own figures together (items add up to the invoice, invoice × rate is the customs value,
 * the fee is a multiple of the base calculation value), so a slip shows as two numbers that disagree (V1–V12). A failed rule
 * blocks the run and is shown with the two numbers. Warnings (W1–W4 and the reading notes) do not block; they are shown.
 *
 * Money is exact to 0.01 because the customs system rounds the declaration; nothing here is a float.
 */
import { type Dec, abs, cmp, dec, fixed, mul, mulDiv, plain, round, sub, sum } from "./decimal.js";
import type { BuildNotes, Declaration, Item } from "./declaration.js";
import type { DeclarationPages } from "./pages.js";
import { procedureCode } from "./regime.js";

export interface Check {
  id: string;
  rule: string;
  ok: boolean;
  /** The rule does not apply to this declaration, or could not be judged without data the declaration does not carry. */
  skipped?: boolean;
  expected?: string;
  actual?: string;
  message: string;
  /** Sheets (footer numbers) to read again by eye when the rule fails: the one place a slip can be. */
  sheets?: number[];
  /** Reading again cannot settle this: the accountant decides (a missing sheet, another company's declaration, no contract). */
  needsUser?: true;
}

export interface Warning {
  id: string;
  message: string;
  items?: number[];
}

export type ContractLookup =
  | { status: "found"; detail?: string }
  | { status: "not_found"; detail: string }
  | { status: "unknown"; detail: string };

export interface ValidationContext {
  pages: DeclarationPages | null;
  /** The footers the model read, when the file has no text layer. */
  sheetsSeen?: { present: number[]; total: number };
  /** The INN of the company selected in the app. */
  companyInn: string | null;
  contract: ContractLookup;
  /** The base calculation value in force on a date, or null when it is not known. */
  brv: (isoDate: string) => Dec | null;
  notes: BuildNotes;
  /** Today, for a deadline that has passed. */
  today?: string;
}

/** Base calculation value (BRV) known for a date: the one the sample declaration states for its own date. */
const KNOWN_BRV: { date: string; brv: string }[] = [{ date: "2025-11-04", brv: "412000" }];

export function knownBrv(date: string): Dec | null {
  const hit = KNOWN_BRV.find((k) => k.date === date);
  return hit ? dec(hit.brv) : null;
}

const CENT = dec("0.01") as Dec;
const within = (a: Dec, b: Dec, tolerance: Dec = CENT) => cmp(abs(sub(a, b)), tolerance) <= 0;
const money = (v: Dec) => fixed(v, 2);
const list = (numbers: number[], max = 8) =>
  numbers.length > max ? `${numbers.slice(0, max).join(", ")} … (${numbers.length})` : numbers.join(", ");

const ok = (id: string, rule: string, message: string, extra: Partial<Check> = {}): Check => ({
  id,
  rule,
  ok: true,
  message,
  ...extra,
});
const fail = (id: string, rule: string, message: string, extra: Partial<Check> = {}): Check => ({
  id,
  rule,
  ok: false,
  message,
  ...extra,
});
const skipped = (id: string, rule: string, message: string): Check => ({
  id,
  rule,
  ok: true,
  skipped: true,
  message,
});

/** The sheet a declaration-level graph is on, for a re-read: the main sheet. */
const MAIN_SHEET = [1];

/** Which sheets (footer numbers) carry the items from `from` to `to`: sheet 1 has item 1, each TD-2 sheet three more. */
export function sheetsOfItems(numbers: number[]): number[] {
  const sheets = new Set<number>();
  for (const n of numbers) sheets.add(n <= 1 ? 1 : 1 + Math.ceil((n - 1) / 3));
  return [...sheets].sort((a, b) => a - b);
}

/** Customs fee in graph 47 («10»). */
export const FEE = "10";

export function validate(d: Declaration, ctx: ValidationContext): { checks: Check[]; warnings: Warning[] } {
  const checks: Check[] = [];

  // V1 — every sheet is there.
  {
    const present = ctx.pages?.footer ? ctx.pages.present : (ctx.sheetsSeen?.present ?? null);
    const total = ctx.pages?.footer ? ctx.pages.total : (ctx.sheetsSeen?.total ?? null);
    if (present === null || total === null) {
      checks.push(
        fail(
          "V1",
          "all_sheets_present",
          "no footer («Copy / … 3/ 12») could be read: the sheet count cannot be verified",
          {
            expected: "footer on every page",
            actual: "none",
            needsUser: true,
          },
        ),
      );
    } else {
      const missing: number[] = [];
      for (let n = 1; n <= total; n += 1) if (!present.includes(n)) missing.push(n);
      checks.push(
        missing.length === 0
          ? ok("V1", "all_sheets_present", `${total} of ${total}`, {
              expected: `${total}`,
              actual: `${present.length}`,
            })
          : fail(
              "V1",
              "all_sheets_present",
              `sheet ${list(missing)} of ${total} is missing: the declaration is incomplete`,
              { expected: `${total}`, actual: `${present.length}`, needsUser: true },
            ),
      );
    }
  }

  // V2 — item numbers run 1..N with no gap or repeat, and N is graph 5.
  {
    const numbers = d.items.map((i) => i.no);
    const seen = new Set<number>();
    const repeated = numbers.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    const max = numbers.length ? Math.max(...numbers) : 0;
    const gaps: number[] = [];
    for (let n = 1; n <= max; n += 1) if (!seen.has(n)) gaps.push(n);
    const declared = d.items_declared;
    const problems: string[] = [];
    if (numbers.length === 0) problems.push("no items were read");
    if (repeated.length) problems.push(`item ${list([...new Set(repeated)])} repeats`);
    if (gaps.length) problems.push(`item ${list(gaps)} is missing`);
    if (declared === null) problems.push("graph 5 (the number of items) was not read");
    else if (max !== declared || seen.size !== declared)
      problems.push(`graph 5 says ${declared} items, the items read are ${seen.size} (up to no. ${max})`);
    checks.push(
      problems.length === 0
        ? ok("V2", "item_numbers_continuous", `1..${max}, graph 5 = ${declared}`, {
            expected: `${declared}`,
            actual: `${seen.size}`,
          })
        : fail("V2", "item_numbers_continuous", problems.join("; "), {
            expected: declared === null ? undefined : `${declared}`,
            actual: `${seen.size}`,
            sheets: sheetsOfItems([...gaps, ...repeated]),
          }),
    );
  }

  // V3 — the item values add up to the invoice.
  {
    const unread = d.items.filter((i) => i.value === null).map((i) => i.no);
    if (d.invoice.amount === null) {
      checks.push(
        fail("V3", "sum_item_values_equals_invoice", "the invoice amount (graph 22) was not read", {
          sheets: MAIN_SHEET,
        }),
      );
    } else if (unread.length > 0) {
      checks.push(
        fail(
          "V3",
          "sum_item_values_equals_invoice",
          `the value (graph 42) of item ${list(unread)} was not read`,
          {
            sheets: sheetsOfItems(unread),
          },
        ),
      );
    } else {
      const total = sum(d.items.map((i) => i.value as Dec));
      const same = within(total, d.invoice.amount);
      checks.push(
        same
          ? ok("V3", "sum_item_values_equals_invoice", `${money(total)} = ${money(d.invoice.amount)}`, {
              expected: money(d.invoice.amount),
              actual: money(total),
            })
          : fail(
              "V3",
              "sum_item_values_equals_invoice",
              `the items add up to ${money(total)} but the invoice is ${money(d.invoice.amount)}: the difference is ${money(abs(sub(total, d.invoice.amount)))}. A digit of an item value or of the invoice was misread`,
              {
                expected: money(d.invoice.amount),
                actual: money(total),
                sheets: [1, ...sheetsOfItems(d.items.map((i) => i.no))],
              },
            ),
      );
    }
  }

  // V4 — invoice × rate is the customs value, and the base of the fee line.
  {
    if (d.fx_rate === null) {
      checks.push(
        fail(
          "V4",
          "invoice_times_rate_equals_customs_value",
          "the exchange rate (graph 23) was not read. The central bank's rate is not used instead: ask the accountant which rate the declaration has",
          { sheets: MAIN_SHEET, needsUser: true },
        ),
      );
    } else if (d.invoice.amount === null) {
      checks.push(
        fail("V4", "invoice_times_rate_equals_customs_value", "the invoice amount (graph 22) was not read", {
          sheets: MAIN_SHEET,
        }),
      );
    } else {
      const product = round(mul(d.invoice.amount, d.fx_rate), 2);
      // The customs value in graph 12 and the base of every declaration-level fee or duty line is that product.
      const targets: { what: string; value: Dec }[] = [];
      if (d.customs_value_uzs) targets.push({ what: "the customs value", value: d.customs_value_uzs });
      for (const c of d.charges)
        if (c.item_no === null && c.base && (c.type === FEE || c.type === "20"))
          targets.push({ what: `the base of the graph 47 line ${c.type}`, value: c.base });
      if (targets.length === 0) {
        checks.push(
          fail(
            "V4",
            "invoice_times_rate_equals_customs_value",
            "neither the customs value nor a graph 47 base was read",
            { sheets: MAIN_SHEET },
          ),
        );
      } else {
        const bad = targets.filter((t) => !within(product, t.value));
        checks.push(
          bad.length === 0
            ? ok(
                "V4",
                "invoice_times_rate_equals_customs_value",
                `${plain(d.invoice.amount)} × ${plain(d.fx_rate)} = ${money(product)}`,
                { expected: money(product), actual: money(targets[0]?.value ?? product) },
              )
            : fail(
                "V4",
                "invoice_times_rate_equals_customs_value",
                `${plain(d.invoice.amount)} × ${plain(d.fx_rate)} = ${money(product)}, but ${bad.map((t) => `${t.what} is ${money(t.value)}`).join(" and ")}`,
                { expected: money(product), actual: money(bad[0]?.value ?? product), sheets: MAIN_SHEET },
              ),
        );
      }
    }
  }

  // V5 — HS codes have ten digits.
  {
    const bad = d.items.filter((i) => i.hs === null || !/^\d{10}$/.test(i.hs)).map((i) => i.no);
    checks.push(
      bad.length === 0
        ? ok("V5", "hs_codes_have_10_digits", `${d.items.length} codes`)
        : fail(
            "V5",
            "hs_codes_have_10_digits",
            `the HS code (graph 33) of item ${list(bad)} is not ten digits`,
            {
              sheets: sheetsOfItems(bad),
            },
          ),
    );
  }

  // V6 — net weight does not exceed gross weight.
  {
    const unread = d.items.filter((i) => i.net_kg === null || i.gross_kg === null).map((i) => i.no);
    const over = d.items
      .filter((i) => i.net_kg && i.gross_kg && cmp(i.net_kg, i.gross_kg) > 0)
      .map((i) => `${i.no} (net ${plain(i.net_kg as Dec)} > gross ${plain(i.gross_kg as Dec)})`);
    if (over.length > 0)
      checks.push(
        fail("V6", "net_not_above_gross", `net weight above gross weight on item ${over.join("; ")}`, {
          sheets: sheetsOfItems(over.map((o) => Number.parseInt(o, 10))),
        }),
      );
    else if (unread.length > 0)
      checks.push(
        fail(
          "V6",
          "net_not_above_gross",
          `the weights (graphs 35, 38) of item ${list(unread)} were not read`,
          {
            sheets: sheetsOfItems(unread),
          },
        ),
      );
    else checks.push(ok("V6", "net_not_above_gross", "every item"));
  }

  // V7 — every item has the declaration's procedure.
  {
    const code = d.regime.code;
    const bad = d.items.filter((i) => procedureCode(i.procedure) !== code).map((i) => i.no);
    checks.push(
      !code
        ? skipped("V7", "items_share_procedure", "the regime is not known")
        : bad.length === 0
          ? ok("V7", "items_share_procedure", `${code} 00 on every item`)
          : fail(
              "V7",
              "items_share_procedure",
              `graph 37 of item ${list(bad)} is not the procedure ${code} of graph 1`,
              {
                sheets: sheetsOfItems(bad),
              },
            ),
    );
  }

  // V8 — the importer is the company selected in the app.
  {
    const own = (ctx.companyInn ?? "").replace(/\D/g, "");
    const importer = (d.importer.inn ?? "").replace(/\D/g, "");
    checks.push(
      !importer
        ? fail("V8", "importer_inn_matches_company", "the importer's INN (graph 8) was not read", {
            sheets: MAIN_SHEET,
          })
        : !own
          ? fail(
              "V8",
              "importer_inn_matches_company",
              "the INN of the company selected in the app is not known",
              { needsUser: true },
            )
          : importer === own
            ? ok("V8", "importer_inn_matches_company", `${importer}`, { expected: own, actual: importer })
            : fail(
                "V8",
                "importer_inn_matches_company",
                `the importer's INN is ${importer}${d.importer.name ? ` (${d.importer.name})` : ""} but the company selected is ${own}: this declaration is another company's`,
                { expected: own, actual: importer, needsUser: true },
              ),
    );
  }

  // V9 — a fee line is a multiplier of the base calculation value of the declaration's date.
  {
    const fees = d.charges.filter((c) => c.type === FEE);
    if (fees.length === 0) {
      checks.push(
        d.regime.kind === "customs_warehouse"
          ? fail(
              "V9",
              "fee_equals_rate_times_brv",
              "an IM 74 declaration has the customs fee as its only charge, and no such line (type 10) was read",
              { sheets: MAIN_SHEET },
            )
          : skipped("V9", "fee_equals_rate_times_brv", "no customs fee line"),
      );
    } else {
      const problems: string[] = [];
      const brvDate = d.date ? ctx.brv(d.date) : null;
      let confirmed = true;
      for (const fee of fees) {
        const rate = parseFeeRate(fee.rate_text);
        if (!rate) {
          problems.push(
            `the rate of the fee line («${fee.rate_text ?? ""}») is not «multiplier × base value»`,
          );
          continue;
        }
        if (fee.amount === null) {
          problems.push("the amount of the fee line was not read");
          continue;
        }
        const expected = round(mul(rate.multiplier, rate.brv), 2);
        if (!within(expected, fee.amount))
          problems.push(
            `${plain(rate.multiplier)} × ${plain(rate.brv)} = ${money(expected)} but the fee line says ${money(fee.amount)}`,
          );
        if (brvDate && cmp(brvDate, rate.brv) !== 0)
          problems.push(
            `the base calculation value in force on ${d.date} is ${plain(brvDate)}, the declaration uses ${plain(rate.brv)}`,
          );
        if (!brvDate) confirmed = false;
      }
      const first = fees[0];
      checks.push(
        problems.length === 0
          ? ok(
              "V9",
              "fee_equals_rate_times_brv",
              `${first?.rate_text ?? ""} = ${first?.amount ? money(first.amount) : ""}${confirmed ? "" : " (the base value is as the declaration states it)"}`,
            )
          : fail("V9", "fee_equals_rate_times_brv", problems.join("; "), { sheets: MAIN_SHEET }),
      );
    }
  }

  // V10 — graph 46 is the item value over a thousand (USD).
  {
    if (d.invoice.currency !== "USD") {
      checks.push(
        skipped(
          "V10",
          "statistical_value_matches",
          "the invoice is not in USD: graph 46 is not the item value over a thousand",
        ),
      );
    } else {
      const bad = d.items
        .filter((i) => i.value && i.statistical_value)
        .filter((i) => {
          const expected = mulDiv(i.value as Dec, dec("1") as Dec, dec("1000") as Dec, 6) as Dec;
          const tolerance =
            cmp(mul(expected, dec("0.005") as Dec), dec("0.006") as Dec) > 0
              ? mul(expected, dec("0.005") as Dec)
              : (dec("0.006") as Dec);
          return !within(expected, i.statistical_value as Dec, tolerance);
        })
        .map((i) => i.no);
      const unread = d.items.filter((i) => !i.statistical_value).length;
      checks.push(
        bad.length > 0
          ? fail(
              "V10",
              "statistical_value_matches",
              `graph 46 of item ${list(bad)} is not about its value over a thousand`,
              {
                sheets: sheetsOfItems(bad),
              },
            )
          : unread === d.items.length
            ? skipped("V10", "statistical_value_matches", "graph 46 was not read")
            : ok("V10", "statistical_value_matches", `${d.items.length - unread} items`),
      );
    }
  }

  // V11 — IM 74: the warehouse and its deadline.
  {
    if (d.regime.kind !== "customs_warehouse")
      checks.push(skipped("V11", "warehouse_data_present", "not a customs warehouse declaration"));
    else {
      const w = d.warehouse;
      const problems: string[] = [];
      if (!w?.licence) problems.push("graph 49 (the warehouse) was not read");
      if (!w?.release_deadline)
        problems.push("graph 50 (the deadline to place the goods under another regime) was not read");
      else if (d.date && /^\d{4}-\d{2}-\d{2}$/.test(w.release_deadline) && w.release_deadline <= d.date)
        problems.push(`the deadline ${w.release_deadline} is not after the declaration date ${d.date}`);
      checks.push(
        problems.length === 0
          ? ok("V11", "warehouse_data_present", `${w?.licence ?? ""}; ${w?.release_deadline ?? ""}`)
          : fail("V11", "warehouse_data_present", problems.join("; "), { sheets: MAIN_SHEET }),
      );
    }
  }

  // V12 — the contract is in 1C for this supplier.
  {
    if (!d.contract.no)
      checks.push(
        fail("V12", "contract_exists_in_1c", "the contract number (graph 44, code 202) was not read", {
          sheets: MAIN_SHEET,
        }),
      );
    else if (ctx.contract.status === "found")
      checks.push(ok("V12", "contract_exists_in_1c", ctx.contract.detail ?? `contract ${d.contract.no}`));
    else checks.push(fail("V12", "contract_exists_in_1c", ctx.contract.detail, { needsUser: true }));
  }

  return { checks, warnings: warnings(d, ctx) };
}

/** «2.5 x 412000», «2.5 UZS (412 000)», «2,5 × 412000»: the multiplier and the base calculation value. */
export function parseFeeRate(text: string | null): { multiplier: Dec; brv: Dec } | null {
  if (!text) return null;
  const numbers = [...text.matchAll(/\d[\d\s\u00a0]*(?:[.,]\d+)?/g)].map((m) =>
    m[0].replace(/[\s\u00a0]/g, ""),
  );
  const parsed = numbers.map((n) => dec(n)).filter((n): n is Dec => n !== null);
  if (parsed.length < 2) return null;
  const multiplier = parsed[0] as Dec;
  const brv = parsed[parsed.length - 1] as Dec;
  return cmp(brv, dec("1000") as Dec) >= 0 && cmp(multiplier, brv) < 0 ? { multiplier, brv } : null;
}

// ---- warnings ----

const normalName = (n: string | null) =>
  (n ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Descriptions whose HS heading the program knows well enough to doubt a declaration: a short list, each entry with its
 * reason, to the best of the spec's knowledge. The broker confirms; this only points.
 */
const HS_DOUBTS: { text: RegExp; headings?: string[]; notHeadings?: string[]; why: string }[] = [
  {
    text: /tungsten|carbide|вольфрам|карбид/iu,
    notHeadings: ["8001"],
    why: "heading 8001 is unwrought tin, not tungsten carbide",
  },
  {
    text: /(?<![\p{L}])burrs?(?![\p{L}])|(?<![\p{L}])burs?(?![\p{L}])|борфрез|бор-фрез/iu,
    headings: ["6804", "8207", "8466", "8467"],
    why: "burs are tools (headings 6804, 8207, 8466, 8467), not chemicals",
  },
];

export function warnings(d: Declaration, ctx: ValidationContext): Warning[] {
  const out: Warning[] = [];

  // W1 — the HS code does not fit the description.
  {
    const doubts = new Map<number, string[]>();
    const note = (item: Item, why: string) => doubts.set(item.no, [...(doubts.get(item.no) ?? []), why]);
    for (const item of d.items) {
      const heading = (item.hs ?? "").slice(0, 4);
      const description = `${item.name_en ?? ""} ${item.name_ru ?? ""}`;
      for (const rule of HS_DOUBTS) {
        if (!rule.text.test(description)) continue;
        if (rule.notHeadings?.includes(heading)) note(item, `${item.hs}: ${rule.why}`);
        else if (rule.headings && heading && !rule.headings.includes(heading))
          note(item, `${item.hs}: ${rule.why}`);
      }
    }
    // The same description under two codes: one of them is a slip in the description or in the code.
    const byName = new Map<string, Item[]>();
    for (const item of d.items) {
      const key = normalName(item.name_en);
      if (key) byName.set(key, [...(byName.get(key) ?? []), item]);
    }
    for (const group of byName.values()) {
      const codes = [...new Set(group.map((i) => i.hs))];
      if (codes.length < 2) continue;
      for (const item of group) {
        const others = group.filter((i) => i.hs !== item.hs);
        note(
          item,
          `same description as item ${list(others.map((o) => o.no))} but another code (${item.hs} against ${[...new Set(others.map((o) => o.hs ?? "?"))].join(", ")})`,
        );
      }
    }
    if (doubts.size > 0)
      out.push({
        id: "W1",
        message: `HS code and description look inconsistent: ${[...doubts]
          .map(([no, why]) => `item ${no}: ${why.join("; ")}`)
          .join(" | ")}. Ask the broker before treating the code as reliable for duty`,
        items: [...doubts.keys()],
      });
  }

  // W2 — used goods.
  {
    const used = d.items.filter((i) => i.condition === "used");
    if (used.length > 0) {
      const shared = used.flatMap((u) =>
        d.items.filter((i) => i.condition === "new" && i.hs === u.hs).map((i) => i.no),
      );
      out.push({
        id: "W2",
        message: `used goods (Б/у): item ${list(used.map((i) => i.no))}. Keep them as separate nomenclature${shared.length ? ` from the new item ${list([...new Set(shared)])} with the same HS code` : ""}`,
        items: used.map((i) => i.no),
      });
    }
  }

  // W3 — repeated descriptions: one line per item, never merged.
  {
    const groups = new Map<string, Item[]>();
    for (const item of d.items) {
      const key = normalName(item.name_en);
      if (key) groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const repeated = [...groups.values()].filter((g) => g.length > 1);
    if (repeated.length > 0)
      out.push({
        id: "W3",
        message: `repeated descriptions, kept as one line per item number (values and weights differ): ${repeated
          .map((g) => `«${g[0]?.name_en}» item ${list(g.map((i) => i.no))}`)
          .join("; ")}`,
        items: repeated.flatMap((g) => g.map((i) => i.no)),
      });
  }

  // W4 — a missing exchange rate is never filled from the central bank silently.
  if (d.fx_rate === null)
    out.push({
      id: "W4",
      message:
        "the exchange rate (graph 23) is missing: do not use the central bank's rate silently, ask the accountant",
    });

  // Reading notes: what the merge of the two readings noticed.
  const notes: string[] = [];
  if (ctx.notes.unreadable.length) notes.push(`not numbers: ${ctx.notes.unreadable.join("; ")}`);
  if (ctx.notes.nameless.length)
    notes.push(`no description text for item ${list(ctx.notes.nameless)} (needed to match the nomenclature)`);
  notes.push(...ctx.notes.headerConflicts);
  if (ctx.pages?.foreign.length)
    notes.push(
      `pages of another declaration in the file: ${ctx.pages.foreign.map((f) => `page ${f.page} (${f.declarationNo})`).join(", ")}`,
    );
  if (ctx.pages?.conflicts.length) notes.push(...ctx.pages.conflicts);
  if (ctx.pages && ctx.pages.unmarked.length)
    notes.push(`pages with no readable footer: ${list(ctx.pages.unmarked)}`);
  if (d.date && !ctx.brv(d.date) && d.charges.some((c) => c.type === FEE))
    notes.push(
      `the base calculation value for ${d.date} is not in the program's table: the fee is judged by the value the declaration states`,
    );
  if (notes.length > 0) out.push({ id: "W5", message: `reading notes: ${notes.join(" | ")}` });
  return out;
}
