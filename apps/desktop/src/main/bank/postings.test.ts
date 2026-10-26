import { describe, expect, it } from "vitest";

import type { BankDoc } from "./duplicates.js";
import { documentLedgerAttribute, cardLedgerAttribute, type LedgerAccounts } from "./ledger-account.js";
import { findPostingFixes, reledgerChange } from "./postings.js";
import type { BankPayment, BankStatement } from "./statement.js";

const MAIN = "20208000705733821001";
const BLOCK = "22613000405733821001";

const pay = (over: Partial<BankPayment>): BankPayment => ({
  row: 1,
  date: "2024-01-18",
  number: "101",
  direction: "out",
  amount: 5_000_000_00,
  counterparty: "x",
  inn: "",
  account: MAIN,
  mfo: "",
  purpose: "перевод",
  ...over,
});

const statement = (account: string, payments: BankPayment[]): BankStatement => ({
  fileName: `${account}.xlsx`,
  sheet: "s",
  account,
  payments,
  issues: [],
  columns: {},
  convention: "",
});

const doc = (over: Partial<BankDoc>): BankDoc => ({
  object: "Документ.СписаниеСРасчетногоСчета",
  ref: "r",
  number: "1",
  day: "2024-01-18",
  cents: 5_000_000_00,
  posted: true,
  kind: "Прочее списание",
  account: BLOCK,
  incoming: "",
  counterparty: "",
  direction: "out",
  ledger: "L5530",
  ...over,
});

const ledger = (rows: Record<string, string | null>): LedgerAccounts => ({
  byAccount: new Map(),
  byNumber: new Map(Object.entries(rows).map(([n, l]) => [n, { ref: `acc-${n}`, ledger: l }])),
  why: null,
});

describe("bank documents booked to the wrong account", () => {
  const accounts = ledger({ [MAIN]: "L5110", [BLOCK]: "L5530" });

  it("a document on the blocked-funds account that carries the default account is set right", () => {
    const fixes = findPostingFixes(
      [statement(BLOCK, [pay({ account: MAIN })])],
      [doc({ ref: "a", ledger: "L5110" }), doc({ ref: "b", ledger: "L5530" })],
      accounts,
    );
    expect(fixes.reledger.map((r) => [r.doc.ref, r.ledger])).toEqual([["a", "L5530"]]);
    expect(fixes.retire).toEqual([]);
  });

  it("a move written as «Перевод на другой счет» with a statement row behind it is taken back; a single row retires one document", () => {
    const rows = [pay({ account: MAIN })];
    const fixes = findPostingFixes(
      [statement(BLOCK, rows)],
      [
        doc({ ref: "form", kind: "Перевод на другой счет организации", ledger: "L5110" }),
        doc({ ref: "form2", kind: "Перевод на другой счет организации", ledger: "L5110" }),
      ],
      accounts,
    );
    expect(fixes.retire.map((d) => d.ref)).toEqual(["form"]);
    // the second is not retired (no row stands behind it) but its ledger account is still set right
    expect(fixes.reledger.map((r) => r.doc.ref)).toEqual(["form2"]);
  });

  it("a move without a row in the statements is not taken back", () => {
    const fixes = findPostingFixes(
      [statement(BLOCK, [])],
      [doc({ ref: "form", kind: "Перевод с другого счета", direction: "in", ledger: "L5530" })],
      accounts,
    );
    expect(fixes.retire).toEqual([]);
    expect(fixes.reledger).toEqual([]);
  });

  it("an account whose card names no ledger account is counted and left alone", () => {
    const fixes = findPostingFixes([], [doc({ ref: "x", ledger: "L5110" })], ledger({ [BLOCK]: null }));
    expect(fixes.unknownLedger).toBe(1);
    expect(fixes.reledger).toEqual([]);
  });

  it("the change sets the attribute and posts again only a posted document", () => {
    expect(reledgerChange(doc({ ref: "a" }), "СчетБанк", "L5530")).toMatchObject({
      action: "update",
      ref: "a",
      fields: { СчетБанк: { type: "ПланСчетов.Хозрасчетный", ref: "L5530" } },
      post: true,
    });
    expect(reledgerChange(doc({ ref: "a", posted: false }), "СчетБанк", "L5530").post).toBe(false);
  });
});

describe("the attributes that hold a ledger account", () => {
  const charted = (name: string) => ({ name, types: ["ПланСчетов.Хозрасчетный"] });
  it("a document: СчетБанк first, then the other names", () => {
    expect(documentLedgerAttribute([charted("СчетУчетаРасчетовСКонтрагентом"), charted("СчетБанк")])).toBe(
      "СчетБанк",
    );
    expect(documentLedgerAttribute([{ name: "СчетБанк", types: ["Строка"] }])).toBeNull();
  });
  it("a card: the one chart attribute, or the one named like a ledger account", () => {
    expect(cardLedgerAttribute([charted("СчетУчета"), { name: "Банк", types: ["Справочник.Банки"] }])).toBe(
      "СчетУчета",
    );
    expect(cardLedgerAttribute([charted("А"), charted("Б")])).toBeNull();
  });
});
