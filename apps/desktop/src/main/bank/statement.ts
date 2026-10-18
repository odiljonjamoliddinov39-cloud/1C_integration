/**
 * A bank statement (Excel or CSV from a client-bank) read here, with no AI: the columns are found
 * by the words of their headings, each payment becomes one line of whole tiyin, and what looks
 * wrong is named. The model is told the totals and the exceptions, not every row, so a
 * statement of 300 payments costs a few hundred tokens instead of the file.
 *
 * Nothing is guessed silently: the summary says which column was taken for what and which way
 * "Дебет" and "Кредит" were read, so a wrong reading is visible on the first look.
 */
import { type SheetTable, type TableFile, columnLetter, parseDate, parseNumber } from "../tables.js";

export type BankColumn =
  | "date"
  | "number"
  | "name"
  | "payerName"
  | "receiverName"
  | "inn"
  | "payerInn"
  | "receiverInn"
  | "account"
  | "payerAccount"
  | "receiverAccount"
  | "mfo"
  | "debit"
  | "credit"
  | "amount"
  | "purpose";

export interface BankPayment {
  /** The row of the sheet, as Excel numbers it. */
  row: number;
  /** YYYY-MM-DD. */
  date: string;
  /** The bank document's number. */
  number: string;
  /** "in": money came to the account; "out": it left. */
  direction: "in" | "out";
  /** Whole tiyin. */
  amount: number;
  counterparty: string;
  /** The counterparty's INN (digits), "" when the statement has none. */
  inn: string;
  /**
   * The INN column held only zeros: the bank writes nine zeros when the INN was not given. Then the
   * counterparty is known by its name.
   */
  innZero?: true;
  /** The counterparty's bank account. */
  account: string;
  mfo: string;
  purpose: string;
}

export interface BankIssue {
  /** The sheet row it is about. */
  row: number;
  code: "NO_AMOUNT" | "BOTH_SIDES" | "NEGATIVE" | "DUPLICATE" | "INN_FORMAT" | "NO_NUMBER";
  message: string;
}

export interface BankStatement {
  fileName: string;
  sheet: string;
  /** The organization's own account named above the table ("Выписка по счёту 2020…"), if any. */
  account: string;
  payments: BankPayment[];
  issues: BankIssue[];
  /** Which heading was taken for which column, for the summary. */
  columns: Partial<Record<BankColumn, string>>;
  /** How a column pair was read, so a wrong reading is seen at once. */
  convention: string;
  /** The columns were found by what the cells hold (dates, accounts, INNs, amounts): no usable headings. */
  inferred?: true;
}

/** Heading words → what the column holds. The first rule that fits wins, so the narrow ones come first. */
const HEADINGS: [BankColumn, RegExp][] = [
  [
    "payerInn",
    /(плательщик|тўловчи|tolovchi|to'lovchi).*(инн|stir|inn)|(инн|stir|inn).*(плательщик|тўловчи|tolovchi|to'lovchi)/,
  ],
  ["receiverInn", /(получател|oluvchi|олувчи).*(инн|stir|inn)|(инн|stir|inn).*(получател|oluvchi|олувчи)/],
  ["payerAccount", /(плательщик|tolovchi|to'lovchi|тўловчи).*(сч[её]т|hisob|xisob)/],
  ["receiverAccount", /(получател|oluvchi|олувчи).*(сч[её]т|hisob|xisob)/],
  ["payerName", /плательщик|tolovchi|to'lovchi|тўловчи|ҳисоб эгаси/],
  ["receiverName", /получател|oluvchi|олувчи/],
  ["inn", /(?<!\p{L})(инн|stir|inn|пинфл|pinfl)(?!\p{L})/u],
  ["mfo", /мфо|mfo/],
  ["account", /сч[её]т|hisob|xisob|account/],
  [
    "number",
    /№\s*док|док\w*\.?\s*(№|номер)|номер\s*док|hujjat\s*(raqam|№)|^№$|^номер$|^raqam$|^number$|^doc\.?\s*no/,
  ],
  ["debit", /дебет|debet|debit|расход|chiqim|списани/],
  ["credit", /кредит|kredit|credit|приход|kirim|поступлен/],
  ["purpose", /назначен|purpose|maqsad|to'lov\s*maqsadi|тўлов\s*мақсади|детал|основан/],
  ["name", /корреспондент|контрагент|наименование|naimenovanie|nomi|mijoz|name|клиент/],
  ["date", /^дата|^sana|^date|дата\s*(проводки|документа|операции|платежа)/],
  ["amount", /сумма|summa|amount|сум$/],
];

const normalize = (cell: string) => cell.toLowerCase().replace(/\s+/g, " ").trim();

function roles(cells: string[]): Map<number, BankColumn> {
  const found = new Map<number, BankColumn>();
  const taken = new Set<BankColumn>();
  cells.forEach((cell, i) => {
    const text = normalize(cell);
    if (text === "") return;
    for (const [role, pattern] of HEADINGS) {
      if (!taken.has(role) && pattern.test(text)) {
        found.set(i, role);
        taken.add(role);
        return;
      }
    }
  });
  return found;
}

/** The header row: the first of the top rows that has a date, an amount side and a purpose or a name. */
function findHeader(sheet: SheetTable): { index: number; columns: Map<number, BankColumn> } | null {
  for (let index = 0; index < Math.min(sheet.rows.length, 40); index++) {
    const columns = roles(sheet.rows[index] ?? []);
    const have = new Set(columns.values());
    const money = have.has("amount") || (have.has("debit") && have.has("credit"));
    const who = [...have].some((r) => r === "purpose" || r === "name" || r.endsWith("Name"));
    if (have.has("date") && money && who) return { index, columns };
  }
  return null;
}

const tiyin = (n: number) => Math.round(n * 100);

const digits = (text: string) => text.replace(/\D/g, "");

/** An INN is 9 digits (a company) or 14 (a person). Excel sometimes writes it as 3.0321E+8: not usable. */
const innOf = (text: string) => {
  const d = digits(text);
  return /e\+/i.test(text) ? "" : d;
};

/** Banks write 000000000 where the INN was not given: that is no INN (two such payers are not one counterparty). */
const isZeroInn = (inn: string) => /^0+$/.test(inn);

const ACCOUNT = /^\d{20}$/;
const INN_SHAPE = /^(\d{9}|\d{14})$/;

/**
 * The columns of a statement with no headings, or headings in words this program does not know (a bank
 * changes its export; the data does not change): found by what the cells hold. A date column; 20-digit
 * accounts and 9/14-digit INNs, where the one that is the same on every row is the organization's own and
 * the one that varies is the counterparty's; an amount column, or a pair of amount columns of which one is
 * empty on each row (Дебет, then Кредит); the longest text is the purpose; the other text with the most
 * different values is the counterparty's name.
 */
function inferColumns(sheet: SheetTable): {
  columns: Map<number, BankColumn>;
  ownAccount: string;
  pair: boolean;
} | null {
  const rows = sheet.rows.filter((row) => row.some((cell) => parseDate(cell.trim())));
  if (rows.length < 2) return null;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const cols = Array.from({ length: width }, (_, i) => {
    const values = rows.map((row) => (row[i] ?? "").trim());
    const filled = values.filter((v) => v !== "");
    const digitsOf = (v: string) => v.replace(/\s/g, "");
    const share = (test: (v: string) => boolean) =>
      filled.length ? filled.filter(test).length / filled.length : 0;
    return {
      i,
      values,
      filled,
      coverage: filled.length / rows.length,
      distinct: new Set(filled).size,
      date: share((v) => parseDate(v) !== null),
      account: share((v) => ACCOUNT.test(digitsOf(v))),
      inn: share((v) => INN_SHAPE.test(digitsOf(v))),
      mfo: share((v) => /^\d{5}$/.test(v)),
      number: share((v) => !Number.isNaN(parseNumber(v))),
      shortInt: share((v) => /^\d{1,8}$/.test(v)),
      decimals: share((v) => /[.,]\d{1,2}$/.test(v)),
      avgLength: filled.length ? filled.reduce((n, v) => n + v.length, 0) / filled.length : 0,
    };
  }).filter((c) => c.filled.length > 0);

  const found = new Map<number, BankColumn>();
  const used = new Set<number>();
  const take = (role: BankColumn, column: { i: number } | undefined) => {
    if (column && !used.has(column.i)) {
      found.set(column.i, role);
      used.add(column.i);
    }
  };
  const date = cols.find((c) => c.coverage >= 0.8 && c.date >= 0.8);
  if (!date) return null;
  take("date", date);

  // The same value on every row is the organization's own; the one that varies is the counterparty's.
  const own = (column: { distinct: number }) => column.distinct <= Math.max(1, rows.length * 0.1);
  const accounts = cols.filter((c) => !used.has(c.i) && c.coverage >= 0.8 && c.account >= 0.8);
  const ownAccount = accounts.find(own);
  take("account", [...accounts].filter((c) => c !== ownAccount).sort((a, b) => b.distinct - a.distinct)[0]);
  const inns = cols.filter((c) => !used.has(c.i) && c.coverage >= 0.5 && c.inn >= 0.8 && c.account < 0.5);
  const ownInn = inns.find(own);
  take("inn", [...inns].filter((c) => c !== ownInn).sort((a, b) => b.distinct - a.distinct)[0]);
  const isOwn = (c: { i: number }) => c.i === ownAccount?.i || c.i === ownInn?.i;
  take(
    "mfo",
    cols.find((c) => !used.has(c.i) && !isOwn(c) && c.coverage >= 0.8 && c.mfo >= 0.8),
  );

  // Amounts: not a date, account, INN or bank code. A pair has one of the two empty (or 0) on each row.
  const money = cols.filter(
    (c) =>
      !used.has(c.i) &&
      !isOwn(c) &&
      c.date < 0.5 &&
      c.account < 0.5 &&
      c.mfo < 0.8 &&
      c.number >= 0.8 &&
      !(c.inn >= 0.8 && c.decimals < 0.5),
  );
  const zero = (v: string) => v === "" || parseNumber(v) === 0;
  let pair: [(typeof money)[number], (typeof money)[number]] | null = null;
  for (let a = 0; a < money.length && !pair; a++) {
    for (let b = a + 1; b < money.length && !pair; b++) {
      const x = money[a];
      const y = money[b];
      if (!x || !y) continue;
      const both = rows.filter((_, r) => !zero(x.values[r] ?? "") && !zero(y.values[r] ?? "")).length;
      const either = rows.filter((_, r) => !zero(x.values[r] ?? "") || !zero(y.values[r] ?? "")).length;
      if (both <= rows.length * 0.05 && either >= rows.length * 0.9) {
        pair = [x, y];
      }
    }
  }
  if (pair) {
    take("debit", pair[0]);
    take("credit", pair[1]);
  } else {
    // One signed amount: the column with decimals, or the large numbers, filled on (nearly) every row.
    const amount = money.find((c) => c.coverage >= 0.9 && (c.decimals >= 0.5 || c.avgLength >= 5));
    if (!amount) return null;
    take("amount", amount);
  }

  // The bank's own document number: a short whole number, mostly different on every row.
  take(
    "number",
    cols.find((c) => !used.has(c.i) && !isOwn(c) && c.shortInt >= 0.8 && c.distinct >= rows.length * 0.5),
  );

  // Text: the purpose is the longest, the counterparty's name is the other with the most different values.
  const text = cols.filter(
    (c) =>
      !used.has(c.i) && !isOwn(c) && c.date < 0.5 && c.number < 0.5 && c.account < 0.5 && c.coverage >= 0.5,
  );
  const purpose = [...text].sort((a, b) => b.avgLength - a.avgLength)[0];
  if (purpose && purpose.avgLength >= 15) take("purpose", purpose);
  const name = [...text]
    .filter((c) => !used.has(c.i))
    .sort((a, b) => b.distinct - a.distinct || a.i - b.i)[0];
  take("name", name);

  const have = new Set(found.values());
  if (!(have.has("purpose") || have.has("name"))) return null;
  // A table of dates, names and amounts is not yet a bank statement: the bank's accounts, INNs, or a
  // Дебет/Кредит pair say it is.
  if (!(have.has("account") || have.has("inn") || pair)) return null;
  return {
    columns: found,
    ownAccount: ownAccount ? (ownAccount.filled[0] ?? "").replace(/\s/g, "") : "",
    pair: Boolean(pair),
  };
}

export function parseBankStatement(file: TableFile): BankStatement | null {
  for (const sheet of file.sheets) {
    const named = findHeader(sheet);
    const guessed = named ? null : inferColumns(sheet);
    const header = named ?? (guessed ? { index: -1, columns: guessed.columns } : null);
    if (!header) continue;
    const at = (role: BankColumn) => [...header.columns].find(([, r]) => r === role)?.[0];
    const col = {
      date: at("date"),
      number: at("number"),
      debit: at("debit"),
      credit: at("credit"),
      amount: at("amount"),
      purpose: at("purpose"),
    };
    const headings = sheet.rows[header.index] ?? [];
    const columns: Partial<Record<BankColumn, string>> = {};
    for (const [i, role] of header.columns) {
      columns[role] = guessed ? `column ${columnLetter(i)}, found by its data` : (headings[i] ?? "");
    }

    const payments: BankPayment[] = [];
    const issues: BankIssue[] = [];
    const seen = new Map<string, number>();

    for (let r = header.index + 1; r < sheet.rows.length; r++) {
      const cells = sheet.rows[r] ?? [];
      const date = parseDate(cells[col.date ?? -1] ?? "");
      // Totals, balances and notes under the table have no date.
      if (!date) continue;
      const row = r + 1;
      const number = (cells[col.number ?? -1] ?? "").trim();

      const debit = col.debit === undefined ? Number.NaN : parseNumber(cells[col.debit] ?? "");
      const credit = col.credit === undefined ? Number.NaN : parseNumber(cells[col.credit] ?? "");
      let direction: "in" | "out";
      let value: number;
      if (col.debit !== undefined && col.credit !== undefined) {
        const out = Number.isNaN(debit) ? 0 : debit;
        const into = Number.isNaN(credit) ? 0 : credit;
        if (out !== 0 && into !== 0) {
          issues.push({ row, code: "BOTH_SIDES", message: "both Дебет and Кредит are filled" });
        }
        // Money on the account's own statement: a debit leaves it, a credit comes to it.
        direction = into !== 0 && out === 0 ? "in" : "out";
        value = direction === "in" ? into : out;
      } else {
        const amount = parseNumber(cells[col.amount ?? -1] ?? "");
        const sideCell = col.debit ?? col.credit;
        const sideValue = sideCell === undefined ? Number.NaN : parseNumber(cells[sideCell] ?? "");
        const single = Number.isNaN(amount) ? sideValue : amount;
        direction = single < 0 ? "out" : "in";
        value = Math.abs(Number.isNaN(single) ? 0 : single);
        if (single < 0) {
          issues.push({ row, code: "NEGATIVE", message: "a negative amount: read as a payment out" });
        }
      }
      if (!(value > 0)) {
        issues.push({ row, code: "NO_AMOUNT", message: "no amount" });
        continue;
      }

      const pick = (...roleNames: BankColumn[]) => {
        for (const role of roleNames) {
          const index = at(role);
          const text = index === undefined ? "" : (cells[index] ?? "").trim();
          if (text !== "") return text;
        }
        return "";
      };
      const incoming = direction === "in";
      const counterparty = pick(
        incoming ? "payerName" : "receiverName",
        "name",
        incoming ? "receiverName" : "payerName",
      );
      const written = innOf(pick(incoming ? "payerInn" : "receiverInn", "inn"));
      const innZero = isZeroInn(written);
      const inn = innZero ? "" : written;
      const payment: BankPayment = {
        row,
        date,
        number,
        direction,
        amount: tiyin(value),
        counterparty,
        inn,
        ...(innZero ? { innZero: true as const } : {}),
        account: digits(pick(incoming ? "payerAccount" : "receiverAccount", "account")),
        mfo: digits(pick("mfo")),
        purpose: pick("purpose"),
      };
      if (number === "") issues.push({ row, code: "NO_NUMBER", message: "no document number" });
      if (inn !== "" && ![9, 14].includes(inn.length)) {
        issues.push({ row, code: "INN_FORMAT", message: `INN "${inn}" has ${inn.length} digits` });
      }
      const key = [date, number, direction, payment.amount, inn || counterparty].join("|");
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        issues.push({ row, code: "DUPLICATE", message: `the same as row ${earlier}` });
      } else seen.set(key, row);
      payments.push(payment);
    }
    if (payments.length === 0) continue;

    const above = sheet.rows
      .slice(0, Math.max(header.index, 0))
      .flat()
      .map((cell) => /\b20\d{3}\d{15}\b/.exec(cell.replace(/\s/g, ""))?.[0])
      .find((x): x is string => Boolean(x));
    return {
      fileName: file.name,
      sheet: sheet.name,
      account: above ?? guessed?.ownAccount ?? "",
      payments,
      issues,
      columns,
      convention:
        col.debit !== undefined && col.credit !== undefined
          ? guessed
            ? "no headings: the first amount column was read as Дебет = money out, the second as Кредит = money in (the usual order; not certain)"
            : "Дебет = money out of the account, Кредит = money in"
          : "the sign of the amount: negative = out, otherwise in",
      ...(guessed ? { inferred: true as const } : {}),
    };
  }
  return null;
}

/** Issue codes that stop a payment from being entered until someone looks at it. */
export const BLOCKING: BankIssue["code"][] = ["NO_AMOUNT", "BOTH_SIDES", "INN_FORMAT"];

const sum = (payments: BankPayment[]) => payments.reduce((n, p) => n + p.amount, 0);
const money = (tiyinAmount: number) =>
  (tiyinAmount / 100)
    .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/,/g, " ");

/** What the model gets instead of the table: totals by month and direction, and the exceptions. */
export function describeBankStatement(statement: BankStatement): string {
  const { payments } = statement;
  const incoming = payments.filter((p) => p.direction === "in");
  const outgoing = payments.filter((p) => p.direction === "out");
  const months = [...new Set(payments.map((p) => p.date.slice(0, 7)))].sort();
  const dates = payments.map((p) => p.date).sort();
  const lines = [
    `Bank statement ${statement.fileName}${statement.sheet ? ` (${statement.sheet})` : ""}, read by the program: ` +
      `${payments.length} payments ${dates[0]} – ${dates.at(-1)}` +
      (statement.account ? `, account ${statement.account}` : "") +
      `. Read as: ${statement.convention}.`,
    "Columns taken: " +
      Object.entries(statement.columns)
        .map(([role, heading]) => `${role} = "${heading}"`)
        .join(", "),
    `In: ${incoming.length} payments, ${money(sum(incoming))}. Out: ${outgoing.length} payments, ${money(sum(outgoing))}.`,
    ...months.map((month) => {
      const of = payments.filter((p) => p.date.startsWith(month));
      return `${month}: in ${money(sum(of.filter((p) => p.direction === "in")))}, out ${money(sum(of.filter((p) => p.direction === "out")))} (${of.length})`;
    }),
  ];
  if (statement.inferred) {
    lines.push(
      "The file has no headings this program knows, so the columns were found by what the cells hold. " +
        "Check the totals above: if In and Out look swapped, say so to the accountant before entering anything.",
    );
  }
  if (statement.issues.length > 0) {
    lines.push(
      "To look at (sheet rows): " +
        statement.issues
          .slice(0, 30)
          .map((i) => `${i.row} ${i.code}: ${i.message}`)
          .join("; ") +
        (statement.issues.length > 30 ? ` … and ${statement.issues.length - 30} more` : ""),
    );
  }
  return lines.join("\n");
}
