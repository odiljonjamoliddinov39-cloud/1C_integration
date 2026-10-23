import { describe, expect, it } from "vitest";

import { KNOWLEDGE, searchKnowledge } from "./knowledge.js";

describe("the knowledge base", () => {
  it("has unique ids, content in every entry, and account groups of four digits", () => {
    expect(new Set(KNOWLEDGE.map((e) => e.id)).size).toBe(KNOWLEDGE.length);
    for (const e of KNOWLEDGE) {
      expect(e.lines.length, e.id).toBeGreaterThanOrEqual(1);
      expect(e.topics.length, e.id).toBeGreaterThanOrEqual(3);
      for (const a of e.accounts ?? []) expect(a, e.id).toMatch(/^\d{4}$/);
    }
    expect(KNOWLEDGE.length).toBeGreaterThanOrEqual(20);
  });

  it("covers the kinds: entries, formulas, procedures, tax and the chart", () => {
    const kinds = new Set(KNOWLEDGE.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(["concept", "entry", "formula", "procedure", "tax"]);
  });

  it("names the accounting_calc operation of a formula that has one", () => {
    const ops = [
      "vat",
      "depreciation",
      "loan",
      "npv_irr",
      "fx_revaluation",
      "costing",
      "payroll",
      "landed_cost",
      "penalty",
      "ratios",
      "break_even",
      "allocate",
    ];
    for (const e of KNOWLEDGE) if (e.calc) expect(ops, e.id).toContain(e.calc);
  });

  it.each([
    ["как проводится аренда", "entry_purchase_services"],
    ["ijara xarajati qaysi hisobga", "entry_purchase_services"],
    ["проводки импорт ГТД", "entry_import_gtd"],
    ["как отразить амортизацию основных средств", "entry_fixed_assets"],
    ["начисление зарплаты и НДФЛ", "entry_payroll"],
    ["курсовая разница при переоценке валюты", "entry_fx"],
    ["month end closing checklist", "proc_month_close"],
    ["сверка ндс с Didox", "proc_vat_reconciliation"],
    ["inventarizatsiya", "proc_inventory_count"],
    ["аудит риски дубли", "proc_audit"],
    ["налог на прибыль ставка", "tax_reference"],
    ["какой счет у плана счетов нсбу", "concept_chart"],
    ["fifo lifo средняя себестоимость", "formula_costing"],
  ])("%s → %s", (question, id) => {
    expect(searchKnowledge(question, 3).map((e) => e.id)).toContain(id);
  });

  it("finds nothing for a question it knows nothing about", () => {
    expect(searchKnowledge("какая погода завтра")).toEqual([]);
    expect(searchKnowledge("")).toEqual([]);
  });

  it("knows how 1C closes the month, and why a closed month's 9xxx accounts look empty", () => {
    expect(searchKnowledge("как закрыть месяц в 1С регламентные операции")[0]?.id).toBe("proc_close_1c");
    expect(searchKnowledge("oyni yopish 1c regulated operations").map((e) => e.id)).toContain(
      "proc_close_1c",
    );
    const ids = searchKnowledge("после закрытия месяца обороты 90 счета нулевые закрытый месяц").map(
      (e) => e.id,
    );
    expect(ids).toContain("concept_close_effect");
    expect(searchKnowledge("торговая наценка 2980").map((e) => e.id)).toContain("concept_retail_markup");
  });

  it("knows where 1C takes each operation, the standard reports and the accountant's calendar", () => {
    expect(searchKnowledge("какой документ в 1с для списания товаров").map((e) => e.id)).toContain(
      "proc_1c_documents",
    );
    expect(searchKnowledge("карточка счета и оборотно-сальдовая ведомость что показывает")[0]?.id).toBe(
      "concept_1c_standard_reports",
    );
    expect(searchKnowledge("календарь бухгалтера регламентированная отчетность").map((e) => e.id)).toContain(
      "concept_accountant_calendar",
    );
  });
});
