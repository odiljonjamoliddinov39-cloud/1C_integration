import { describe, expect, it } from "vitest";

import {
  foreignContract,
  foreignPayee,
  foreignReturn,
  sameForeignName,
  squashName,
  withForeignPayees,
} from "./swift.js";
import type { BankPayment, BankStatement } from "./statement.js";

// Narratives in the shapes a bank wraps them (names and numbers are made up).
const BC =
  "BC: /100816681574  ACME GREAT DRILL BITS CO LTD  NO 2 JIANSH OC: /22614840505733821001  EXAMPLE IMPORT LLC  R KAGAN MSG GEOFI PD:PREPAYMENT PER CONTRACT GR-TI-01 D  .D. 30.01.2024 FOR SUPPYING PDC BI  T 132MM";
const TXID =
  "5101151011SWIFT: Исходящие СВИФТ документы в Головной Офис: PREPAYMENT 13,44 PERCENT PER CONTRA CT KQ-TI-01 D.D 01/01/24 FOR SUPPLY ING DRILLING BITS, EXAMPLE IMPORT MCHJ R KAGAN MSG UZ/BUKHORO UZ/TXID/311012912, SAMPLE KAIQIU DRILLING TOOLS CO.,L TD. ADD: 2398 JUYING ROAD, CHINA, 22614840505733821001, 387065374773, URG{URG}";
const RUB =
  "BC: /40702810150090004702  INN6686073730.KPP668601001  OOO SAMPLE OC: /22614643905733821001  EXAMPLE IMPORT OOO. UZBEKISTAN, BUX PD:'(VO10100)'  PREDOPLATA ZA POSTAVKU STALXNYH KR  UGOV 40HN2MA PO KONTRAKTU n M37075  633-1 OT 22.05.2025G.";

describe("the beneficiary of a SWIFT payment", () => {
  it("is read from the BC field, cut where its address begins, with the contract and the advance", () => {
    expect(foreignPayee(BC)).toEqual({
      name: "ACME GREAT DRILL BITS CO LTD",
      account: "100816681574",
      taxId: "",
      contract: { number: "GR-TI-01", date: "2024-01-30" },
      prepayment: true,
    });
  });

  it("is read after the TXID of a bank's own message, and a two-digit year is this century", () => {
    const payee = foreignPayee(TXID);
    expect(payee?.name).toBe("SAMPLE KAIQIU DRILLING TOOLS CO., L TD.");
    expect(payee?.contract).toEqual({ number: "KQ-TI-01", date: "2024-01-01" });
    expect(payee?.prepayment).toBe(true);
  });

  it("takes a Russian tax number out of the name, and a contract number written across a wrap", () => {
    const payee = foreignPayee(RUB);
    expect(payee).toMatchObject({ name: "OOO SAMPLE", taxId: "6686073730", prepayment: true });
    expect(payee?.contract).toEqual({ number: "M37075633-1", date: "2025-05-22" });
  });

  it("is null for a text that names no beneficiary", () => {
    expect(foreignPayee("Оплата по договору №5 от 01.01.2024")).toBeNull();
    expect(foreignPayee("Конвертация валютных средств 4165.0 'Доллар США' по курсу 12484.0")).toBeNull();
  });
});

describe("a contract named in English", () => {
  it.each([
    ["PER CONTRACT GR-TI- 08/  25 D.D. 01.08.2025 FOR", "GR-TI-08/25", "2025-08-01"],
    ["CONTRACT No SP-TEX-01 DATED 01/08/2025", "SP-TEX-01", "2025-08-01"],
    ["KONTRAKT 20250605 OT 05.06.2025", "20250605", "2025-06-05"],
  ])("%s", (text, number, date) => {
    expect(foreignContract(text)).toEqual({ number, date });
  });

  it("is null when no date follows the number", () => {
    expect(foreignContract("PER CONTRACT GR-TI-01 FOR SUPPLY")).toBeNull();
  });
});

describe("a return of an international transfer", () => {
  it("names the day and the amount of the payment that came back", () => {
    expect(
      foreignReturn(
        "возврат международного перевода EXAMPLE IMPORT LLC от 23.02.2024 на сумму 6100 за минусом комисси инообанка",
      ),
    ).toEqual({ date: "2024-02-23", amount: 6100 });
    expect(foreignReturn("оплата по договору")).toBeNull();
  });
});

describe("names", () => {
  it("are one counterparty when one's letters begin the other's", () => {
    expect(squashName("ACME GREAT DRILL BITS CO., LTD")).toBe("acmegreatdrillbitscoltd");
    expect(sameForeignName("ACME GREAT DRILL BITS CO LTD", "Acme Great Drill Bits Co., Ltd")).toBe(true);
    // the bank cut the name
    expect(
      sameForeignName("CHANGSHA TRANSASIA TRANSPORT INTE", "CHANGSHA TRANSASIA TRANSPORT INTERNATIONAL"),
    ).toBe(true);
    expect(sameForeignName("ACME GREAT DRILL BITS", "OTHER GREAT DRILL BITS")).toBe(false);
    // too short to say anything
    expect(sameForeignName("ACME", "ACME TRADING CO")).toBe(false);
  });
});

describe("the statement of a currency account", () => {
  const payment = (over: Partial<BankPayment>): BankPayment => ({
    row: 1,
    date: "2024-11-26",
    number: "1",
    direction: "out",
    amount: 870_000,
    counterparty: "К получению с Головного Офиса - Долларов США",
    inn: "207117389",
    account: "16103840000001082001",
    mfo: "01082",
    purpose: BC,
    ...over,
  });
  const statement = (payments: BankPayment[]): BankStatement =>
    ({
      fileName: "usd.xlsx",
      account: "22614840505733821001",
      payments,
      issues: [],
    }) as unknown as BankStatement;

  it("writes each SWIFT payment to its beneficiary, known by name, not to the bank's ledger line", () => {
    const { statement: made, payees } = withForeignPayees(
      statement([
        payment({}),
        payment({
          row: 2,
          direction: "in",
          counterparty: "Продажа иностр валюты юридическим лицам",
          purpose: "Конвертация",
        }),
      ]),
    );
    expect(made.payments[0]).toMatchObject({
      counterparty: "ACME GREAT DRILL BITS CO LTD",
      inn: "",
      innZero: true,
    });
    // a conversion line is not touched
    expect(made.payments[1]?.counterparty).toBe("Продажа иностр валюты юридическим лицам");
    expect([...payees.keys()]).toEqual([1]);
  });

  it("leaves the statement as it is when no payment is a SWIFT payment", () => {
    const original = statement([payment({ purpose: "Комиссия" })]);
    expect(withForeignPayees(original).statement).toBe(original);
  });

  it("writes the money the correspondent bank sent back to the beneficiary and the contract of the payment it returns", () => {
    const { statement: made, payees } = withForeignPayees(
      statement([
        payment({ row: 1, date: "2024-02-23", amount: 610_000, purpose: BC }),
        payment({
          row: 2,
          date: "2024-04-02",
          direction: "in",
          amount: 608_000,
          purpose:
            "возврат международного перевода EXAMPLE IMPORT LLC от 23.02.2024 на сумму 6100 за минусом комисси инообанка",
        }),
        payment({
          row: 3,
          date: "2024-04-02",
          direction: "in",
          amount: 5_000,
          purpose: "возврат международного перевода от 01.01.2020 на сумму 1 (no such payment)",
        }),
      ]),
    );
    expect(made.payments[1]).toMatchObject({ counterparty: "ACME GREAT DRILL BITS CO LTD", innZero: true });
    expect(made.payments[1]?.purpose).toContain("PER CONTRACT GR-TI-01 D.D. 30.01.2024");
    // a return that names no payment in the statement stays as it was
    expect(made.payments[2]?.counterparty).toBe("К получению с Головного Офиса - Долларов США");
    expect([...payees.keys()]).toEqual([1, 2]);
  });
});
