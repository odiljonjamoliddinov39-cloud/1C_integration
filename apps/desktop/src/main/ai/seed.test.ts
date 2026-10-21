import { describe, expect, it } from "vitest";

import { type QueryTemplateView, seedTemplateInputs } from "@platform/shared";

import { matchTemplate } from "./templates.js";

const views: QueryTemplateView[] = seedTemplateInputs().map((t, i) => ({
  ...t,
  id: String(i),
  version: 1,
  updatedAt: "",
  source: "admin",
  company: null,
  accountName: null,
  hits: 0,
  rejected: 0,
}));
const today = new Date("2026-10-21T10:00:00Z");
const codeOf = (question: string) => matchTemplate(question, views, today)?.template.code ?? null;

describe("the seeded questions are recognised, in the three languages", () => {
  it.each([
    ["остаток в кассе", "seed_cash_balance"],
    ["Сколько денег в кассе", "seed_cash_balance"],
    ["kassada qoldiq", "seed_cash_balance"],
    ["cash balance", "seed_cash_balance"],
    ["остаток на расчетном счете", "seed_bank_balance"],
    ["bank qoldig'i", "seed_bank_balance"],
    ["дебиторская задолженность", "seed_receivables"],
    ["кто нам должен", "seed_receivables"],
    ["debitorlik qarzi", "seed_receivables"],
    ["кредиторская задолженность", "seed_payables"],
    ["accounts payable", "seed_payables"],
    ["остаток по счету «6010»", "seed_account_balance"],
    ["выручка за сентябрь 2026", "seed_revenue"],
    ["расходы периода за август", "seed_period_expenses"],
    ["себестоимость продаж", "seed_cost_of_sales"],
    ["продажи контрагентам за сентябрь", "seed_sales_by_counterparty"],
    ["сумма продаж за сентябрь 2026", "seed_sales_total"],
    ["xarid summasi oktyabr", "seed_purchases_total"],
    ["непроведенные документы за сентябрь", "seed_unposted_documents"],
    ["документы с пометкой удаления", "seed_marked_documents"],
    ["дубли поступлений за август", "seed_duplicate_receipts"],
    ["курс доллара", "seed_currency_rates"],
    ["dollar kursi", "seed_currency_rates"],
    ["складские остатки", "seed_stock_balance"],
  ])("%s → %s", (question, code) => {
    expect(codeOf(question)).toBe(code);
  });

  it("takes the period and the date from the question", () => {
    const match = matchTemplate("выручка за сентябрь 2026", views, today);
    expect(match?.params).toMatchObject({ Начало: "2026-09-01", Конец: "2026-09-30" });
    expect(matchTemplate("остаток в кассе на 15.10.2026", views, today)?.params).toMatchObject({
      Дата: "2026-10-15",
    });
  });

  it("leaves to the model what has an extra condition, or asks two things", () => {
    expect(codeOf("остаток в кассе и в банке")).toBeNull();
    expect(codeOf("выручка по контрагенту Navroz за сентябрь с разбивкой по менеджерам")).toBeNull();
    expect(codeOf("почему выросла дебиторская задолженность")).toBeNull();
  });

  it("does not take a request to do something for a question to read", () => {
    expect(codeOf("документы с пометкой удаления")).toBe("seed_marked_documents");
    expect(codeOf("удали документы с пометкой удаления")).toBeNull();
    expect(codeOf("непроведенные документы за сентябрь, проведи")).toBeNull();
  });

  it("asks for a counterparty's name for a counterparty's balance", () => {
    const match = matchTemplate("сальдо по контрагенту Navroz", views, today);
    expect(match?.template.code).toBe("seed_counterparty_balance");
    expect(match?.counterparty?.words).toEqual(["navroz"]);
  });
});
