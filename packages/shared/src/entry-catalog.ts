/**
 * The catalog of accounting entries: what the engine knows about which accounts pair, which 1C document makes the entry and which
 * book row says so (Accounting engine - knowledge completion, TD §4). Structure only: a rate, a limit or a deadline is never here
 * (those stay in the dated tables of `engine/tax-tables.ts`).
 *
 * A rule's `status` says what it may be used for: `parsed` is the machine's reading (a known pair for the entry check, nothing
 * else); `checked` means a person compared it with the book's page; `wired` means a workflow uses it and a test proves it;
 * `company` means the company's own accountant confirmed it. Only `checked` and above may decide an account.
 */
import { z } from "zod";

const Code4 = z.string().regex(/^\d{4}$/);

/** One account, a range (0110-0190) or several accounts of the same line (4110, 4120). */
export const AccountSpec = z.union([
  z.object({ code: Code4 }),
  z.object({ from: Code4, to: Code4 }),
  z.object({ anyOf: z.array(Code4).min(2) }),
]);
export type AccountSpec = z.infer<typeof AccountSpec>;

/** What the amount of an entry line is: the price without VAT, the VAT, the cost, a fee… */
export const EntryBasis = z.enum(["gross", "net", "vat", "cost", "fee", "withheld", "difference", "other"]);

export const EntryLine = z.object({
  dt: AccountSpec,
  cr: AccountSpec,
  basis: EntryBasis,
});
export type EntryLine = z.infer<typeof EntryLine>;

export const ENTRY_FAMILIES = [
  "income_expense",
  "cash_bank",
  "fixed_assets",
  "stock",
  "loans",
  "capital",
  "production",
  "settlements",
  "taxes",
  "payroll",
] as const;
export const EntryFamily = z.enum(ENTRY_FAMILIES);
export type EntryFamily = z.infer<typeof EntryFamily>;

export const EntryStatus = z.enum(["parsed", "checked", "wired", "company"]);
export type EntryStatus = z.infer<typeof EntryStatus>;

export const EntryRule = z.object({
  /** The book, the page and the number: "b1-p89-n21". */
  id: z.string(),
  family: EntryFamily,
  /** A stable key such as "sale_products". */
  operation: z.string(),
  title: z.object({ uz: z.string(), en: z.string() }),
  trigger: z.object({
    source: z.enum(["bank_line", "cash_order", "document", "period_close", "manual"]),
    kind: z.string().optional(),
  }),
  /** The 1C document that carries the entry, and its operation type when it has several. */
  document: z.object({ onec: z.string(), operationType: z.string().optional() }).optional(),
  lines: z.array(EntryLine).min(1),
  /** The papers the book names as support for the entry. */
  support: z.array(z.string()),
  /** The operation this rule is another way of booking (cash from the bank direct, or through the transit account). */
  variantOf: z.string().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  source: z.object({ book: z.enum(["B1", "B2", "B3", "B4"]), page: z.number(), row: z.number() }).optional(),
  /** Why a rule has no row in the book (a recorded exception), when `source` is absent. */
  noSource: z.string().optional(),
  status: EntryStatus,
  confirm: z.string().optional(),
});
export type EntryRule = z.infer<typeof EntryRule>;

/** Statuses a rule may decide an account with. */
export const DECIDING_STATUSES: readonly EntryStatus[] = ["checked", "wired", "company"];
export const mayDecide = (rule: EntryRule): boolean => DECIDING_STATUSES.includes(rule.status);

const num = (code: string) => Number(code);

/** Whether the spec covers this code; a group code (2900, 4300) is covered when any account of the group is. */
export function specCovers(spec: AccountSpec, code: string): boolean {
  const covers = (c: string) =>
    "code" in spec
      ? spec.code === c
      : "anyOf" in spec
        ? spec.anyOf.includes(c)
        : num(c) >= num(spec.from) && num(c) <= num(spec.to);
  if (covers(code)) return true;
  // A group code stands for the accounts under it: 2900 for 2910…2990.
  const stem = code.replace(/0+$/, "");
  if (stem.length === 0 || stem.length === code.length) return false;
  const under = (c: string) => c.startsWith(stem);
  if ("code" in spec) return under(spec.code);
  if ("anyOf" in spec) return spec.anyOf.some(under);
  return num(spec.to) >= num(stem.padEnd(4, "0")) && num(spec.from) <= num(stem.padEnd(4, "9"));
}

/** Whether the spec has an account that starts with the first three digits of the code (a finer sub-account than the book's). */
function specNear(spec: AccountSpec, code: string): boolean {
  const stem = code.slice(0, 3);
  if ("code" in spec) return spec.code.startsWith(stem);
  if ("anyOf" in spec) return spec.anyOf.some((c) => c.startsWith(stem));
  return num(spec.from.slice(0, 3)) <= num(stem) && num(spec.to.slice(0, 3)) >= num(stem);
}

/** `exact`: some line of the catalog has this pair at four digits; `near`: only at three (a finer sub-account); null: unknown. */
export function knownPair(rules: readonly EntryRule[], dt: string, cr: string): "exact" | "near" | null {
  let near = false;
  for (const rule of rules) {
    for (const line of rule.lines) {
      if (specCovers(line.dt, dt) && specCovers(line.cr, cr)) return "exact";
      if (specNear(line.dt, dt) && specNear(line.cr, cr)) near = true;
    }
  }
  return near ? "near" : null;
}

/** The numbers a rule's data must not carry (TD K6): a percentage, a limit, a deadline belong in the dated tables. */
export function carriesNumbers(rule: EntryRule): boolean {
  const text = JSON.stringify({ title: rule.title, confirm: rule.confirm ?? "", support: rule.support });
  return /\d\s*%|\b\d{1,3}(?:[ ,]\d{3})+\b/.test(text);
}
