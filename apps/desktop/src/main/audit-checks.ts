/**
 * The audit's checklist: the same checks every time, each run as its own short conversation with
 * the model, so a whole base is covered without one huge chat. The instructions are for the model
 * (in English); the titles are shown to the accountant in the window's language.
 *
 * Account numbers are the usual НСБУ ones; every check is told to look them up in the base's chart
 * of accounts when they do not fit.
 */
import type { UiLanguage } from "../shared/ipc.js";

export interface AuditCheck {
  id: string;
  section: AuditSection;
  title: Record<UiLanguage, string>;
  /** What to check and how, for the model. */
  instructions: string;
}

export type AuditSection =
  | "books"
  | "cash"
  | "settlements"
  | "inventory"
  | "assets"
  | "import"
  | "vat"
  | "payroll"
  | "closing"
  | "documents";

export const AUDIT_SECTIONS: Record<AuditSection, Record<UiLanguage, string>> = {
  books: { en: "Books", ru: "Учёт в целом", uz: "Umumiy hisob" },
  cash: { en: "Cash and bank", ru: "Касса и банк", uz: "Kassa va bank" },
  settlements: { en: "Settlements", ru: "Расчёты", uz: "Hisob-kitoblar" },
  inventory: { en: "Inventory", ru: "Запасы", uz: "Tovar-moddiy zaxiralar" },
  assets: { en: "Fixed assets", ru: "Основные средства", uz: "Asosiy vositalar" },
  import: { en: "Import and currency", ru: "Импорт и валюта", uz: "Import va valyuta" },
  vat: { en: "VAT and invoices", ru: "НДС и счета-фактуры", uz: "QQS va hisob-fakturalar" },
  payroll: { en: "Payroll and taxes", ru: "Зарплата и налоги", uz: "Ish haqi va soliqlar" },
  closing: { en: "Month-end closing", ru: "Закрытие месяца", uz: "Oyni yopish" },
  documents: {
    en: "Documents and directories",
    ru: "Документы и справочники",
    uz: "Hujjatlar va maʼlumotnomalar",
  },
};

export const AUDIT_CHECKS: AuditCheck[] = [
  // --- Books -----------------------------------------------------------------------------------
  {
    id: "trial_balance",
    section: "books",
    title: { en: "Trial balance agrees", ru: "Сходимость ОСВ", uz: "AOV (ОСВ) muvozanati" },
    instructions:
      "Build the trial balance for the period from РегистрБухгалтерии.Хозрасчетный.ОстаткиИОбороты (by account, " +
      "for this organization): opening, turnover and closing, debit and credit. Totals of debit and credit must be " +
      "equal in each column. Report any account with a balance on the wrong side for its type (active account " +
      "with a credit balance, passive with a debit balance), and any account that is used but missing from the " +
      "chart of accounts' usual structure.",
  },
  {
    id: "accounting_policy",
    section: "books",
    title: {
      en: "Accounting policy and settings",
      ru: "Учётная политика и настройки",
      uz: "Hisob siyosati va sozlamalar",
    },
    instructions:
      "Check that the organization has an accounting policy for the period (the configuration's accounting policy " +
      "register or document; find it in Справочник.ИдентификаторыОбъектовМетаданных by Синоним like '%Учетная " +
      "политика%') and that the organization's details (INN, VAT payer status) are filled. Report gaps.",
  },
  // --- Cash and bank ---------------------------------------------------------------------------
  {
    id: "cash_negative",
    section: "cash",
    title: { en: "Negative cash balance", ru: "Отрицательный остаток кассы", uz: "Kassada manfiy qoldiq" },
    instructions:
      "Find days in the period when a cash account (50xx) had a credit (negative) balance: daily balances with " +
      "РегистрБухгалтерии.Хозрасчетный.ОстаткиИОбороты(&Начало, &Конец, День, ...). Report each such day with the " +
      "amount and the documents of that day that caused it.",
  },
  {
    id: "bank_negative",
    section: "cash",
    title: {
      en: "Negative bank balance",
      ru: "Отрицательный остаток на счетах",
      uz: "Bank hisobida manfiy qoldiq",
    },
    instructions:
      "Find days when a bank account (51xx, 52xx; by the bank account subconto) had a credit (negative) balance, " +
      "with daily ОстаткиИОбороты. Report each with the amount and the payments of that day.",
  },
  {
    id: "bank_unmatched",
    section: "cash",
    title: {
      en: "Payments without counterparty or contract",
      ru: "Платежи без контрагента или договора",
      uz: "Kontragent yoki shartnomasiz toʻlovlar",
    },
    instructions:
      "In the period's bank and cash documents (ПоступлениеНаРасчетныйСчет, СписаниеСРасчетногоСчета, cash " +
      "receipts and payments), find those without a counterparty, contract or cash flow item where the operation " +
      "needs them, and those whose payment breakdown is empty. Count them and list the largest.",
  },
  // --- Settlements -----------------------------------------------------------------------------
  {
    id: "customers",
    section: "settlements",
    title: { en: "Customer debts", ru: "Дебиторская задолженность покупателей", uz: "Xaridorlar qarzi" },
    instructions:
      "From the balances of customer accounts (40xx, and advances received 6310) by counterparty and contract at " +
      "the end of the period: list the largest debts, debts with no movement for over 90 days (overdue), and " +
      "customers with a credit balance on 40xx (advances that were not moved to 6310).",
  },
  {
    id: "suppliers",
    section: "settlements",
    title: {
      en: "Supplier debts",
      ru: "Кредиторская задолженность поставщикам",
      uz: "Yetkazib beruvchilarga qarz",
    },
    instructions:
      "From the balances of supplier accounts (60xx, and advances paid 4310) by counterparty and contract at the " +
      "end of the period: list the largest debts, debts with no movement for over 90 days, and suppliers with a " +
      "debit balance on 60xx (prepayments not moved to 4310).",
  },
  {
    id: "offsets",
    section: "settlements",
    title: {
      en: "Debts to offset",
      ru: "Встречные долги к зачёту",
      uz: "Oʻzaro hisob-kitob qilinadigan qarzlar",
    },
    instructions:
      "Find counterparties that at the end of the period both owe the company and are owed by it (a debit balance " +
      "on 40xx/4310 and a credit balance on 60xx/6310 at the same time), or with an advance and a debt on the same " +
      "contract that were not offset. Report each with both amounts.",
  },
  {
    id: "accountable",
    section: "settlements",
    title: { en: "Accountable persons", ru: "Подотчётные лица", uz: "Hisobdor shaxslar" },
    instructions:
      "Balances of accountable persons (4220 and the like) at the end of the period: amounts issued and not " +
      "reported for over 30 days, and credit balances (overspending not reimbursed).",
  },
  // --- Inventory -------------------------------------------------------------------------------
  {
    id: "stock_negative",
    section: "inventory",
    title: { en: "Negative stock", ru: "Отрицательные остатки ТМЗ", uz: "Manfiy TMZ qoldiqlari" },
    instructions:
      "Find items with a negative quantity or amount on inventory accounts (10xx materials, 29xx goods, 28xx " +
      "finished products) by item and warehouse at the end of the period and at month ends. Report them with the " +
      "quantity and amount.",
  },
  {
    id: "stock_mismatch",
    section: "inventory",
    title: {
      en: "Quantity without cost and back",
      ru: "Количество без суммы и наоборот",
      uz: "Miqdorsiz summa va aksincha",
    },
    instructions:
      "Find items on inventory accounts with zero quantity but a non-zero amount, or quantity with a zero amount, " +
      "at the end of the period. Also items whose unit cost differs sharply from their usual cost.",
  },
  {
    id: "margin",
    section: "inventory",
    title: { en: "Sales below cost", ru: "Продажи ниже себестоимости", uz: "Tannarxdan past sotuvlar" },
    instructions:
      "By month: revenue (9010 and the like) and cost of sales (9110). Report months with revenue but no cost of " +
      "sales, months with negative gross margin, and the largest sales made below cost (revenue and cost by " +
      "document from the entries).",
  },
  // --- Fixed assets ----------------------------------------------------------------------------
  {
    id: "depreciation",
    section: "assets",
    title: { en: "Depreciation every month", ru: "Амортизация ежемесячно", uz: "Har oy amortizatsiya" },
    instructions:
      "Check that depreciation (credit 02xx) was charged in every month of the period, and list fixed assets on " +
      "01xx with no depreciation for the period (other than land and assets not depreciated by policy).",
  },
  {
    id: "capital_investments",
    section: "assets",
    title: {
      en: "Assets not put into use",
      ru: "Не введённые в эксплуатацию ОС",
      uz: "Foydalanishga topshirilmagan AV",
    },
    instructions:
      "Balances on capital investment accounts (08xx) at the end of the period by object, with the date of the " +
      "last movement: report amounts older than 90 days that were not commissioned to 01xx.",
  },
  // --- Import and currency ---------------------------------------------------------------------
  {
    id: "import_customs",
    section: "import",
    title: { en: "Imports with customs declarations (ГТД)", ru: "Импорт и ГТД", uz: "Import va BYD (ГТД)" },
    instructions:
      "Find the period's receipts from foreign suppliers (contract currency not UZS, or a non-resident " +
      "counterparty). Find the configuration's customs declaration document (ИдентификаторыОбъектовМетаданных, " +
      "Синоним like '%ГТД%' or '%аможен%'). Report receipts with no declaration, declarations with no receipt, " +
      "customs duty and fees not included in the cost of the goods, and import VAT missing from the input VAT " +
      "account or entered twice. If the company had no imports in the period, the status is not_applicable.",
  },
  {
    id: "currency_revaluation",
    section: "import",
    title: { en: "Currency revaluation", ru: "Переоценка валюты", uz: "Valyutani qayta baholash" },
    instructions:
      "If the company has currency accounts (52xx) or settlements in foreign currency: check that exchange " +
      "differences (9540 gains, 9620 losses) were recorded at each month end and that balances in UZS equal the " +
      "currency balance times the Central Bank rate on the last day (РегистрСведений.КурсыВалют). Report months " +
      "and accounts where they differ. No currency: not_applicable.",
  },
  // --- VAT and invoices ------------------------------------------------------------------------
  {
    id: "sales_invoices",
    section: "vat",
    title: {
      en: "Sales without invoices",
      ru: "Реализации без счетов-фактур",
      uz: "Hisob-fakturasiz sotuvlar",
    },
    instructions:
      "Find posted sales (Документ.РеализацияТоваровУслуг and other sale documents) in the period with no issued " +
      "invoice (the invoice document whose base is the sale). Count them, total the amounts and VAT, list the " +
      "largest.",
  },
  {
    id: "purchase_invoices",
    section: "vat",
    title: {
      en: "Purchases without invoices",
      ru: "Поступления без счетов-фактур",
      uz: "Hisob-fakturasiz kirimlar",
    },
    instructions:
      "Find posted purchases (ПоступлениеТоваровУслуг and the like) in the period with VAT but no received invoice " +
      "registered. Count them, total the VAT that cannot be offset, list the largest.",
  },
  {
    id: "vat_accounts",
    section: "vat",
    title: {
      en: "VAT accounts agree with invoices",
      ru: "Счета НДС и счета-фактуры",
      uz: "QQS hisobvaraqlari va hisob-fakturalar",
    },
    instructions:
      "By month: VAT charged on sales (the VAT payable account, credit turnover) against the VAT of issued " +
      "invoices, and input VAT (the input VAT account, debit turnover) against the VAT of received invoices. " +
      "Report months where they differ, with both amounts.",
  },
  // --- Payroll and taxes -----------------------------------------------------------------------
  {
    id: "payroll",
    section: "payroll",
    title: { en: "Payroll every month", ru: "Зарплата ежемесячно", uz: "Har oy ish haqi" },
    instructions:
      "Check that payroll was accrued (credit 6710) in every month of the period, that personal income tax and " +
      "social tax were charged with it, and report debit balances on 6710 (overpaid salary) and salary owed for " +
      "over a month, by employee when available.",
  },
  {
    id: "taxes",
    section: "payroll",
    title: { en: "Tax accounts", ru: "Расчёты с бюджетом", uz: "Byudjet bilan hisob-kitoblar" },
    instructions:
      "Balances of tax accounts (64xx, 65xx and the tax advance accounts) by tax at month ends: debit balances " +
      "(overpaid or unoffset taxes), taxes charged but not paid for over a month, and months with no charge of a " +
      "tax that is charged in other months.",
  },
  // --- Month-end closing -----------------------------------------------------------------------
  {
    id: "month_closing",
    section: "closing",
    title: { en: "Months closed", ru: "Закрытие месяцев", uz: "Oylarning yopilishi" },
    instructions:
      "For each month of the period: are the 9xxx income and expense accounts closed to the financial result " +
      "(9910) with a zero balance at month end, and are production and overhead accounts (2010, 2310, 2510) closed? " +
      "Report the months that are not closed.",
  },
  {
    id: "profit",
    section: "closing",
    title: { en: "Financial result", ru: "Финансовый результат", uz: "Moliyaviy natija" },
    instructions:
      "Net profit or loss by month (9910 and retained earnings 8710). Report losses, sudden changes from month to " +
      "month, and whether profit tax was charged where there was profit.",
  },
  // --- Documents and directories ---------------------------------------------------------------
  {
    id: "unposted",
    section: "documents",
    title: { en: "Unposted documents", ru: "Непроведённые документы", uz: "Oʻtkazilmagan hujjatlar" },
    instructions:
      "Count the period's documents that are neither posted nor marked for deletion, by document type (the main " +
      "types: sales, purchases, bank, cash, invoices, payroll, transfers). List the largest by amount.",
  },
  {
    id: "duplicates",
    section: "documents",
    title: { en: "Duplicate documents", ru: "Дубли документов", uz: "Takroriy hujjatlar" },
    instructions:
      "Find posted documents of the same type with the same date, counterparty and amount (and the same incoming " +
      "number when there is one) in sales, purchases, bank and invoices. Report each group.",
  },
  {
    id: "dates",
    section: "documents",
    title: { en: "Wrong dates", ru: "Ошибки в датах", uz: "Sanalardagi xatolar" },
    instructions:
      "Find documents dated in the future (after today) and documents whose incoming date (supplier's document " +
      "date) is after their own date or far from it (more than 60 days).",
  },
  {
    id: "counterparties",
    section: "documents",
    title: {
      en: "Counterparty directory",
      ru: "Справочник контрагентов",
      uz: "Kontragentlar maʼlumotnomasi",
    },
    instructions:
      "In Справочник.Контрагенты (not marked for deletion): different counterparties with the same INN, INNs of " +
      "the wrong length (9 digits for legal entities, 14 for individuals), and counterparties used in the period's " +
      "documents with no INN.",
  },
  {
    id: "items",
    section: "documents",
    title: { en: "Item directory", ru: "Справочник номенклатуры", uz: "Nomenklatura maʼlumotnomasi" },
    instructions:
      "In Справочник.Номенклатура (not marked for deletion): items with the same name, items used in the period " +
      "without a unit of measure or VAT rate, and services and goods mixed up (a service with stock balances).",
  },
];
