import type { Lang } from "../router.js";
import type { Unclassified } from "./classify.js";
import type { BankResolved } from "./resolve.js";
import type { BankPayment } from "./statement.js";

/** What the first look at a statement found missing in 1C, in the words the accountant wrote in. */
export interface BankGaps {
  /** Payments that can be entered as they stand. */
  ready: number;
  counterparties: string[];
  contracts: string[];
  /** Rows the program cannot settle: the reason and how many rows. */
  problems: { message: string; rows: number; examples?: string[] }[];
  /** Lines that were not identified with certainty and are not written: the reason and how many lines. */
  unclassified: { why: string; rows: number }[];
  /** Moves between the company's own accounts (and conversions) the program could not make: the reason and how many legs. */
  transfers: { message: string; rows: number }[];
}

const SHOWN = 8;
/** How many lines of a kind are shown by their date, sum, name and words, so the accountant can find them in the statement. */
const EXAMPLES = 3;

const exampleOf = (p: BankPayment): string =>
  `${p.date.slice(0, 10)} ${p.direction === "in" ? "+" : "−"}${(p.amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${p.counterparty.trim().slice(0, 40)} — ${p.purpose.replace(/\s+/g, " ").trim().slice(0, 90)}`;

const WORDS = {
  ru: {
    head: (ready: number) => `Выписка прочитана: готово к вводу ${ready}. Чего не хватает в 1С:`,
    counterparties: "Контрагенты",
    contracts: "Договоры",
    problems: "Строки, которые программа не может разобрать",
    unclassified: "Строки, тип которых не определён с уверенностью (не записываются, решает бухгалтер)",
    transfers: "Переводы и конвертации между своими счетами, которые программа не смогла ввести",
    rows: (n: number) => `строк: ${n}`,
    more: (n: number) => `и ещё ${n}`,
    next: "Для недостающих контрагентов и договоров сейчас покажу карточку на создание.",
  },
  uz: {
    head: (ready: number) => `Ko'chirma o'qildi: kiritishga tayyor ${ready} ta. 1C da yetishmaydi:`,
    counterparties: "Kontragentlar",
    contracts: "Shartnomalar",
    problems: "Dastur hal qila olmagan qatorlar",
    unclassified: "Turi ishonch bilan aniqlanmagan qatorlar (yozilmaydi, buxgalter hal qiladi)",
    transfers: "O'z hisoblari orasidagi o'tkazma va konvertatsiyalar, dastur kirita olmaganlari",
    rows: (n: number) => `qator: ${n}`,
    more: (n: number) => `va yana ${n} ta`,
    next: "Yetishmayotgan kontragent va shartnomalar uchun hozir yaratish kartochkasini ko'rsataman.",
  },
  en: {
    head: (ready: number) => `Statement read: ${ready} ready to enter. Missing in 1C:`,
    counterparties: "Counterparties",
    contracts: "Contracts",
    problems: "Rows the program cannot settle",
    unclassified: "Lines whose kind is not certain (not written; the accountant decides)",
    transfers: "Moves and conversions between own accounts the program could not enter",
    rows: (n: number) => `rows: ${n}`,
    more: (n: number) => `and ${n} more`,
    next: "I will now show a card to create the missing counterparties and contracts.",
  },
} as const;

export function gapsOf(
  resolved: Pick<BankResolved, "missing" | "contractsToCreate" | "problems" | "ready">[],
  held: Pick<Unclassified, "why">[] = [],
  transferProblems: { message: string }[] = [],
  /** The payments each of `resolved` was made from (the same order): the problem rows are shown by what they say. */
  payments: BankPayment[][] = [],
): BankGaps {
  const counterparties = new Map<string, string>();
  const contracts = new Map<string, string>();
  const problems = new Map<string, { rows: number; examples: string[] }>();
  let ready = 0;
  for (const [i, r] of resolved.entries()) {
    ready += r.ready.length;
    for (const m of r.missing)
      counterparties.set(m.key, m.key.startsWith("name:") ? m.name : `${m.name} (${m.inn})`);
    for (const c of r.contractsToCreate) contracts.set(c.label, c.label);
    for (const p of r.problems) {
      const known = problems.get(p.message) ?? { rows: 0, examples: [] };
      known.rows += p.rows.length;
      for (const row of p.rows) {
        const payment = payments[i]?.find((x) => x.row === row);
        if (payment && known.examples.length < EXAMPLES) known.examples.push(exampleOf(payment));
      }
      problems.set(p.message, known);
    }
  }
  const unclassified = new Map<string, number>();
  for (const h of held) unclassified.set(h.why, (unclassified.get(h.why) ?? 0) + 1);
  const transfers = new Map<string, number>();
  for (const t of transferProblems) transfers.set(t.message, (transfers.get(t.message) ?? 0) + 1);
  return {
    ready,
    unclassified: [...unclassified].map(([why, rows]) => ({ why, rows })),
    transfers: [...transfers].map(([message, rows]) => ({ message, rows })),
    counterparties: [...counterparties.values()],
    contracts: [...contracts.values()],
    problems: [...problems].map(([message, v]) => ({
      message,
      rows: v.rows,
      ...(v.examples.length > 0 ? { examples: v.examples } : {}),
    })),
  };
}

/** The list shown the moment the statement is read, before any card or any model step. Empty when nothing is missing. */
export function gapsText(lang: Lang, gaps: BankGaps): string {
  const w = WORDS[lang];
  const list = (items: string[]) =>
    items.slice(0, SHOWN).join(", ") + (items.length > SHOWN ? `, ${w.more(items.length - SHOWN)}` : "");
  const lines: string[] = [];
  if (gaps.counterparties.length > 0)
    lines.push(`• ${w.counterparties} (${gaps.counterparties.length}): ${list(gaps.counterparties)}`);
  if (gaps.contracts.length > 0)
    lines.push(`• ${w.contracts} (${gaps.contracts.length}): ${list(gaps.contracts)}`);
  if (gaps.problems.length > 0) {
    lines.push(`• ${w.problems} (${gaps.problems.reduce((n, p) => n + p.rows, 0)}):`);
    for (const p of gaps.problems.slice(0, SHOWN)) {
      lines.push(`   – ${p.message} (${w.rows(p.rows)})`);
      for (const e of p.examples ?? []) lines.push(`        · ${e}`);
    }
    if (gaps.problems.length > SHOWN) lines.push(`   – ${w.more(gaps.problems.length - SHOWN)}`);
  }
  if (gaps.transfers.length > 0) {
    lines.push(`• ${w.transfers} (${gaps.transfers.reduce((n, p) => n + p.rows, 0)}):`);
    for (const t of gaps.transfers.slice(0, SHOWN)) lines.push(`   – ${t.message} (${w.rows(t.rows)})`);
    if (gaps.transfers.length > SHOWN) lines.push(`   – ${w.more(gaps.transfers.length - SHOWN)}`);
  }
  if (gaps.unclassified.length > 0) {
    lines.push(`• ${w.unclassified} (${gaps.unclassified.reduce((n, p) => n + p.rows, 0)}):`);
    for (const u of gaps.unclassified.slice(0, SHOWN)) lines.push(`   – ${u.why} (${w.rows(u.rows)})`);
    if (gaps.unclassified.length > SHOWN) lines.push(`   – ${w.more(gaps.unclassified.length - SHOWN)}`);
  }
  if (lines.length === 0) return "";
  const creates = gaps.counterparties.length > 0 || gaps.contracts.length > 0;
  return [w.head(gaps.ready), ...lines, ...(creates ? ["", w.next] : []), "", ""].join("\n");
}
