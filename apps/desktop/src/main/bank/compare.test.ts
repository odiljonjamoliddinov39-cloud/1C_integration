import { describe, expect, it } from "vitest";

import { compareText, compareWithBooks } from "./compare.js";
import type { BankDoc } from "./duplicates.js";
import type { BankPayment, BankStatement } from "./statement.js";

const MAIN = "20208000805733821001";
const BLOCK = "22613000405733821001";
const OWN_INN = "311012912";

const pay = (row: number, over: Partial<BankPayment>): BankPayment => ({
  row,
  date: "2024-01-08",
  number: "",
  direction: "out",
  amount: 0,
  counterparty: "TEXMASH IMPORT MCHJ",
  inn: OWN_INN,
  account: BLOCK,
  mfo: "01082",
  purpose: "",
  ...over,
});
const statement = (account: string, payments: BankPayment[], fileName = "main.xlsx"): BankStatement => ({
  fileName,
  sheet: "1",
  account,
  columns: {},
  convention: "",
  payments,
  issues: [],
});

// The rows of the accountant's statement (rows 7 to 11 of the sheet).
const block1 = pay(7, {
  date: "2024-01-08",
  number: "1",
  direction: "out",
  amount: 12_446_000_000,
  purpose: "Блокировка средств",
});
const exchange = pay(8, {
  date: "2024-01-18",
  number: "5",
  direction: "out",
  amount: 300_000_000,
  counterparty: "АО «ХТ ХАРИД ТЕХНОЛОГИЯЛАРИ»",
  inn: "306712636",
  account: "20214000505122905003",
  purpose: "пополнение счета для участия в биржевых торгах",
});
const back1 = pay(9, {
  date: "2024-01-18",
  number: "51264587",
  direction: "in",
  amount: 12_446_000_000,
  purpose: "Возврат средств",
});
const back2 = pay(10, {
  date: "2024-01-24",
  number: "51376679",
  direction: "in",
  amount: 5_205_000_500,
  purpose: "Возврат средств",
});
const block2 = pay(11, {
  date: "2024-01-24",
  number: "6",
  direction: "out",
  amount: 5_205_000_500,
  purpose: "Блокировка средств",
});
const rows = [block1, exchange, back1, back2, block2];
/** The statement of the blocked account: the other side of each move, the way the bank lists it. */
const blocked = () =>
  statement(
    BLOCK,
    [block1, back1, back2, block2].map((p, i) =>
      pay(i + 1, {
        date: p.date,
        number: p.number,
        direction: p.direction === "out" ? "in" : "out",
        amount: p.amount,
        account: MAIN,
        purpose: p.purpose,
      }),
    ),
    "blocked.xlsx",
  );
const both = () => [statement(MAIN, rows), blocked()];

let n = 0;
const doc = (account: string, direction: "in" | "out", d: string, cents: number, incoming = ""): BankDoc => ({
  object: direction === "in" ? "Документ.ПоступлениеНаРасчетныйСчет" : "Документ.СписаниеСРасчетногоСчета",
  ref: `ref-${(n += 1)}`,
  number: String(n),
  day: d,
  cents,
  posted: true,
  kind: direction === "in" ? "Прочее поступление" : "Прочее списание",
  account,
  incoming,
  counterparty: "",
  direction,
  ledger: "",
});

/** What the program writes for a move between the own accounts: the write-off where the money left and the receipt where it came. */
const moveDocs = (p: BankPayment): BankDoc[] => {
  const from = p.direction === "out" ? MAIN : BLOCK;
  const to = p.direction === "out" ? BLOCK : MAIN;
  return [doc(from, "out", p.date, p.amount, p.number), doc(to, "in", p.date, p.amount)];
};

describe("compareWithBooks", () => {
  it("a move between the own accounts is one operation of two documents, one on each account, and that agrees", () => {
    const docs = [...moveDocs(block1), ...moveDocs(back1), ...moveDocs(back2), ...moveDocs(block2)];
    const result = compareWithBooks(both(), docs, OWN_INN);
    const verdict = (row: number) => result.rows.find((r) => r.file === "main.xlsx" && r.row === row);
    for (const row of [7, 9, 10, 11]) {
      expect(verdict(row)?.status).toBe("ok");
      expect(verdict(row)?.kind).toBe("own_move");
    }
    // Each move is two rows (one in each statement), each with its own document: two documents, not four.
    expect(result.rows.filter((r) => r.kind === "own_move")).toHaveLength(8);
    expect(result.summary.rows).toBe(9);
    // The 3 000 000 payment to another company is not among the documents: it is the one thing missing.
    expect(verdict(8)).toMatchObject({ status: "missing", kind: "payment" });
    expect(result.extra).toEqual([]);
    expect(result.summary).toMatchObject({ ok: 8, missing: 1, partial: 0, extra: 0 });
    // The turnover of the main account lacks exactly that payment; the blocked account agrees.
    const main = result.accounts.find((a) => a.account === MAIN);
    expect(main?.difference).toEqual({ in: 0, out: -300_000_000 });
    expect(result.accounts.find((a) => a.account === BLOCK)?.difference).toEqual({ in: 0, out: 0 });
  });

  it("with the payment entered as well, the statement and 1C agree on every account", () => {
    const docs = [
      ...moveDocs(block1),
      doc(MAIN, "out", "2024-01-18", 300_000_000, "5"),
      ...moveDocs(back1),
      ...moveDocs(back2),
      ...moveDocs(block2),
    ];
    const result = compareWithBooks(both(), docs, OWN_INN);
    expect(result.summary).toMatchObject({ ok: 9, missing: 0, partial: 0, extra: 0 });
    expect(result.accounts.every((a) => a.difference.in === 0 && a.difference.out === 0)).toBe(true);
    expect(compareText(result, "en")).toContain("Everything agrees");
  });

  it("both documents of a move on the main account: the receipt is on the wrong account, and the turnover shows the doubled amount", () => {
    const docs = [
      doc(MAIN, "out", "2024-01-08", 12_446_000_000, "1"),
      doc(MAIN, "in", "2024-01-08", 12_446_000_000),
    ];
    const result = compareWithBooks([statement(MAIN, [block1]), blocked()], docs, OWN_INN);
    expect(result.rows.find((r) => r.account === MAIN && r.row === 7)).toMatchObject({ status: "ok" });
    expect(result.rows.find((r) => r.account === BLOCK && r.row === 1)).toMatchObject({ status: "missing" });
    expect(result.extra).toHaveLength(1);
    expect(result.extra[0]).toMatchObject({
      reason: "wrong_place",
      meant: { account: BLOCK, direction: "in", cents: 12_446_000_000 },
    });
    expect(result.accounts.find((a) => a.account === MAIN)?.difference).toEqual({
      in: 12_446_000_000,
      out: 0,
    });
    const text = compareText(result, "ru");
    expect(text).toContain("на другом счёте");
    expect(text).toContain(BLOCK);
  });

  it("a move whose other account is not attached is the one document the import makes, and a bank fee to a transit account is one document too", () => {
    const TRANSIT = "16401000105733821001";
    const fee = pay(20, {
      date: "2024-01-16",
      number: "4",
      direction: "out",
      amount: 112_000,
      account: TRANSIT,
      purpose: "За iBank-24-1120.00 документ №4",
    });
    const docs = [doc(MAIN, "out", "2024-01-16", 112_000, "4")];
    const result = compareWithBooks([statement(MAIN, [fee])], docs, OWN_INN);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ status: "ok", legs: [{ mirror: false }] });
    expect(result.accounts.every((a) => a.difference.in === 0 && a.difference.out === 0)).toBe(true);
  });

  it("a row entered twice is a duplicate, and only the second copy is extra", () => {
    const docs = [
      doc(MAIN, "out", "2024-01-18", 300_000_000, "5"),
      doc(MAIN, "out", "2024-01-18", 300_000_000, ""),
    ];
    const result = compareWithBooks([statement(MAIN, [exchange])], docs, OWN_INN);
    expect(result.rows[0]?.legs[0]?.doc?.incoming).toBe("5");
    expect(result.extra).toHaveLength(1);
    expect(result.extra[0]).toMatchObject({ reason: "duplicate" });
  });

  it("two equal rows need two documents, not one", () => {
    const twin = pay(12, { ...exchange, row: 12 });
    const docs = [doc(MAIN, "out", "2024-01-18", 300_000_000)];
    const result = compareWithBooks([statement(MAIN, [exchange, twin])], docs, OWN_INN);
    expect(result.summary).toMatchObject({ ok: 1, missing: 1, extra: 0 });
  });

  it("a move listed in the statements of both accounts is one move: two documents, not four", () => {
    const other = statement(
      BLOCK,
      [pay(3, { date: "2024-01-08", number: "1", direction: "in", amount: 12_446_000_000, account: MAIN })],
      "blocked.xlsx",
    );
    const docs = moveDocs(block1);
    const result = compareWithBooks([statement(MAIN, [block1]), other], docs, OWN_INN);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.status === "ok" && r.legs.length === 1)).toBe(true);
    expect(result.extra).toEqual([]);
    expect(result.accounts.every((a) => a.difference.in === 0 && a.difference.out === 0)).toBe(true);
  });

  it("a document that no row stands behind is reported, and one on an account nobody asks about is not judged", () => {
    const docs = [
      doc(MAIN, "out", "2024-02-01", 5_000, ""),
      doc("20208000999999999001", "out", "2024-01-08", 12_446_000_000),
    ];
    const result = compareWithBooks([statement(MAIN, [exchange])], docs, OWN_INN);
    expect(result.extra.map((e) => e.reason)).toEqual(["no_row"]);
    expect(result.summary.unjudged).toBe(1);
  });

  it("the words come in three languages", () => {
    const result = compareWithBooks([statement(MAIN, [block1])], [], OWN_INN);
    expect(compareText(result, "uz")).toContain("1C da yo'q");
    expect(compareText(result, "ru")).toContain("Нет в 1С");
    expect(compareText(result, "en")).toContain("Not in 1C");
  });
});
