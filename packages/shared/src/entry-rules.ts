/**
 * The curated entry rules (TD §4 `rules`): the 16 operations the decision centre decides by rule, each with its row in the book
 * (B1, the 3000-entries book; pages and numbers are the book's own), and the rows of the families the engine has no rule for yet.
 * The 16 are `checked` (compared with the page); the others are `parsed` — a known pair for the entry check, never used to decide an
 * account until a workflow wires them and a person has compared them with the page.
 *
 * The data is accounts, documents and page references only. A rate, a limit or a deadline is not here (`engine/tax-tables.ts`).
 */
import type { AccountSpec, EntryFamily, EntryLine, EntryRule, EntryStatus } from "./entry-catalog.js";

const code = (c: string): AccountSpec => ({ code: c });
const range = (from: string, to: string): AccountSpec => ({ from, to });
const line = (dt: AccountSpec, cr: AccountSpec, basis: EntryLine["basis"] = "gross"): EntryLine => ({
  dt,
  cr,
  basis,
});

interface Row {
  page: number;
  row: number;
}

function rule(
  family: EntryFamily,
  operation: string,
  title: { uz: string; en: string },
  lines: EntryLine[],
  at: Row | null,
  extra: {
    status?: EntryStatus;
    onec?: string;
    operationType?: string;
    trigger?: EntryRule["trigger"];
    support?: string[];
    variantOf?: string;
    noSource?: string;
    confirm?: string;
    id?: string;
  } = {},
): EntryRule {
  return {
    id: extra.id ?? (at ? `b1-p${at.page}-n${at.row}` : `none-${operation}`),
    family,
    operation,
    title,
    trigger: extra.trigger ?? { source: "manual" },
    ...(extra.onec
      ? {
          document: {
            onec: extra.onec,
            ...(extra.operationType ? { operationType: extra.operationType } : {}),
          },
        }
      : {}),
    lines,
    support: extra.support ?? [],
    ...(extra.variantOf ? { variantOf: extra.variantOf } : {}),
    ...(at ? { source: { book: "B1" as const, page: at.page, row: at.row } } : {}),
    ...(extra.noSource ? { noSource: extra.noSource } : {}),
    status: extra.status ?? "checked",
    ...(extra.confirm ? { confirm: extra.confirm } : {}),
  };
}

const bank = { source: "bank_line" as const };
const cashOrder = { source: "cash_order" as const };
const doc = { source: "document" as const };

export const ENTRY_RULES: EntryRule[] = [
  // --- the 16 operations of the decision centre ------------------------------------------------------------------------------------
  rule(
    "stock",
    "purchase_goods",
    { uz: "Tovarlarni xarid qilish", en: "Purchase of goods" },
    [line(range("2910", "2990"), code("6010"))],
    { page: 91, row: 10 },
    { onec: "Поступление товаров и услуг", trigger: doc, support: ["supplier invoice", "waybill"] },
  ),
  rule(
    "income_expense",
    "sale_products",
    { uz: "Tayyor mahsulotni sotish", en: "Sale of finished products" },
    [line(code("4010"), code("9010"), "net")],
    { page: 89, row: 21 },
    { onec: "Реализация", trigger: doc, support: ["invoice", "waybill"] },
  ),
  rule(
    "income_expense",
    "sale_goods",
    { uz: "Tovarlarni sotish", en: "Sale of goods" },
    [line(code("4010"), code("9020"), "net")],
    { page: 92, row: 35 },
    { onec: "Реализация", trigger: doc, support: ["invoice", "waybill"] },
  ),
  rule(
    "income_expense",
    "sale_services",
    { uz: "Xizmatlarni sotish", en: "Sale of services" },
    [line(code("4010"), code("9030"), "net")],
    { page: 53, row: 5 },
    { onec: "Реализация", trigger: doc, support: ["invoice", "act"] },
  ),
  rule(
    "taxes",
    "sale_vat",
    { uz: "Sotuvdagi QQS", en: "VAT on a sale" },
    [line(code("4010"), code("6410"), "vat")],
    { page: 89, row: 21 },
    { onec: "Реализация", trigger: doc, support: ["invoice"], id: "b1-p89-n21-vat" },
  ),
  rule(
    "settlements",
    "payment_from_buyer",
    { uz: "Xaridordan to'lov", en: "Payment from a buyer" },
    [line(code("5110"), code("4010"))],
    { page: 98, row: 13 },
    { onec: "Поступление на расчетный счет", trigger: bank },
  ),
  rule(
    "settlements",
    "payment_to_supplier",
    { uz: "Yetkazib beruvchiga to'lov", en: "Payment to a supplier" },
    [line(code("6010"), code("5110"))],
    { page: 127, row: 74 },
    { onec: "Списание с расчетного счета", trigger: bank },
  ),
  rule(
    "income_expense",
    "bank_fee",
    { uz: "Bank xizmati", en: "Bank fee" },
    [line(code("9430"), code("5110"), "fee")],
    { page: 128, row: 100 },
    { onec: "Списание с расчетного счета", trigger: bank },
  ),
  rule(
    "taxes",
    "profit_tax_accrual",
    { uz: "Foyda solig'ini hisoblash", en: "Profit tax accrual" },
    [line(code("9810"), code("6410"))],
    { page: 244, row: 1 },
    {
      onec: "Операция",
      trigger: { source: "period_close" },
      confirm: "the budget sub-account: the practice set books profit tax to 6430, the book lists only 6410",
    },
  ),
  rule(
    "settlements",
    "advance_from_buyer",
    { uz: "Xaridordan avans", en: "Advance from a buyer" },
    [line(code("5110"), code("6310"))],
    { page: 125, row: 35 },
    { onec: "Поступление на расчетный счет", trigger: bank },
  ),
  rule(
    "settlements",
    "advance_to_supplier",
    { uz: "Yetkazib beruvchiga avans", en: "Advance to a supplier" },
    [line(code("4310"), code("5110"))],
    { page: 105, row: 1 },
    { onec: "Списание с расчетного счета", trigger: bank },
  ),
  rule(
    "capital",
    "capital_contribution",
    { uz: "Ta'sischi hissasi", en: "Founder's contribution" },
    [line(code("5110"), code("4610"))],
    { page: 109, row: 15 },
    { onec: "Поступление на расчетный счет", trigger: bank },
  ),
  rule(
    "cash_bank",
    "cash_to_bank_order",
    { uz: "Kassadan bankka (order)", en: "Cash to the bank, the cash order" },
    [line(code("5710"), code("5010"))],
    { page: 122, row: 54 },
    { onec: "Расходный кассовый ордер", trigger: cashOrder },
  ),
  rule(
    "cash_bank",
    "cash_deposit",
    { uz: "Kassadan bankka (bank kirimi)", en: "Cash to the bank, the bank receipt" },
    [line(code("5110"), code("5710"))],
    { page: 125, row: 30 },
    { onec: "Поступление на расчетный счет", trigger: bank },
  ),
  // The book books cash drawn on a cheque directly 5010 / 5110 (p120 #18), and uses 5710 only for money still on the way. Both are
  // legitimate; the company's own earlier documents choose (TD C2). The first has no row in the book: that is the recorded exception.
  rule(
    "cash_bank",
    "cash_withdrawal",
    { uz: "Bankdan naqd pul (5710 orqali)", en: "Cash from the bank, through the transit account" },
    [line(code("5710"), code("5110"))],
    null,
    {
      onec: "Списание с расчетного счета",
      trigger: bank,
      noSource:
        "the book books cash from the bank directly (variant); the first leg through 5710 is the engine's own",
      id: "cash-withdrawal-transit",
    },
  ),
  rule(
    "cash_bank",
    "cash_withdrawal",
    { uz: "Bankdan naqd pul (to'g'ridan-to'g'ri)", en: "Cash from the bank, direct" },
    [line(code("5010"), code("5110"))],
    { page: 120, row: 18 },
    {
      onec: "Списание с расчетного счета",
      trigger: bank,
      variantOf: "cash_withdrawal",
      status: "checked",
      confirm: "direct, or through 5710: the company's earlier documents choose",
    },
  ),
  rule(
    "cash_bank",
    "cash_from_bank_order",
    { uz: "Bankdan kassaga (order)", en: "Cash from the bank, the cash receipt" },
    [line(code("5010"), code("5710"))],
    { page: 120, row: 21 },
    { onec: "Приходный кассовый ордер", trigger: cashOrder },
  ),

  // --- the families the engine has no rule for yet: known pairs for the entry check, parsed only -----------------------------------
  rule(
    "income_expense",
    "cost_of_sales",
    { uz: "Sotilgan mahsulot tannarxi", en: "Cost of sales" },
    [line(range("9110", "9130"), code("2810"), "cost")],
    { page: 89, row: 21 },
    { status: "parsed", id: "b1-p89-n21-cost", trigger: doc },
  ),
  rule(
    "stock",
    "materials_purchase",
    { uz: "Materiallarni xarid qilish", en: "Purchase of materials" },
    [line(range("1010", "1090"), code("6010"))],
    { page: 59, row: 2 },
    { status: "parsed", trigger: doc },
  ),
  rule(
    "fixed_assets",
    "fixed_asset_acquisition",
    { uz: "Asosiy vositani olish", en: "Acquisition of a fixed asset" },
    [line(range("0810", "0820"), range("6010", "7010"))],
    { page: 48, row: 28 },
    { status: "parsed", trigger: doc },
  ),
  rule(
    "fixed_assets",
    "depreciation_production",
    { uz: "Eskirish (ishlab chiqarish)", en: "Depreciation, production" },
    [line(code("2010"), range("0210", "0290"))],
    { page: 70, row: 1 },
    { status: "parsed", trigger: { source: "period_close" } },
  ),
  rule(
    "fixed_assets",
    "depreciation_administrative",
    { uz: "Eskirish (boshqaruv)", en: "Depreciation, administrative" },
    [line(code("9420"), range("0210", "0299"))],
    { page: 237, row: 14 },
    { status: "parsed", trigger: { source: "period_close" } },
  ),
  rule(
    "loans",
    "loan_received",
    { uz: "Bank krediti olindi", en: "Bank loan received" },
    [line(code("5110"), code("6810"))],
    { page: 125, row: 36 },
    { status: "parsed", trigger: bank },
  ),
  rule(
    "loans",
    "loan_interest",
    { uz: "Kredit foizlari", en: "Loan interest accrued" },
    [line(code("9610"), code("6920"))],
    { page: 179, row: 9 },
    { status: "parsed", trigger: { source: "period_close" } },
  ),
  rule(
    "capital",
    "charter_capital",
    { uz: "Ustav kapitali", en: "Charter capital" },
    [line(code("4610"), code("8330"))],
    { page: 108, row: 3 },
    { status: "parsed", trigger: { source: "manual" } },
  ),
  rule(
    "capital",
    "cash_contribution",
    { uz: "Kassaga hissa", en: "Contribution in cash" },
    [line(code("5010"), code("4610"))],
    { page: 109, row: 14 },
    { status: "parsed", trigger: cashOrder },
  ),
  rule(
    "capital",
    "dividends_accrual",
    { uz: "Dividendlarni hisoblash", en: "Dividends accrued" },
    [line(code("8710"), code("6610"))],
    { page: 169, row: 1 },
    { status: "parsed", trigger: { source: "manual" } },
  ),
  rule(
    "production",
    "materials_to_production",
    { uz: "Materiallar ishlab chiqarishga", en: "Materials to production" },
    [line(code("2010"), code("1010"), "cost")],
    { page: 60, row: 27 },
    { status: "parsed", trigger: doc, onec: "Требование-накладная" },
  ),
  rule(
    "production",
    "wages_to_production",
    { uz: "Ish haqi ishlab chiqarishga", en: "Wages to production" },
    [line(code("2010"), code("6710"))],
    { page: 72, row: 25 },
    { status: "parsed", trigger: { source: "period_close" } },
  ),
  rule(
    "production",
    "production_release",
    { uz: "Tayyor mahsulot omborga", en: "Finished goods into the warehouse" },
    [line(code("2810"), code("2010"), "cost")],
    { page: 73, row: 45 },
    { status: "parsed", trigger: doc, onec: "Отчет производства за смену" },
  ),
  rule(
    "payroll",
    "income_tax_withheld",
    { uz: "Daromad solig'i ushlandi", en: "Income tax withheld" },
    [line(code("6710"), code("6410"), "withheld")],
    { page: 164, row: 11 },
    { status: "parsed", trigger: { source: "period_close" } },
  ),
  rule(
    "payroll",
    "alimony_withheld",
    { uz: "Aliment ushlandi", en: "Alimony withheld" },
    [line(code("6710"), code("6990"), "withheld")],
    { page: 174, row: 53 },
    { status: "parsed", trigger: { source: "period_close" } },
  ),
  rule(
    "payroll",
    "salary_card",
    { uz: "Ish haqi (plastik karta)", en: "Salary by card" },
    [line(code("6710"), code("5110"))],
    { page: 127, row: 83 },
    { status: "parsed", trigger: bank },
  ),
  rule(
    "payroll",
    "salary_cash",
    { uz: "Ish haqi (naqd)", en: "Salary in cash" },
    [line(code("6710"), code("5010"))],
    { page: 122, row: 64 },
    { status: "parsed", trigger: cashOrder },
  ),
  rule(
    "payroll",
    "salary_deposited",
    { uz: "Depozitga qo'yilgan ish haqi", en: "Salary deposited" },
    [line(code("6710"), code("6720"))],
    { page: 174, row: 49 },
    { status: "parsed", trigger: { source: "period_close" } },
  ),
  rule(
    "taxes",
    "other_taxes_accrual",
    { uz: "Boshqa soliqlar", en: "Other taxes accrued" },
    [line(code("9430"), code("6410"))],
    { page: 238, row: 33 },
    { status: "parsed", trigger: { source: "period_close" } },
  ),
];

/** The pairs the entry check and the ladder compare against, `parsed` rules included. */
export const KNOWN_ENTRY_RULES: readonly EntryRule[] = ENTRY_RULES;
