import type { Lang } from "../router.js";
import type { Unclassified } from "./classify.js";
import type { BankResolved } from "./resolve.js";

/** What the first look at a statement found missing in 1C, in the words the accountant wrote in. */
export interface BankGaps {
  /** Payments that can be entered as they stand. */
  ready: number;
  counterparties: string[];
  contracts: string[];
  /** Rows the program cannot settle: the reason and how many rows. */
  problems: { message: string; rows: number }[];
  /** Lines that were not identified with certainty and are not written: the reason and how many lines. */
  unclassified: { why: string; rows: number }[];
  /** Moves between the company's own accounts (and conversions) the program could not make: the reason and how many legs. */
  transfers: { message: string; rows: number }[];
}

const SHOWN = 8;

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
): BankGaps {
  const counterparties = new Map<string, string>();
  const contracts = new Map<string, string>();
  const problems = new Map<string, number>();
  let ready = 0;
  for (const r of resolved) {
    ready += r.ready.length;
    for (const m of r.missing)
      counterparties.set(m.key, m.key.startsWith("name:") ? m.name : `${m.name} (${m.inn})`);
    for (const c of r.contractsToCreate) contracts.set(c.label, c.label);
    for (const p of r.problems) problems.set(p.message, (problems.get(p.message) ?? 0) + p.rows.length);
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
    problems: [...problems].map(([message, rows]) => ({ message, rows })),
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
    for (const p of gaps.problems.slice(0, SHOWN)) lines.push(`   – ${p.message} (${w.rows(p.rows)})`);
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
