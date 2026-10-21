import { describe, expect, it } from "vitest";

import {
  amountIn,
  balancesText,
  batchText,
  calcText,
  periodIn,
  ratesText,
  readEngineTask,
  revaluationText,
} from "./engine-tasks.js";

const ctx = { hasBank: true, today: "2026-10-21T10:00:00Z" };
const noBank = { hasBank: false, today: "2026-10-21T10:00:00Z" };

describe("the jobs the program does by itself", () => {
  it("reads a period from two dates or a year, in any of the languages", () => {
    expect(periodIn("01.01.2024 31.12.2024 йилдагиларни кирит")).toEqual({
      from: "2024-01-01",
      to: "2024-12-31",
    });
    expect(periodIn("2024 йил банк выпискасини")).toEqual({ from: "2024-01-01", to: "2024-12-31" });
    expect(periodIn("введи выписку за 2023")).toEqual({ from: "2023-01-01", to: "2023-12-31" });
    expect(periodIn("2024-03-05 dan 2024-02-01 gacha")).toEqual({ from: "2024-02-01", to: "2024-03-05" });
    expect(periodIn("hammasini kirit")).toBeNull();
  });

  it("knows a statement to enter (with a statement in the chat), in Uzbek, Russian and English", () => {
    for (const text of [
      "Vypiskani kirit",
      "2024 йил банк выпискасини кирит",
      "введи выписку за 2024",
      "enter the statement",
    ]) {
      expect(readEngineTask(text, ctx)?.kind).toBe("bank");
      expect(readEngineTask(text, noBank)?.kind ?? "model").not.toBe("bank");
    }
    expect(readEngineTask("2024 йил банк кўчирмасини кирит 01.01.2024 31.12.2024", ctx)).toEqual({
      kind: "bank",
      from: "2024-01-01",
      to: "2024-12-31",
    });
  });

  it("knows Didox receipts and sales, rates, balances and revaluation", () => {
    expect(readEngineTask("Дидокдаги 2024 йилги ҳисоб-фактураларни кирит", ctx)).toEqual({
      kind: "didox_in",
      from: "2024-01-01",
      to: "2024-12-31",
    });
    expect(readEngineTask("Didox sotuvlarini 2024 yil kirit", noBank)).toMatchObject({ kind: "didox_sales" });
    expect(readEngineTask("USD va RUB kurslarini 2024 yil yukla", noBank)).toEqual({
      kind: "rates",
      from: "2024-01-01",
      to: "2024-12-31",
      currencies: ["USD", "RUB"],
    });
    expect(readEngineTask("Qoldiqlarni tekshir", noBank)).toEqual({ kind: "balances", date: "2026-10-21" });
    expect(readEngineTask("проверь остатки на 31.12.2024 и 01.01.2024", noBank)).toMatchObject({
      kind: "balances",
      date: "2024-12-31",
    });
    expect(readEngineTask("Qayta baholashni tekshir 2024 yil", noBank)).toEqual({
      kind: "revaluation",
      from: "2024-01-01",
      to: "2024-12-31",
    });
  });

  it("leaves everything else to the model: questions, analysis, long texts", () => {
    for (const text of [
      "Qarzdorlar ro'yxati qanday?",
      "vypiska bo'yicha jami nechta to'lov bor",
      "Didox hujjatlari haqida gapirib ber",
      "Nega 5710 hisobida qoldiq bor?",
      "x".repeat(500) + " kirit",
    ])
      expect(readEngineTask(text, ctx)).toBeNull();
  });

  it("writes what was done in the accountant's language, with the failures and what is left", () => {
    const data = {
      status: "done",
      applied: Array.from({ length: 40 }, () => ({})),
      failed: [{ n: 41, error: "WRITE_FAILED", message: "Не заполнено поле «Договор»" }],
      alreadyIn1c: { count: 3 },
      transfersEntered: { documents: 4 },
      createdInThisRun: ["A", "B"],
      needsAttention: { count: 7, problems: [{ rows: [1, 2, 3], message: "no earlier payment to copy" }] },
      notes: ["x"],
      ratesNotLoaded: "USD: the bank did not answer",
    };
    const uz = batchText(data, "uz");
    for (const part of [
      "Kiritilgan hujjatlar: 40",
      "1C qabul qilmadi: 1",
      "Не заполнено поле «Договор»",
      "avvaldan bor: 3",
      "o'tkazmalar: 4",
      "Dastur hal qila olmagan: 7",
      "no earlier payment to copy (3)",
      "kurslari yuklanmadi",
      "modelsiz",
    ])
      expect(uz).toContain(part);
    expect(batchText(data, "ru")).toContain("Введено документов: 40");
    expect(batchText({ status: "nothing_to_enter" }, "en")).toContain("Nothing to enter");
    expect(batchText({ status: "declined_by_user" }, "uz")).toContain("rad etildi");
  });

  it("writes the balance, revaluation and rate answers", () => {
    const b = balancesText(
      {
        date: "2024-12-31",
        findings: [{ account: "57xx", name: "t", balance: -5_921_430.48, why: "transit does not close" }],
        exchangeDifferences: { income: 10, expense: 5 },
      },
      "en",
    );
    expect(b).toContain("57xx -5 921 430.48: transit does not close");
    expect(b).toContain("Exchange differences");
    const r = revaluationText(
      {
        differences: 2,
        totals: { gain: 10_000, loss: 0 },
        noRate: ["EUR"],
        findings: [
          {
            month: "2024-12",
            account: "5210",
            currency: "USD",
            adjustment: 10_000,
            entry: "Дт 5210 / Кт 9540 10000",
          },
        ],
      },
      "ru",
    );
    expect(r).toContain("Нет курса на дату — загрузите курсы: EUR");
    expect(r).toContain("2024-12 Дт 5210");
    expect(ratesText({ status: "already_exists" }, "uz")).toContain("1C da bor");
    expect(
      ratesText(
        {
          applied: [
            { object: { presentation: "USD: 249 rates written" } },
            { object: { presentation: "RUB: 248 rates written, 2 already there" } },
          ],
        },
        "uz",
      ),
    ).toContain("yozildi: 497 ta");
  });

  it("reads an amount: with spaces, commas, a fraction, a unit; and not a percent or a year", () => {
    expect(amountIn("1 000 000 so'm QQS")).toBe(1_000_000);
    expect(amountIn("1,250,000.50 dan")).toBe(1_250_000.5);
    expect(amountIn("12 млн сумма")).toBe(12_000_000);
    expect(amountIn("1250,5 so'm")).toBe(1250.5);
    expect(amountIn("12% QQS 800000")).toBe(800_000);
    expect(amountIn("qanday hisoblanadi")).toBeNull();
  });

  it("knows a VAT and a pay-roll sum to work out", () => {
    expect(readEngineTask("1 000 000 so'm dan QQS hisobla", noBank)).toEqual({
      kind: "calc",
      input: { op: "vat", amount: 1_000_000, rate: 12, mode: "exclusive" },
    });
    expect(readEngineTask("1 120 000 so'm QQS ichida, 12% QQS qancha", noBank)).toEqual({
      kind: "calc",
      input: { op: "vat", amount: 1_120_000, rate: 12, mode: "inclusive" },
    });
    expect(readEngineTask("oylik 10 000 000 JShDS va INPS", noBank)).toEqual({
      kind: "calc",
      input: { op: "payroll", gross: 10_000_000 },
    });
    expect(readEngineTask("на руки 8 млн зарплата", noBank)).toEqual({
      kind: "calc",
      input: { op: "payroll", net: 8_000_000 },
    });
    expect(readEngineTask("QQS nima?", noBank)).toBeNull();
    expect(calcText("vat", { vat: 120_000, total: 1_120_000 }, "uz")).toContain("vat: 120 000");
  });
});
