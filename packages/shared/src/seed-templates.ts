/**
 * The questions an accountant asks every day, answered by the engine with a fixed 1C query and no model: the seed of
 * the template library. They are written for the standard accounting register (РегистрБухгалтерии.Хозрасчетный) and the
 * standard documents, by the chart's account groups (50 cash, 51/52/55 bank, 40 receivables, 60 payables, 90 revenue,
 * 91 cost of sales, 94 period expenses, 10/29 stock). A query that a configuration does not accept fails on the PC and the
 * question goes to the model as before, so a seed can cost nothing but the one failed read. Each answer has the
 * "Ask AI anyway" button. Questions are matched strictly (see the matcher): every word of one intent must be in the
 * question and no other meaningful word.
 */
import type { QueryTemplateInput } from "./ai-policy.js";

type Seed = Omit<QueryTemplateInput, "enabled" | "action"> & Partial<Pick<QueryTemplateInput, "enabled">>;

const END = "КОНЕЦПЕРИОДА(&Дата, ДЕНЬ)";
const MONTH_END = "КОНЕЦПЕРИОДА(&Конец, ДЕНЬ)";
const DATE_PARAM = [{ name: "Дата", type: "date" as const }];
const MONTH_PARAMS = [
  { name: "Начало", type: "month_start" as const },
  { name: "Конец", type: "month_end" as const },
];

/** Balances at the end of a day by account group: debit minus credit, grouped as asked. */
const balanceBy = (prefixes: string[], sign: "dt" | "kt") =>
  `ВЫБРАТЬ Т.Счет.Код КАК Счет, Т.Счет.Наименование КАК Наименование, ` +
  `СУММА(${sign === "dt" ? "Т.СуммаОстатокДт - Т.СуммаОстатокКт" : "Т.СуммаОстатокКт - Т.СуммаОстатокДт"}) КАК Остаток ` +
  `ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(${END}, , , ) КАК Т ` +
  `ГДЕ ПОДСТРОКА(Т.Счет.Код, 1, 2) В (${prefixes.map((p) => `"${p}"`).join(", ")}) ` +
  `СГРУППИРОВАТЬ ПО Т.Счет.Код, Т.Счет.Наименование УПОРЯДОЧИТЬ ПО Счет`;

/** The counterparties' balances on an account group, largest first. */
const byCounterparty = (prefix: string, sign: "dt" | "kt", label: string) =>
  `ВЫБРАТЬ ПЕРВЫЕ 50 Т.Субконто1 КАК Контрагент, ` +
  `СУММА(${sign === "dt" ? "Т.СуммаОстатокДт - Т.СуммаОстатокКт" : "Т.СуммаОстатокКт - Т.СуммаОстатокДт"}) КАК ${label} ` +
  `ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(${END}, , , ) КАК Т ` +
  `ГДЕ ПОДСТРОКА(Т.Счет.Код, 1, 2) = "${prefix}" ` +
  `СГРУППИРОВАТЬ ПО Т.Субконто1 ` +
  `ИМЕЮЩИЕ СУММА(Т.СуммаОстатокДт - Т.СуммаОстатокКт) <> 0 УПОРЯДОЧИТЬ ПО ${label} УБЫВ`;

/** What a document kind holds, by counterparty, for a month. */
const documentsBy = (object: string) =>
  `ВЫБРАТЬ ПЕРВЫЕ 50 Т.Контрагент КАК Контрагент, КОЛИЧЕСТВО(*) КАК Документов, СУММА(Т.СуммаДокумента) КАК Сумма ` +
  `ИЗ Документ.${object} КАК Т ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления И Т.Дата МЕЖДУ &Начало И ${MONTH_END} ` +
  `СГРУППИРОВАТЬ ПО Т.Контрагент УПОРЯДОЧИТЬ ПО Сумма УБЫВ`;

const documentsTotal = (object: string) =>
  `ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК Документов, СУММА(Т.СуммаДокумента) КАК Сумма ` +
  `ИЗ Документ.${object} КАК Т ГДЕ Т.Проведен И НЕ Т.ПометкаУдаления И Т.Дата МЕЖДУ &Начало И ${MONTH_END}`;

/** Turnovers of an account group for a month, by account. */
const turnoverBy = (prefix: string) =>
  `ВЫБРАТЬ Т.Счет.Код КАК Счет, Т.Счет.Наименование КАК Наименование, ` +
  `СУММА(Т.СуммаОборотДт) КАК Дебет, СУММА(Т.СуммаОборотКт) КАК Кредит, СУММА(Т.СуммаОборотДт - Т.СуммаОборотКт) КАК Сальдо ` +
  `ИЗ РегистрБухгалтерии.Хозрасчетный.Обороты(&Начало, ${MONTH_END}) КАК Т ` +
  `ГДЕ ПОДСТРОКА(Т.Счет.Код, 1, 2) = "${prefix}" ` +
  `СГРУППИРОВАТЬ ПО Т.Счет.Код, Т.Счет.Наименование УПОРЯДОЧИТЬ ПО Счет`;

const DOC_KINDS: [string, string][] = [
  ["Поступление товаров и услуг", "ПоступлениеТоваровУслуг"],
  ["Реализация товаров и услуг", "РеализацияТоваровУслуг"],
  ["Счёт-фактура выданный", "СчетФактураВыданный"],
  ["Счёт-фактура полученный", "СчетФактураПолученный"],
  ["Поступление на расчётный счёт", "ПоступлениеНаРасчетныйСчет"],
  ["Списание с расчётного счёта", "СписаниеСРасчетногоСчета"],
];

/** A count of documents of the main kinds, by a condition on each. */
const countsOf = (condition: string, period: boolean) =>
  DOC_KINDS.map(
    ([title, object]) =>
      `ВЫБРАТЬ "${title}" КАК Вид, КОЛИЧЕСТВО(*) КАК Документов ИЗ Документ.${object} КАК Т ГДЕ ${condition}${
        period ? ` И Т.Дата МЕЖДУ &Начало И ${MONTH_END}` : ""
      }`,
  ).join(" ОБЪЕДИНИТЬ ВСЕ ");

export const SEED_TEMPLATES: Seed[] = [
  {
    code: "seed_cash_balance",
    title: "Cash balance",
    intents: [
      "остаток кассе",
      "остатки кассы",
      "касса остаток",
      "сколько денег кассе",
      "kassa qoldig'i",
      "kassadagi qoldiq",
      "kassada qoldiq",
      "cash balance",
      "balance cash",
      "cash hand",
    ],
    query: balanceBy(["50"], "dt"),
    params: DATE_PARAM,
    columns: [
      { label: "Account", format: "text" },
      { label: "Name", format: "text" },
      { label: "Balance", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_bank_balance",
    title: "Bank account balances",
    intents: [
      "остаток расчетном счете",
      "остатки расчетным счетам",
      "остатки банке",
      "остаток банку",
      "расчетный счет остаток",
      "bank qoldig'i",
      "hisob raqamdagi qoldiq",
      "hisob raqam qoldig'i",
      "bank balance",
      "bank accounts balance",
    ],
    query: balanceBy(["51", "52", "55"], "dt"),
    params: DATE_PARAM,
    columns: [
      { label: "Account", format: "text" },
      { label: "Name", format: "text" },
      { label: "Balance", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_account_balance",
    title: "Account balance",
    intents: ["остаток счету", "сальдо счету", "hisob qoldig'i", "account balance", "balance account"],
    query:
      `ВЫБРАТЬ Т.Счет.Код КАК Счет, Т.Счет.Наименование КАК Наименование, ` +
      `СУММА(Т.СуммаОстатокДт) КАК Дебет, СУММА(Т.СуммаОстатокКт) КАК Кредит ` +
      `ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(${END}, , , ) КАК Т ` +
      `ГДЕ ПОДСТРОКА(Т.Счет.Код, 1, ДЛИНАСТРОКИ(&КодСчета)) = &КодСчета ` +
      `СГРУППИРОВАТЬ ПО Т.Счет.Код, Т.Счет.Наименование УПОРЯДОЧИТЬ ПО Счет`,
    params: [...DATE_PARAM, { name: "КодСчета", type: "text" }],
    columns: [
      { label: "Account", format: "text" },
      { label: "Name", format: "text" },
      { label: "Debit", format: "money" },
      { label: "Credit", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_receivables",
    title: "Receivables by counterparty",
    intents: [
      "дебиторская задолженность",
      "дебиторка",
      "нам должны",
      "кто нам должен",
      "debitorlik qarzi",
      "debitor qarzdorlik",
      "bizga qarzdor",
      "receivables",
      "accounts receivable",
      "who owes us",
    ],
    query: byCounterparty("40", "dt", "Долг"),
    params: DATE_PARAM,
    columns: [
      { label: "Counterparty", format: "text" },
      { label: "Owes us", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_payables",
    title: "Payables by counterparty",
    intents: [
      "кредиторская задолженность",
      "кредиторка",
      "мы должны",
      "кому мы должны",
      "kreditorlik qarzi",
      "kreditor qarzdorlik",
      "biz qarzdormiz",
      "payables",
      "accounts payable",
      "who we owe",
    ],
    query: byCounterparty("60", "kt", "Долг"),
    params: DATE_PARAM,
    columns: [
      { label: "Counterparty", format: "text" },
      { label: "We owe", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_counterparty_balance",
    title: "Balance with a counterparty",
    intents: [
      "сальдо контрагенту",
      "задолженность контрагента",
      "взаиморасчеты контрагентом",
      "долг контрагента",
      "kontragent qarzi",
      "kontragent bilan hisob-kitob",
      "balance counterparty",
      "debt counterparty",
    ],
    query:
      `ВЫБРАТЬ Т.Счет.Код КАК Счет, Т.Счет.Наименование КАК Наименование, ` +
      `СУММА(Т.СуммаОстатокДт) КАК Дебет, СУММА(Т.СуммаОстатокКт) КАК Кредит ` +
      `ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(${END}, , , ) КАК Т ` +
      `ГДЕ ВЫРАЗИТЬ(Т.Субконто1 КАК Справочник.Контрагенты).Наименование = &Контрагент ` +
      `СГРУППИРОВАТЬ ПО Т.Счет.Код, Т.Счет.Наименование УПОРЯДОЧИТЬ ПО Счет`,
    params: [...DATE_PARAM, { name: "Контрагент", type: "counterparty" }],
    columns: [
      { label: "Account", format: "text" },
      { label: "Name", format: "text" },
      { label: "Debit", format: "money" },
      { label: "Credit", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_stock_balance",
    title: "Stock and goods balances",
    intents: [
      "остатки товаров",
      "остатки склада",
      "складские остатки",
      "остатки материалов",
      "ombor qoldig'i",
      "tovar qoldig'i",
      "stock balance",
      "inventory balance",
    ],
    query: balanceBy(["10", "29"], "dt"),
    params: DATE_PARAM,
    columns: [
      { label: "Account", format: "text" },
      { label: "Name", format: "text" },
      { label: "Value", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_negative_cash",
    title: "Cash accounts with a credit balance (an error)",
    intents: [
      "отрицательный остаток кассе",
      "минус кассе",
      "kassada manfiy qoldiq",
      "negative cash",
      "negative cash balance",
    ],
    query:
      `ВЫБРАТЬ Т.Счет.Код КАК Счет, Т.Счет.Наименование КАК Наименование, СУММА(Т.СуммаОстатокКт - Т.СуммаОстатокДт) КАК Минус ` +
      `ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(${END}, , , ) КАК Т ГДЕ ПОДСТРОКА(Т.Счет.Код, 1, 2) = "50" ` +
      `СГРУППИРОВАТЬ ПО Т.Счет.Код, Т.Счет.Наименование ИМЕЮЩИЕ СУММА(Т.СуммаОстатокКт - Т.СуммаОстатокДт) > 0`,
    params: DATE_PARAM,
    columns: [
      { label: "Account", format: "text" },
      { label: "Name", format: "text" },
      { label: "Negative by", format: "money" },
    ],
    totals: false,
  },
  {
    code: "seed_sales_by_counterparty",
    title: "Sales by counterparty",
    intents: [
      "продажи контрагентам",
      "реализация контрагентам",
      "продажи месяц контрагентам",
      "kontragentlar bo'yicha sotuv",
      "sotuvlar kontragentlar",
      "sales by counterparty",
      "sales per customer",
    ],
    query: documentsBy("РеализацияТоваровУслуг"),
    params: MONTH_PARAMS,
    columns: [
      { label: "Counterparty", format: "text" },
      { label: "Documents", format: "number" },
      { label: "Amount", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_purchases_by_counterparty",
    title: "Purchases by counterparty",
    intents: [
      "закупки поставщикам",
      "поступления поставщиков",
      "покупки контрагентов",
      "xaridlar kontragentlar",
      "ta'minotchilar bo'yicha xarid",
      "purchases by supplier",
      "purchases by counterparty",
    ],
    query: documentsBy("ПоступлениеТоваровУслуг"),
    params: MONTH_PARAMS,
    columns: [
      { label: "Counterparty", format: "text" },
      { label: "Documents", format: "number" },
      { label: "Amount", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_sales_total",
    title: "Sales total",
    intents: [
      "сумма продаж",
      "объем продаж",
      "общая реализация",
      "sotuv summasi",
      "sotuv hajmi",
      "sales total",
      "total sales",
    ],
    query: documentsTotal("РеализацияТоваровУслуг"),
    params: MONTH_PARAMS,
    columns: [
      { label: "Documents", format: "number" },
      { label: "Amount", format: "money" },
    ],
    totals: false,
  },
  {
    code: "seed_purchases_total",
    title: "Purchases total",
    intents: [
      "сумма закупок",
      "объем закупок",
      "общие поступления",
      "xarid summasi",
      "xarid hajmi",
      "purchases total",
      "total purchases",
    ],
    query: documentsTotal("ПоступлениеТоваровУслуг"),
    params: MONTH_PARAMS,
    columns: [
      { label: "Documents", format: "number" },
      { label: "Amount", format: "money" },
    ],
    totals: false,
  },
  {
    code: "seed_revenue",
    title: "Revenue by account (group 90)",
    intents: ["выручка", "доходы от реализации", "daromad", "tushum sotuvdan", "revenue", "sales revenue"],
    query: turnoverBy("90"),
    params: MONTH_PARAMS,
    columns: [
      { label: "Account", format: "text" },
      { label: "Name", format: "text" },
      { label: "Debit", format: "money" },
      { label: "Credit", format: "money" },
      { label: "Debit − Credit", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_cost_of_sales",
    title: "Cost of sales (group 91)",
    intents: [
      "себестоимость продаж",
      "себестоимость реализации",
      "sotuv tannarxi",
      "realizatsiya tannarxi",
      "cost sales",
      "cost of sales",
    ],
    query: turnoverBy("91"),
    params: MONTH_PARAMS,
    columns: [
      { label: "Account", format: "text" },
      { label: "Name", format: "text" },
      { label: "Debit", format: "money" },
      { label: "Credit", format: "money" },
      { label: "Debit − Credit", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_period_expenses",
    title: "Period expenses (group 94)",
    intents: [
      "расходы периода",
      "затраты периода",
      "коммерческие расходы",
      "davr xarajatlari",
      "xarajatlar oy",
      "period expenses",
      "operating expenses",
    ],
    query: turnoverBy("94"),
    params: MONTH_PARAMS,
    columns: [
      { label: "Account", format: "text" },
      { label: "Name", format: "text" },
      { label: "Debit", format: "money" },
      { label: "Credit", format: "money" },
      { label: "Debit − Credit", format: "money" },
    ],
    totals: true,
  },
  {
    code: "seed_bank_receipts",
    title: "Bank receipts for the month",
    intents: [
      "поступления расчетный счет",
      "поступило банк",
      "приход банку",
      "bankka tushum",
      "bank tushumlari",
      "bank receipts",
      "money received bank",
    ],
    query: documentsTotal("ПоступлениеНаРасчетныйСчет"),
    params: MONTH_PARAMS,
    columns: [
      { label: "Documents", format: "number" },
      { label: "Amount", format: "money" },
    ],
    totals: false,
  },
  {
    code: "seed_bank_payments",
    title: "Bank payments for the month",
    intents: [
      "списания расчетного счета",
      "платежи банк",
      "расход банку",
      "bankdan to'lovlar",
      "bank to'lovlari",
      "bank payments",
      "money paid bank",
    ],
    query: documentsTotal("СписаниеСРасчетногоСчета"),
    params: MONTH_PARAMS,
    columns: [
      { label: "Documents", format: "number" },
      { label: "Amount", format: "money" },
    ],
    totals: false,
  },
  {
    code: "seed_unposted_documents",
    title: "Unposted documents for the month",
    intents: [
      "непроведенные документы",
      "не проведенные документы",
      "o'tkazilmagan hujjatlar",
      "provodka qilinmagan hujjatlar",
      "unposted documents",
    ],
    query: countsOf("НЕ Т.Проведен И НЕ Т.ПометкаУдаления", true),
    params: MONTH_PARAMS,
    columns: [
      { label: "Kind", format: "text" },
      { label: "Unposted", format: "number" },
    ],
    totals: true,
  },
  {
    code: "seed_marked_documents",
    title: "Documents marked for deletion",
    intents: [
      "документы пометкой удаления",
      "помеченные удаление",
      "o'chirishga belgilangan hujjatlar",
      "marked deletion documents",
      "documents marked deletion",
    ],
    query: countsOf("Т.ПометкаУдаления", false),
    params: [],
    columns: [
      { label: "Kind", format: "text" },
      { label: "Marked", format: "number" },
    ],
    totals: true,
  },
  {
    code: "seed_duplicate_receipts",
    title: "Possible duplicate receipts (same supplier, date and amount)",
    intents: [
      "дубли поступлений",
      "повторяющиеся поступления",
      "дубликаты поступлений",
      "takroriy kirimlar",
      "duplicate receipts",
      "duplicate purchases",
    ],
    query:
      `ВЫБРАТЬ ПЕРВЫЕ 100 Т.Контрагент КАК Контрагент, НАЧАЛОПЕРИОДА(Т.Дата, ДЕНЬ) КАК Дата, Т.СуммаДокумента КАК Сумма, КОЛИЧЕСТВО(*) КАК Документов ` +
      `ИЗ Документ.ПоступлениеТоваровУслуг КАК Т ГДЕ НЕ Т.ПометкаУдаления И Т.Дата МЕЖДУ &Начало И ${MONTH_END} ` +
      `СГРУППИРОВАТЬ ПО Т.Контрагент, НАЧАЛОПЕРИОДА(Т.Дата, ДЕНЬ), Т.СуммаДокумента ИМЕЮЩИЕ КОЛИЧЕСТВО(*) > 1 УПОРЯДОЧИТЬ ПО Сумма УБЫВ`,
    params: MONTH_PARAMS,
    columns: [
      { label: "Counterparty", format: "text" },
      { label: "Date", format: "date" },
      { label: "Amount", format: "money" },
      { label: "Documents", format: "number" },
    ],
    totals: false,
  },
  {
    code: "seed_currency_rates",
    title: "Currency rates",
    intents: [
      "курс валют",
      "курс доллара",
      "курс валюты",
      "valyuta kursi",
      "dollar kursi",
      "exchange rate",
      "currency rates",
      "dollar rate",
    ],
    query:
      `ВЫБРАТЬ Т.Валюта.Код КАК Код, Т.Валюта.Наименование КАК Валюта, Т.Курс КАК Курс, Т.Кратность КАК Кратность, Т.Период КАК Дата ` +
      `ИЗ РегистрСведений.КурсыВалют.СрезПоследних(${END}, ) КАК Т УПОРЯДОЧИТЬ ПО Код`,
    params: DATE_PARAM,
    columns: [
      { label: "Code", format: "text" },
      { label: "Currency", format: "text" },
      { label: "Rate", format: "number" },
      { label: "Multiplicity", format: "number" },
      { label: "Rate date", format: "date" },
    ],
    totals: false,
  },
];

/** The templates as the dashboard's input form takes them (every one is on). */
export const seedTemplateInputs = (): QueryTemplateInput[] =>
  SEED_TEMPLATES.map((t) => ({ ...t, action: null, enabled: t.enabled ?? true }));
