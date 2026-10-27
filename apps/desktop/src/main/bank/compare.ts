/**
 * The statements against the bank documents of 1C, row by row (no AI, whole tiyin). The statements are the truth about what the
 * bank did; each row says which documents 1C must have for it:
 *
 *  - a payment, a tax or a bank fee (also a fee paid to the bank's transit account) is one document on the statement's account;
 *  - a move between two of the company's own accounts (a block of money for a conversion, and its return) is one operation of two
 *    documents, a write-off where the money left and a receipt where it came, one on each account, never more;
 *  - the rows of a pass-through account are the other legs of payments in the other statements, not payments of their own.
 *    What each row is comes from the same reading the import uses (ledger.ts).
 *
 * The expected documents are laid against the documents 1C has (the same account, direction, day and amount; the bank's number
 * breaks a tie). What does not meet is reported with the likeliest reason: a document missing (the row was never entered, or
 * entered on another account or in the other direction), an extra one (entered twice, or nothing in the statements stands
 * behind it). Each account then gets its turnover from the statements and from 1C side by side, which is where a doubled
 * amount shows first.
 */
import type { BankDoc } from "./duplicates.js";
import { currencyOfAccount, planLedger } from "./ledger.js";
import type { BankPayment, BankStatement } from "./statement.js";

const day = (iso: string) => iso.slice(0, 10);
const digits = (s: string) => s.replace(/\D/g, "");

export interface Leg {
  account: string;
  direction: "in" | "out";
  day: string;
  /** Tiyin. */
  cents: number;
}

export interface RowVerdict {
  file: string;
  row: number;
  /** The statement's own account. */
  account: string;
  day: string;
  direction: "in" | "out";
  cents: number;
  number: string;
  counterparty: string;
  purpose: string;
  /** A move between two accounts of the company, or an ordinary payment. */
  kind: "payment" | "own_move";
  /** What 1C must have for this row, and the document it has for each (null: none). */
  legs: { leg: Leg; mirror: boolean; doc: BankDoc | null }[];
  status: "ok" | "missing" | "partial";
}

export interface ExtraDoc {
  doc: BankDoc;
  /**
   * duplicate: the documents of this account, day, amount and direction outnumber what the statements ask for;
   * wrong_place: a document the statements want for the same day and amount sits on another account or in the other
   *   direction (the statement's row it looks like is named);
   * no_row: nothing in the statements stands behind it.
   */
  reason: "duplicate" | "wrong_place" | "no_row";
  /** For wrong_place: the leg it was probably meant to be. */
  meant?: Leg;
}

export interface AccountTurnover {
  account: string;
  /** Tiyin: what the statements say came in and went out of the account, and what 1C holds in its documents. */
  statement: { in: number; out: number };
  books: { in: number; out: number };
  /** books − statement, per direction. */
  difference: { in: number; out: number };
}

export interface Comparison {
  rows: RowVerdict[];
  extra: ExtraDoc[];
  accounts: AccountTurnover[];
  summary: {
    rows: number;
    ok: number;
    missing: number;
    partial: number;
    extra: number;
    /** Documents on accounts no statement is for or that no leg is expected on: not judged. */
    unjudged: number;
  };
}

const keyOf = (l: Leg) => `${l.account}|${l.direction}|${l.day}|${l.cents}`;

interface Draft {
  verdict: RowVerdict;
}

/**
 * Compares the statements with the bank documents of 1C. `ownInn` is the company's INN. What each row is comes from the same
 * reading the import uses (ledger.ts), so the comparison asks of 1C what the import would have entered: a payment, a tax or
 * a bank fee (also a fee to the bank's transit account) is one document; a move between two of the company's accounts is one
 * document on each; the rows of a pass-through account are the other legs of payments in the other statements.
 */
export function compareWithBooks(statements: BankStatement[], docs: BankDoc[], ownInn: string): Comparison {
  const plan = planLedger(statements, { ownInn });
  const accounts = new Set(statements.map((s) => digits(s.account)).filter(Boolean));
  const drafts: Draft[] = [];
  const draft = (s: BankStatement, p: BankPayment, kind: RowVerdict["kind"]): Draft => {
    const account = digits(s.account);
    const leg: Leg = { account, direction: p.direction, day: day(p.date), cents: Math.round(p.amount) };
    const d: Draft = {
      verdict: {
        file: s.fileName,
        row: p.row,
        account,
        day: leg.day,
        direction: p.direction,
        cents: leg.cents,
        number: p.number.trim(),
        counterparty: p.counterparty,
        purpose: p.purpose,
        kind,
        legs: [{ leg, mirror: false, doc: null }],
        status: "missing",
      },
    };
    drafts.push(d);
    return d;
  };
  const byFile = new Map(statements.map((s) => [s.fileName, s]));
  for (const s of statements) {
    if (!digits(s.account)) continue;
    const wanted = new Set(plan.rows.get(s.fileName) ?? []);
    for (const p of s.payments) if (wanted.has(p.row)) draft(s, p, "payment");
  }
  for (const t of plan.transfers) {
    const sides = [
      { side: "out" as const, at: t.out },
      { side: "in" as const, at: t.in },
    ];
    const present = sides.filter((x) => x.at);
    for (const { side, at } of present) {
      const s = at ? byFile.get(at.file) : undefined;
      const p = s?.payments.find((x) => x.row === at?.row);
      if (!s || !p) continue;
      const d = draft(s, p, "own_move");
      // One side only, a plain soum move: the import makes the other side from this row (transfer.ts); an own account whose
      // statement is not attached, and a conversion, are not completed.
      const soums = currencyOfAccount(t.fromAccount) === "UZS" && currencyOfAccount(t.toAccount) === "UZS";
      if (present.length === 1 && !t.fx && t.kind !== "unattached_own" && soums) {
        d.verdict.legs.push({
          leg: {
            account: digits(side === "out" ? t.toAccount : t.fromAccount),
            direction: side === "out" ? "in" : "out",
            day: d.verdict.day,
            cents: d.verdict.cents,
          },
          mirror: true,
          doc: null,
        });
      }
    }
  }

  // The documents of 1C, by what they stand for.
  const pool = new Map<string, BankDoc[]>();
  for (const doc of docs) {
    const key = keyOf({
      account: digits(doc.account),
      direction: doc.direction,
      day: doc.day,
      cents: doc.cents,
    });
    pool.set(key, [...(pool.get(key) ?? []), doc]);
  }
  const expectedAccounts = new Set<string>(accounts);
  for (const d of drafts) for (const l of d.verdict.legs) expectedAccounts.add(l.leg.account);

  // Each leg takes a document: the one that carries the row's bank number first, then the first of the key.
  const wanted = drafts.flatMap((d) => d.verdict.legs.map((l) => ({ d, l })));
  const used = new Set<BankDoc>();
  for (const { d, l } of wanted) {
    const list = pool.get(keyOf(l.leg)) ?? [];
    const fit =
      list.find(
        (x) => !used.has(x) && d.verdict.number !== "" && !l.mirror && x.incoming === d.verdict.number,
      ) ?? list.find((x) => !used.has(x));
    if (fit) {
      used.add(fit);
      l.doc = fit;
    }
  }
  for (const d of drafts) {
    const found = d.verdict.legs.filter((l) => l.doc).length;
    d.verdict.status = found === d.verdict.legs.length ? "ok" : found === 0 ? "missing" : "partial";
  }

  // What is left over: extra documents, told apart by what could have been meant.
  const lost = wanted.filter(({ l }) => !l.doc).map(({ l }) => l.leg);
  const extra: ExtraDoc[] = [];
  let unjudged = 0;
  const asked = new Set(wanted.map(({ l }) => keyOf(l.leg)));
  // Rows of the statements the import does not enter on its own (the soum leg of a conversion whose currency statement is not
  // attached, a row of a pass-through account): a document of 1C that stands for one of them is not extra.
  const unmade = new Map<string, number>();
  for (const s of statements) {
    const account = digits(s.account);
    if (!account) continue;
    for (const p of s.payments) {
      const key = keyOf({ account, direction: p.direction, day: day(p.date), cents: Math.round(p.amount) });
      unmade.set(key, (unmade.get(key) ?? 0) + 1);
    }
  }
  for (const { l } of wanted) {
    if (l.mirror) continue;
    const key = keyOf(l.leg);
    unmade.set(key, (unmade.get(key) ?? 0) - 1);
  }
  const explained: BankDoc[] = [];
  for (const doc of docs) {
    if (used.has(doc)) continue;
    const account = digits(doc.account);
    if (!expectedAccounts.has(account)) {
      unjudged += 1;
      continue;
    }
    const key = keyOf({ account, direction: doc.direction, day: doc.day, cents: doc.cents });
    if ((unmade.get(key) ?? 0) > 0) {
      unmade.set(key, (unmade.get(key) ?? 0) - 1);
      explained.push(doc);
      unjudged += 1;
      continue;
    }
    if (asked.has(key)) {
      extra.push({ doc, reason: "duplicate" });
      continue;
    }
    const meant = lost.find((l) => l.day === doc.day && l.cents === doc.cents);
    extra.push(meant ? { doc, reason: "wrong_place", meant } : { doc, reason: "no_row" });
  }

  // Turnover per account: what the statements and the expected legs say, against what 1C holds.
  const turnover = new Map<string, AccountTurnover>();
  const at = (account: string) => {
    let t = turnover.get(account);
    if (!t) {
      t = { account, statement: { in: 0, out: 0 }, books: { in: 0, out: 0 }, difference: { in: 0, out: 0 } };
      turnover.set(account, t);
    }
    return t;
  };
  for (const { l } of wanted) at(l.leg.account).statement[l.leg.direction] += l.leg.cents;
  for (const doc of explained) at(digits(doc.account)).statement[doc.direction] += doc.cents;
  for (const doc of docs) {
    const account = digits(doc.account);
    if (expectedAccounts.has(account)) at(account).books[doc.direction] += doc.cents;
  }
  const list = [...turnover.values()].sort((a, b) => a.account.localeCompare(b.account));
  for (const t of list)
    t.difference = { in: t.books.in - t.statement.in, out: t.books.out - t.statement.out };

  const verdicts = drafts.map((d) => d.verdict);
  return {
    rows: verdicts,
    extra,
    accounts: list,
    summary: {
      rows: verdicts.length,
      ok: verdicts.filter((v) => v.status === "ok").length,
      missing: verdicts.filter((v) => v.status === "missing").length,
      partial: verdicts.filter((v) => v.status === "partial").length,
      extra: extra.length,
      unjudged,
    },
  };
}

type Lang = "ru" | "uz" | "en";

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }).replace(/,/g, " ");
const signed = (cents: number) => `${cents > 0 ? "+" : ""}${money(cents)}`;
const dmy = (iso: string) => iso.split("-").reverse().join(".");

const WORDS = {
  ru: {
    title: "Сверка выписки с 1С",
    allOk: "Всё сходится: каждой строке выписки есть документ в 1С, лишних нет.",
    summary: (c: Comparison["summary"]) =>
      `Строк в выписке: ${c.rows}. Есть в 1С: ${c.ok}. Нет документа: ${c.missing}. Неполно (не хватает второй стороны перевода): ${c.partial}. Лишних документов: ${c.extra}.`,
    missing: "Нет в 1С",
    partial: "Введено не полностью",
    extra: "Лишние документы 1С",
    accounts: "Обороты по счетам (1С − выписка)",
    move: "перевод между своими счетами",
    leg: (a: string, dir: string) => `${dir === "in" ? "поступление" : "списание"} на счёте ${a}`,
    why: {
      duplicate: "введён повторно",
      wrong_place: "похоже на ожидаемый документ, но на другом счёте или в другую сторону",
      no_row: "в выписках нет строки для него",
    },
    meant: (l: Leg) => `ожидался: ${l.direction === "in" ? "поступление" : "списание"} на счёте ${l.account}`,
  },
  uz: {
    title: "Ko'chirmani 1C bilan solishtirish",
    allOk: "Hammasi mos: ko'chirmaning har bir qatoriga 1C da hujjat bor, ortiqchasi yo'q.",
    summary: (c: Comparison["summary"]) =>
      `Ko'chirmada qatorlar: ${c.rows}. 1C da bor: ${c.ok}. Hujjat yo'q: ${c.missing}. To'liq emas (o'tkazmaning ikkinchi tomoni yo'q): ${c.partial}. Ortiqcha hujjatlar: ${c.extra}.`,
    missing: "1C da yo'q",
    partial: "To'liq kiritilmagan",
    extra: "1C dagi ortiqcha hujjatlar",
    accounts: "Hisoblar bo'yicha aylanma (1C − ko'chirma)",
    move: "o'z hisoblari orasidagi o'tkazma",
    leg: (a: string, dir: string) => `${a} hisobida ${dir === "in" ? "kirim" : "chiqim"}`,
    why: {
      duplicate: "ikki marta kiritilgan",
      wrong_place: "kutilgan hujjatga o'xshaydi, lekin boshqa hisobda yoki teskari yo'nalishda",
      no_row: "ko'chirmalarda unga qator yo'q",
    },
    meant: (l: Leg) => `kutilgan: ${l.account} hisobida ${l.direction === "in" ? "kirim" : "chiqim"}`,
  },
  en: {
    title: "Statement against 1C",
    allOk: "Everything agrees: every row of the statement has its document in 1C and there is nothing extra.",
    summary: (c: Comparison["summary"]) =>
      `Statement rows: ${c.rows}. In 1C: ${c.ok}. No document: ${c.missing}. Incomplete (the other side of a transfer is missing): ${c.partial}. Extra documents: ${c.extra}.`,
    missing: "Not in 1C",
    partial: "Entered in part",
    extra: "Extra documents in 1C",
    accounts: "Turnover by account (1C − statement)",
    move: "a move between the company's own accounts",
    leg: (a: string, dir: string) => `${dir === "in" ? "receipt" : "write-off"} on account ${a}`,
    why: {
      duplicate: "entered twice",
      wrong_place: "looks like an expected document, but on another account or in the other direction",
      no_row: "no row of the statements stands behind it",
    },
    meant: (l: Leg) => `expected: ${l.direction === "in" ? "receipt" : "write-off"} on account ${l.account}`,
  },
} as const;

/** The comparison in words: what agrees, what is missing, what is extra, and the turnover per account. */
export function compareText(c: Comparison, lang: Lang): string {
  const w = WORDS[lang];
  const lines: string[] = [w.title, w.summary(c.summary)];
  const clean =
    c.summary.missing === 0 &&
    c.summary.partial === 0 &&
    c.summary.extra === 0 &&
    c.accounts.every((a) => a.difference.in === 0 && a.difference.out === 0);
  if (clean) return [...lines, w.allOk].join("\n");
  // At most a few examples of each kind: a long list is not a report.
  const SHOWN = 8;
  for (const [status, label] of [
    ["missing", w.missing],
    ["partial", w.partial],
  ] as const) {
    const bad = c.rows.filter((r) => r.status === status);
    if (bad.length === 0) continue;
    lines.push("", `${label}: ${bad.length}`);
    for (const r of bad.slice(0, SHOWN)) {
      const miss = r.legs
        .filter((l) => !l.doc)
        .map((l) => w.leg(l.leg.account, l.leg.direction))
        .join("; ");
      lines.push(
        `• ${dmy(r.day)} ${r.direction === "in" ? "+" : "−"}${money(r.cents)} №${r.number || "—"} (${r.file}, ${r.row})${r.kind === "own_move" ? ` — ${w.move}` : ""}${miss ? `; ${miss}` : ""}`,
      );
    }
    if (bad.length > SHOWN) lines.push(`… +${bad.length - SHOWN}`);
  }
  if (c.extra.length > 0) {
    lines.push("", `${w.extra}:`);
    for (const e of c.extra.slice(0, 15))
      lines.push(
        `• ${dmy(e.doc.day)} ${e.doc.direction === "in" ? "+" : "−"}${money(e.doc.cents)} №${e.doc.number} ${e.doc.kind ? `(${e.doc.kind}) ` : ""}[${e.doc.account || "?"}] — ${w.why[e.reason]}${e.meant ? `; ${w.meant(e.meant)}` : ""}`,
      );
    if (c.extra.length > 15) lines.push(`… +${c.extra.length - 15}`);
  }
  const off = c.accounts.filter((a) => a.difference.in !== 0 || a.difference.out !== 0);
  if (off.length > 0) {
    lines.push("", `${w.accounts}:`);
    for (const a of off)
      lines.push(
        `• ${a.account}: in ${signed(a.difference.in)}, out ${signed(a.difference.out)} (1C in ${money(a.books.in)} / out ${money(a.books.out)}; statement in ${money(a.statement.in)} / out ${money(a.statement.out)})`,
      );
  }
  return lines.join("\n");
}
