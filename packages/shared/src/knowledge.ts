/**
 * The accounting knowledge the engine carries in itself, so that the model does not have to recall or work it out
 * (and be paid for it) every time: typical entries, formulas, procedures and tax reference, in short entries that
 * the program finds by the words of a question (`searchKnowledge`) and hands to the model in a few lines.
 *
 * What is in it is general НСБУ practice. It is a starting point, never a replacement for the company's own books:
 * the account groups are checked against the base's chart of accounts before they are shown, the company's own
 * posting patterns (learned from its 1C) come first, and an entry says what to confirm. Rates and deadlines of the law
 * change: they are labelled as reference and must be confirmed against the company's documents of that date.
 */

export type KnowledgeKind = "entry" | "formula" | "procedure" | "tax" | "concept";

export interface KnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  /** Words (Russian, Uzbek, English) a question about it uses; matched by their first letters. */
  topics: string[];
  title: string;
  /** The content, a line each. */
  lines: string[];
  /** The 4-digit account groups it names, checked against the base's chart. */
  accounts?: string[];
  /** What the accountant (or the company's own practice) must confirm. */
  confirm?: string;
  /** The `accounting_calc` operation that does its arithmetic. */
  calc?: string;
}

export const KNOWLEDGE: KnowledgeEntry[] = [
  // --- typical entries ---------------------------------------------------------------------------
  {
    id: "entry_purchase_goods",
    kind: "entry",
    topics: [
      "покупка товаров",
      "поступление товаров",
      "закупка",
      "приход товара",
      "xarid tovar",
      "tovar kirimi",
      "purchase goods",
      "goods receipt",
      "поступление",
    ],
    title: "Purchase of goods for resale",
    lines: [
      "Receipt: Дт 2910 (goods) Кт 6010 (supplier), net of VAT.",
      "Input VAT: Дт 4410 (VAT to be offset, the base's own sub-account) Кт 6010.",
      "Payment to the supplier: Дт 6010 Кт 5110 (bank) or 5010 (cash).",
      "Advance paid: Дт 4310 Кт 5110; when the goods arrive, the offset: Дт 6010 Кт 4310.",
      "Goods for resale are 2910; raw materials (1010) are for a producer that processes them.",
    ],
    accounts: ["2910", "6010", "4410", "5110", "4310"],
    confirm:
      "the VAT sub-account and whether the company books goods to 2910 or materials to 1010 (look at its own receipts)",
  },
  {
    id: "entry_purchase_services",
    kind: "entry",
    topics: [
      "услуги полученные",
      "аренда",
      "ижара",
      "расходы услуги",
      "xizmat xarajat",
      "ijara xarajati",
      "services received",
      "rent expense",
      "акт услуг",
    ],
    title: "Services received (rent, consulting, bank fees)",
    lines: [
      "Expense: Дт 9410 (selling) / 9420 (administrative) / 9430 (other operating) Кт 6010, by the nature of the cost and the company's own habit.",
      "Input VAT when the supplier charges it: Дт 4410 Кт 6010.",
      "Costs of production: Дт 2010 / 2310 / 2510 instead of 94xx.",
      "Prepaid rent or insurance: Дт 3110 (deferred expenses) and written off to expense by months.",
    ],
    accounts: ["9410", "9420", "9430", "6010", "4410", "2010", "3110"],
    confirm:
      "which expense account the company uses for this kind of cost: it is the accountant's choice, learned from its earlier acts",
  },
  {
    id: "entry_sale_goods",
    kind: "entry",
    topics: [
      "продажа товаров",
      "реализация товаров",
      "выручка",
      "sotuv tovar",
      "realizatsiya",
      "sale goods",
      "sales revenue",
      "реализация",
    ],
    title: "Sale of goods",
    lines: [
      "Revenue: Дт 4010 (buyer) Кт 9020 (revenue from goods; 9010 finished products, 9030 works and services).",
      "VAT charged: Дт 9020 Кт 6410 (VAT payable; revenue is shown net).",
      "Cost of sales: Дт 9120 (cost of goods; 9110 finished products, 9130 services) Кт 2910.",
      "Receipt: Дт 5110 Кт 4010. Advance received: Дт 5110 Кт 6310; offset: Дт 6310 Кт 4010.",
      "The issued invoice (счёт-фактура) is made from the sale; check its VAT rate and total against the sale.",
    ],
    accounts: ["4010", "9020", "6410", "9120", "2910", "5110", "6310"],
    confirm: "the VAT account and the revenue sub-account the company uses",
  },
  {
    id: "entry_import_gtd",
    kind: "entry",
    topics: [
      "импорт",
      "гтд",
      "таможня",
      "таможенная декларация",
      "import",
      "bojxona",
      "byd",
      "customs",
      "goods import",
    ],
    title: "Import with a customs declaration (GTD)",
    lines: [
      "Goods from the foreign supplier: Дт 2910 (or the procurement account the company uses) Кт 6010, in the contract currency at the rate of the customs declaration date.",
      "Customs duty, customs fee, excise and delivery to the border go into the cost of the goods, shared by customs value (accounting_calc landed_cost).",
      "Import VAT paid at customs is input VAT: Дт 4410 Кт 5110 (or the customs settlement account), offset once against output VAT; it is part of the cost only when the goods are exempt.",
      "Check: customs value = invoice value × the rate (plus freight and insurance to the border by the terms); duty, fee and VAT equal the declaration's column 47.",
      "Payments to customs go through the account the company uses for customs.",
    ],
    accounts: ["2910", "6010", "4410", "5110"],
    calc: "landed_cost",
    confirm:
      "the settlement account for customs payments and how the company books procurement before goods arrive",
  },
  {
    id: "entry_fixed_assets",
    kind: "entry",
    topics: [
      "основные средства",
      "амортизация",
      "износ",
      "ос",
      "asosiy vositalar",
      "eskirish",
      "fixed assets",
      "depreciation",
      "property equipment",
    ],
    title: "Fixed assets: acquisition, commissioning, depreciation, disposal",
    lines: [
      "Acquisition: Дт 0800 (capital investments) Кт 6010; input VAT Дт 4410 Кт 6010.",
      "Commissioning: Дт 0100 Кт 0800, at the cost accumulated.",
      "Monthly depreciation from the month after commissioning: Дт 2010/2510/9410/9420 (by where the asset is used) Кт 0200.",
      "Disposal: Дт 0200 (accumulated depreciation) and Дт 9210 (carrying amount) Кт 0100; proceeds as a sale.",
      "Schedules by straight line, declining balance, sum of the years' digits or units: accounting_calc depreciation.",
    ],
    accounts: ["0100", "0200", "0800", "9210"],
    calc: "depreciation",
    confirm: "the depreciation method and rates the company's policy sets",
  },
  {
    id: "entry_payroll",
    kind: "entry",
    topics: [
      "зарплата",
      "заработная плата",
      "начисление зарплаты",
      "ндфл",
      "инпс",
      "oylik",
      "ish haqi",
      "jshds",
      "payroll",
      "salary",
      "wages",
    ],
    title: "Payroll",
    lines: [
      "Accrual: Дт 2010/2310/2510/9410/9420 (by where the work is) Кт 6710.",
      "Income tax withheld: Дт 6710 Кт 6410. Employee pension contribution (INPS) withheld: Дт 6710 and the account of the pension settlements.",
      "Pay: Дт 6710 Кт 5110 (bank) or 5010 (cash).",
      "Employer's social tax is an expense on top of the pay: Дт expense account Кт the account of the social settlements.",
      "Gross to net and net to gross with the rates: accounting_calc payroll. The payroll registers must agree with account 6710.",
    ],
    accounts: ["6710", "6410", "5110", "5010"],
    calc: "payroll",
    confirm: "the accounts for the pension and social settlements, and the current rates",
  },
  {
    id: "entry_fx",
    kind: "entry",
    topics: [
      "курсовая разница",
      "валюта",
      "переоценка валюты",
      "valyuta kursi farqi",
      "kurs farqi",
      "exchange difference",
      "foreign currency revaluation",
      "валютные",
    ],
    title: "Foreign currency and exchange differences",
    lines: [
      "Currency accounts (5210) and settlements in currency are revalued at the Central Bank rate on each operation and at month end.",
      "Exchange gain: Кт 9540; exchange loss: Дт 9620; the other side is the revalued account.",
      "An asset worth more is a gain, a liability that costs more is a loss. Advances paid and received are non-monetary: not revalued.",
      "Rates are in РегистрСведений.КурсыВалют. Revaluation of many balances: accounting_calc fx_revaluation.",
    ],
    accounts: ["5210", "9540", "9620"],
    calc: "fx_revaluation",
  },
  {
    id: "entry_loans",
    kind: "entry",
    topics: [
      "кредит",
      "займ",
      "проценты по кредиту",
      "график платежей",
      "kredit",
      "foiz",
      "loan",
      "interest",
      "lease",
      "аренда оборудования",
    ],
    title: "Loans and leases",
    lines: [
      "Loan received: Дт 5110 Кт 6810 (short-term) or 7810 (long-term).",
      "Interest accrued: Дт 9610 (financial expenses) and the account of the interest payable; repayment as instalments.",
      "Annuity or differentiated schedule with interest and balance: accounting_calc loan. A lease is a loan plus a right-of-use asset under IFRS 16.",
    ],
    accounts: ["5110", "6810", "7810", "9610"],
    calc: "loan",
    confirm: "the accounts for interest payable and long-term loans in the company's chart",
  },
  {
    id: "entry_bad_debt",
    kind: "entry",
    topics: [
      "безнадежный долг",
      "резерв по сомнительным долгам",
      "списание дебиторки",
      "umidsiz qarz",
      "shubhali qarz",
      "bad debt",
      "doubtful debts",
      "allowance",
    ],
    title: "Doubtful and bad debts",
    lines: [
      "Allowance for doubtful debts: Дт 9430 Кт 4910; written off against it: Дт 4910 Кт 4010, with the debt tracked off-balance.",
      "Under IFRS 9 the allowance is an expected credit loss from the ageing of receivables (0–30, 31–60, 61–90, over 90 days).",
    ],
    accounts: ["9430", "4910", "4010"],
    confirm: "the allowance method the company's policy sets",
  },
  {
    id: "entry_month_close",
    kind: "entry",
    topics: [
      "закрытие месяца",
      "закрытие года",
      "финансовый результат",
      "oy yopish",
      "yil yopish",
      "moliyaviy natija",
      "month end closing",
      "financial result",
      "9910",
    ],
    title: "Closing the period to the financial result",
    lines: [
      "Production and overhead accounts (2010, 2310, 2510) are closed to cost; the 9xxx accounts to the financial result 9910.",
      "Profit tax accrued: Дт 9810 Кт 6410. The financial result of the year is closed to retained earnings 8710.",
      "Before giving figures for a period, check that its months are closed, and say so if they are not.",
    ],
    accounts: ["9910", "9810", "8710", "2010"],
  },

  // --- formulas ----------------------------------------------------------------------------------
  {
    id: "formula_vat",
    kind: "formula",
    topics: ["ндс формула", "расчет ндс", "qqs hisoblash", "vat calculation", "ндс", "qqs", "vat"],
    title: "VAT",
    lines: [
      "VAT out of a net amount: net × rate. Net out of a gross: gross ÷ (1 + rate). VAT out of a gross: gross − net.",
      "The rate is the one valid on the document's date, as the company's own documents show; a rate the base lacks is the accountant's decision.",
    ],
    calc: "vat",
  },
  {
    id: "formula_costing",
    kind: "formula",
    topics: [
      "себестоимость",
      "фифо",
      "средняя себестоимость",
      "tannarx",
      "fifo",
      "weighted average",
      "costing",
      "списание запасов",
    ],
    title: "Stock costing",
    lines: [
      "FIFO issues the oldest lots first; LIFO the newest; the average costs every unit alike (value ÷ quantity).",
      "Closing stock = opening + receipts − issues; inventory is carried at the lower of cost and net realisable value (IAS 2).",
      "In the 1C configuration of the manual the company chooses between the average cost and FIFO (batches are then kept on the stock accounts), each organization on its own, in its accounting policy; LIFO is not among them.",
      "The month closing «Корректировка стоимости номенклатуры» works out the cost of what was issued by that method.",
    ],
    confirm: "the method set in the company's accounting policy",
    calc: "costing",
  },
  {
    id: "formula_working_capital",
    kind: "formula",
    topics: [
      "оборотный капитал",
      "оборачиваемость",
      "коэффициент ликвидности",
      "рентабельность",
      "likvidlik",
      "aylanuvchanlik",
      "rentabellik",
      "liquidity",
      "turnover days",
      "margin",
      "ratios",
      "roe",
      "roa",
    ],
    title: "Ratios",
    lines: [
      "Current ratio = current assets ÷ current liabilities; quick = (current assets − inventory) ÷ current liabilities; cash ratio = cash ÷ current liabilities.",
      "Receivable days = receivables ÷ revenue × days; payable days = payables ÷ cost of sales × days; inventory days = inventory ÷ cost of sales × days.",
      "Gross margin = (revenue − cost of sales) ÷ revenue; net margin = net income ÷ revenue; ROE = net income ÷ equity; ROA = net income ÷ total assets; interest cover = EBIT ÷ interest.",
    ],
    calc: "ratios",
  },
  {
    id: "formula_investment",
    kind: "formula",
    topics: [
      "npv",
      "irr",
      "окупаемость",
      "инвестиции",
      "investitsiya",
      "qoplanish",
      "investment",
      "payback",
      "discount",
    ],
    title: "Investment appraisal",
    lines: [
      "NPV = Σ cash flow(t) ÷ (1 + r)^t, the first flow at t = 0; IRR is the rate where NPV is 0; payback is when the cumulative flow turns positive.",
    ],
    calc: "npv_irr",
  },
  {
    id: "formula_breakeven",
    kind: "formula",
    topics: [
      "безубыточность",
      "точка безубыточности",
      "zararsizlik",
      "break even",
      "breakeven",
      "маржинальность",
    ],
    title: "Break-even",
    lines: [
      "Break-even units = fixed costs ÷ (price − variable cost per unit); for a target profit add it to the fixed costs.",
    ],
    calc: "break_even",
  },
  {
    id: "formula_penalty",
    kind: "formula",
    topics: ["пеня", "штраф", "просрочка", "penya", "jarima", "penalty", "late payment"],
    title: "Penalty for late payment",
    lines: [
      "Penalty = principal × rate per day × days late, up to the cap the law sets (the rate and the cap are reference: confirm).",
    ],
    calc: "penalty",
    confirm: "the rate per day and the cap in force",
  },

  // --- procedures --------------------------------------------------------------------------------
  {
    id: "proc_month_close",
    kind: "procedure",
    topics: [
      "чек-лист закрытия месяца",
      "закрытие периода порядок",
      "oy yopish tartibi",
      "month end checklist",
      "closing checklist",
    ],
    title: "Month-end closing checklist",
    lines: [
      "1. All documents of the month entered and posted; no unposted or marked documents left (the engine counts them).",
      "2. Bank and cash: statements agree with the books; no negative cash balance.",
      "3. Counterparties: acts of reconciliation for the main balances; advances matched with invoices.",
      "4. Accruals and prepayments: payroll and taxes accrued, deferred expenses written off by months.",
      "5. Depreciation charged (accounting_calc depreciation); currency balances revalued (fx_revaluation).",
      "6. Stock: costing run, no negative stock; write-down to net realisable value.",
      "7. VAT: output against the issued invoices, input against the received ones (Didox against 1C).",
      "8. Trial balance: debit = credit; the 9xxx accounts closed to 9910; profit tax accrued.",
    ],
  },
  {
    id: "proc_close_1c",
    kind: "procedure",
    topics: [
      "закрытие месяца в 1с",
      "регламентные операции",
      "выполнить закрытие месяца",
      "реформация баланса",
      "давр ёпиш",
      "регламент операциялар",
      "oyni yopish 1c",
      "regulated operations",
      "close the month in 1c",
      "закрытие 90 91 93 94 95 96 97 98",
    ],
    title: "Closing the month in 1C: the regulated operations in order",
    lines: [
      "Operations → Закрытие месяца (organization and month), then «Выполнить закрытие месяца». The operations run in four groups, each in sequence.",
      "1. Контроль последовательности проведения документов (documents posted out of date order are re-posted: «Перепровести документы»).",
      "2. Амортизация и износ основных средств; Амортизация НМА и списание расходов по гудвилу.",
      "3. Переоценка валютных средств (gain 9540, loss 9620); Корректировка стоимости номенклатуры (cost of stock); Списание расходов будущих периодов; Расчет торговой наценки по проданным товарам (retail markup, 2980).",
      "4. Закрытие счетов 20, 23, 25 и расчет себестоимости выпуска (production cost).",
      "5. Закрытие счетов 90, 91, 93, 94, 95, 96, 97, 98: moved to 9910 «Доходы и расходы» every month.",
      "6. Зачет авансовых платежей по налогам, по контрагентам, по подотчетным лицам (advances set against what they pay for).",
      "7. Реформация баланса (at the year's end: the result of 9910 to retained earnings).",
      "Payroll taxes and contributions from the pay fund, and the pay in the regulated accounts, are done in the payroll section, not here.",
      "An error of an operation is read, put right, and «Выполнить закрытие месяца» pressed again. «Отчет о выполнении операции» and «Справки-расчеты» show what each did.",
    ],
    accounts: ["9910", "9540", "9620", "2980"],
    confirm:
      "the operations the company's accounting policy turns on (the wizard offers the ones its policy and taxation need)",
  },
  {
    id: "concept_close_effect",
    kind: "concept",
    topics: [
      "после закрытия месяца обороты 90",
      "закрытый месяц финансовый результат",
      "yopilgan oy natija",
      "yopilgan oyda tushum nol",
      "closed month revenue zero",
      "обороты закрытие 99",
    ],
    title: "After the month is closed the 9xxx accounts look empty",
    lines: [
      "The closing moves 90, 91, 93–98 to 9910 every month: their turnovers then include the closing entries and net to nothing.",
      "The financial result is therefore read from the entries that do not touch 99xx; the figures are the same before and after the closing.",
      "The profit of a closed month is on 9910 until the year's end (Реформация баланса moves it to retained earnings).",
    ],
    accounts: ["9910", "9010", "9110"],
  },
  {
    id: "concept_retail_markup",
    kind: "concept",
    topics: [
      "торговая наценка",
      "розничная торговля наценка",
      "2980",
      "савдо устамаси",
      "chakana savdo ustama",
      "retail markup",
    ],
    title: "Retail trade markup (2980)",
    lines: [
      "Goods in a retail point are kept at the retail price: the markup sits on 2980 «Торговая наценка» (a credit balance against the goods).",
      "The month closing «Расчет торговой наценки по проданным товарам» writes off the part that belongs to what was sold.",
      "A credit balance on 2980 is normal: it is not a negative stock and is left out of the stock reports.",
    ],
    accounts: ["2910", "2980"],
  },
  {
    id: "concept_cash_documents",
    kind: "concept",
    topics: [
      "денежные документы",
      "5015",
      "5025",
      "пулга оид ҳужжатлар",
      "pulga oid hujjatlar",
      "cash documents vouchers",
      "почтовые марки талоны",
    ],
    title: "Cash documents (5015, 5025)",
    lines: [
      "Vouchers, stamps and similar documents of value are kept on 5015 «Денежные документы» and, in foreign currency, 5025, by quantity and amount.",
      "They are received with «Поступление денежных документов» and issued with «Выдача денежных документов» (Касса menu).",
    ],
    accounts: ["5015", "5025"],
  },
  {
    id: "proc_1c_documents",
    kind: "procedure",
    topics: [
      "где вводить в 1с",
      "какой документ в 1с",
      "1c da qaysi hujjat",
      "1c hujjatlari",
      "каталог документов 1с",
      "documents in 1c",
      "which document in 1c",
      "поступление товаров и услуг",
      "реализация товаров и услуг",
      "авансовый отчет",
      "принятие к учету ос",
    ],
    title: "Where each operation is entered in 1C (documents and menus)",
    lines: [
      "Purchase: Покупка → «Поступление товаров и услуг» (goods, services, equipment) with «Счет-фактура полученный»; import: «ГТД по импорту».",
      "Sale: Продажа → «Реализация товаров и услуг» with «Счет-фактура выданный»; returns: «Возврат товаров от покупателя», «Возврат товаров поставщику»; commission: «Отчет комитенту о продажах», «Отчет комиссионера о продажах»; retail: «Отчет о розничных продажах».",
      "Bank: «Платежное поручение исходящее» / «входящее», «Платежный ордер на списание» / «на поступление денежных средств», «Платежное требование выставленное»; the «Банковские выписки» journal shows a day's documents per account.",
      "Cash: Касса → «Приходный кассовый ордер», «Расходный кассовый ордер», «Кассовая книга»; accountable persons: «Авансовый отчет».",
      "Warehouse: Склад → «Перемещение товаров», «Оприходование товаров», «Списание товаров», «Инвентаризация товаров на складе» (a surplus or a shortage becomes «Оприходование» or «Списание» from it), «Комплектация номенклатуры».",
      "Production: «Отчет производства за смену», «Требование-накладная», «Передача материалов в эксплуатацию».",
      "Fixed assets: «Принятие к учету ОС», «Модернизация ОС», «Передача ОС», «Списание ОС», «Изменение состояния ОС», «Инвентаризация ОС»; depreciation is charged by the month closing, not by a document. Intangibles: «Поступление НМА», «Принятие к учету НМА», «Передача НМА», «Списание НМА».",
      "Pay: «Начисление зарплаты работникам организаций», «Ведомость на выплату зарплаты» / «Платежная ведомость».",
      "Settlements: «Акт сверки взаиморасчетов», «Корректировка долга», «Инвентаризация расчетов с контрагентами».",
    ],
    confirm:
      "the names are those of the configuration the manual describes; the base's own configuration may name a document differently (the bank documents especially)",
  },
  {
    id: "concept_1c_standard_reports",
    kind: "concept",
    topics: [
      "оборотно-сальдовая ведомость",
      "карточка счета",
      "анализ счета",
      "шахматная ведомость",
      "стандартные отчеты 1с",
      "обороты счета",
      "карточка субконто",
      "стандарт ҳисоботлар",
      "standart hisobotlar",
      "aylanma qoldiq qaydnomasi",
      "standard reports 1c",
      "trial balance report",
    ],
    title: "The standard accounting reports of 1C and what each shows",
    lines: [
      "«Оборотно-сальдовая ведомость»: per account (or sub-account) the opening balance, the debit and credit turnover and the closing balance; accounts in order of number.",
      "«Шахматная ведомость»: turnovers between accounts as a table, debit accounts in rows, credit accounts in columns.",
      "«Оборотно-сальдовая ведомость по счету»: the balances and turnover of one account by its analytics (sub-account, subconto, organization).",
      "«Обороты счета»: the opening and closing balance and, for the period, the turnover split by the corresponding accounts.",
      "«Анализ счета»: the same, laid out as a table of corresponding accounts (answers: with which accounts did money come to and go from the account).",
      "«Карточка счета»: every entry of the account in date order, one line an entry. «Анализ субконто», «Обороты между субконто» and «Карточка субконто»: the same by the analytic (counterparty, item…).",
      "Universal reports: «Остатки и обороты», «Список / кросс-таблица», «Универсальный отчет». Check the program's figures against the first two.",
    ],
  },
  {
    id: "concept_accountant_calendar",
    kind: "concept",
    topics: [
      "календарь бухгалтера",
      "регламентированная отчетность",
      "регламентированные отчеты",
      "бухгалтер календари",
      "hisobchi kalendari",
      "reglament hisobotlar",
      "accountant's calendar",
      "regulated reports",
    ],
    title: "The accountant's calendar and the regulated reports in 1C",
    lines: [
      "Отчеты → «Регламентированные отчеты»: the forms the state bodies set (accounting, tax, off-budget funds, directories), prepared per organization and period, kept with a status, uploaded for filing.",
      "«Календарь бухгалтера» (Регламентированная и финансовая отчетность → Календарь) shows the dates of filing and payment that the configuration holds, reminds a set number of days ahead, and lists what is due.",
      "The configuration's own dates are the law's as of its release: confirm them against the current documents before relying on them.",
    ],
  },
  {
    id: "proc_vat_reconciliation",
    kind: "procedure",
    topics: [
      "сверка ндс",
      "счета фактуры сверка",
      "эсф",
      "qqs solishtirish",
      "hisob-faktura solishtirish",
      "vat reconciliation",
      "didox reconciliation",
      "invoices check",
    ],
    title: "VAT reconciliation with Didox",
    lines: [
      "Output: the invoices issued in Didox (outgoing) against the issued invoices and sales in 1C: number, date, buyer INN, amount, VAT.",
      "Input: the invoices received in Didox (incoming) against the received invoices and receipts: what is missing in 1C, what differs, what is entered twice.",
      "A line without VAT is a line without VAT, not an error. A VAT rate the base lacks is the accountant's decision.",
      "Report by document number, with the difference, not as totals alone.",
    ],
  },
  {
    id: "proc_inventory_count",
    kind: "procedure",
    topics: [
      "инвентаризация",
      "инвентаризация склада",
      "inventarizatsiya",
      "stock count",
      "inventory count",
      "излишки недостачи",
    ],
    title: "Stock count (inventory)",
    lines: [
      "Compare the physical count with the book quantity by item; surpluses are capitalised at market value, shortages are charged to the person responsible or to expenses within the norm of natural loss.",
      "Record the surpluses and shortages by their own documents and entries, and explain every difference.",
    ],
    confirm: "the company's rules for losses within and beyond the norm",
  },
  {
    id: "proc_audit",
    kind: "procedure",
    topics: [
      "аудит",
      "проверка учета",
      "риски",
      "аналитические процедуры",
      "audit",
      "tekshiruv",
      "xavf",
      "risk",
      "analytical procedures",
      "fraud",
      "дубли",
    ],
    title: "Audit procedures by query",
    lines: [
      "Duplicates: same counterparty, date and amount. Round amounts. Postings at weekends or after the period. Documents without a counterparty or contract.",
      "Negative balances (cash, stock). Accounts that should be zero at the period end (transit, 1510, 2510, 9xxx). Unposted or marked documents.",
      "Ageing of receivables and payables. Related-party and one-off large payments. Differences between Didox and 1C.",
      "For each finding give the risk, the evidence (document numbers) and the correction.",
    ],
  },
  {
    id: "proc_bank_reconciliation",
    kind: "procedure",
    topics: [
      "сверка банка",
      "банковская выписка",
      "bank solishtiruv",
      "bank ko'chirma",
      "bank reconciliation",
      "bank statement",
    ],
    title: "Bank reconciliation",
    lines: [
      "Opening balance + receipts − payments = closing balance of the statement; compare with account 5110 at the same dates.",
      "Fees go as bank fees; terminal (acquiring) receipts are booked gross with the commission apart; moves between the company's own accounts and conversions are two legs of one operation.",
      "Tax payments carry the tax and its period (the month before the payment, by the company's habit unless the purpose names one).",
    ],
    accounts: ["5110"],
  },

  // --- tax reference (confirm) -------------------------------------------------------------------
  {
    id: "tax_reference",
    kind: "tax",
    topics: [
      "налоги узбекистан",
      "ставки налогов",
      "налог на прибыль",
      "налог с оборота",
      "ндфл ставка",
      "soliq stavkalari",
      "foyda solig'i",
      "aylanma solig'i",
      "tax rates",
      "profit tax",
      "turnover tax",
      "social tax",
    ],
    title: "Taxes (reference, confirm the rate in force)",
    lines: [
      "VAT: output on sales, input offset against it, import VAT at customs. The base's own rates for the date are the authority (12% in 2024, a higher rate later per the base the accountant works in).",
      "Profit tax: on the taxable profit; a turnover tax regime for small businesses instead of VAT and profit tax.",
      "Pay: personal income tax withheld from the employee, employee pension (INPS), employer's social tax on the payroll.",
      "Property, land and water taxes by their bases; excise on excisable goods; customs duty by the tariff at import.",
      "Payments to the budget on the bank statement are entered by the program from the company's earlier payment of the same tax, the period by the purpose or the company's habit.",
    ],
    confirm: "every rate, threshold and deadline against the law in force on the document's date",
  },
  {
    id: "concept_chart",
    kind: "concept",
    topics: [
      "план счетов",
      "счета учета",
      "hisoblar rejasi",
      "chart of accounts",
      "nsbu",
      "нсбу",
      "какой счет",
    ],
    title: "The chart of accounts in groups (НСБУ)",
    lines: [
      "01xx fixed assets, 02xx their depreciation, 04xx intangibles, 08xx capital investments.",
      "10xx materials, 15xx procurement, 20xx/23xx/25xx production and overhead, 28xx finished goods, 29xx goods.",
      "31xx deferred expenses; 40xx buyers, 41xx other receivables, 43xx advances paid, 44xx taxes and VAT prepaid.",
      "50xx cash (5015/5025 cash documents), 51xx bank («Расчетные счета»), 52xx «Валютные счета», 55xx «Специальные счета в банках».",
      "60xx suppliers, 63xx advances received, 64xx taxes payable, 65xx insurance and off-budget funds, 67xx pay, 68xx short-term loans, 78xx long-term loans.",
      "83xx charter capital, 87xx retained earnings; 90xx revenue, 91xx cost of sales, 93xx other operating income, 94xx period expenses, 95xx financial income (9540 exchange gains), 96xx financial expenses (9620 exchange losses), 98xx profit tax, 9910 financial result («Доходы и расходы»).",
      "The base's own chart (ПланСчетов.Хозрасчетный) and the company's posting habits decide the exact account.",
    ],
    accounts: ["0100", "1010", "2910", "4010", "5110", "6010", "9020"],
  },
];

const clean = (text: string) =>
  text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‘’`ʻʼ]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ");

/** The first letters stand for the word, so endings do not matter ("амортизация", "амортизации"). */
const stemOf = (word: string) => (word.length > 5 ? word.slice(0, 5) : word);

const wordsOf = (text: string) =>
  clean(text)
    .split(/\s+/)
    .filter((w) => w.length >= 2);

const NOISE = new Set([
  "как",
  "что",
  "это",
  "для",
  "при",
  "или",
  "the",
  "and",
  "how",
  "what",
  "for",
  "with",
  "qanday",
  "nima",
  "uchun",
  "bilan",
  "kerak",
]);

/** Edit distance with a swap of neighbours counted as one edit (a typo is usually one of the four). */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 0; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (d[i - 1]?.[j] ?? 0) + 1,
        (d[i]?.[j - 1] ?? 0) + 1,
        (d[i - 1]?.[j - 1] ?? 0) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, (d[i - 2]?.[j - 2] ?? 0) + 1);
      (d[i] as number[])[j] = best;
    }
  }
  return d[a.length]?.[b.length] ?? 0;
}

/** The word of a question is a topic word with one typo: a letter lost, doubled, swapped or replaced (endings aside). */
function nearly(word: string, topicWord: string): boolean {
  const t = topicWord.slice(0, 7);
  if (t.length < 5 || word.length < t.length - 1) return false;
  for (let length = t.length - 1; length <= Math.min(word.length, t.length + 1); length++)
    if (distance(t, word.slice(0, length)) <= 1) return true;
  return false;
}

/** Every word of every topic and title, once, and each entry's own: what the search compares a question with. */
const INDEX = (() => {
  const perEntry = KNOWLEDGE.map((entry) => ({
    entry,
    topicWords: new Set(entry.topics.flatMap(wordsOf)),
    topicStems: new Set(entry.topics.flatMap(wordsOf).map(stemOf)),
    titleStems: new Set(wordsOf(entry.title).map(stemOf)),
  }));
  const known = new Set(perEntry.flatMap((e) => [...e.topicStems, ...e.titleStems]));
  const all = [...new Set(perEntry.flatMap((e) => [...e.topicWords]))];
  return { perEntry, known, all };
})();

/** The entries a question is about, best first. An entry needs a topic word of the question to count. */
export function searchKnowledge(query: string, limit = 4): KnowledgeEntry[] {
  const raw = wordsOf(query).filter((w) => !NOISE.has(w));
  const asked = [...new Set(raw.map(stemOf))];
  if (asked.length === 0) return [];
  // A word of five letters or more that no topic has may carry a typo: the topic words one typo away stand for it.
  const mistyped = [...new Set(raw)]
    .filter((w) => w.length >= 5 && !INDEX.known.has(stemOf(w)))
    .map((w) => ({
      w,
      near: new Set(INDEX.all.filter((t) => Math.abs(t.length - w.length) <= 3 && nearly(w, t))),
    }))
    .filter((x) => x.near.size > 0);
  const q = clean(query);
  const scored = INDEX.perEntry
    .map(({ entry, topicWords, topicStems, titleStems }) => {
      let score = 0;
      for (const s of asked) {
        if (topicStems.has(s)) score += 2;
        else if (titleStems.has(s)) score += 1;
      }
      // A word with one typo counts a little less than an exact one (two, from six letters on).
      for (const { w, near } of mistyped)
        if ([...topicWords].some((t) => near.has(t))) score += w.length >= 6 ? 2 : 1.5;
      // A whole topic phrase in the question is a stronger sign than scattered words.
      for (const topic of entry.topics) if (topic.length >= 6 && q.includes(clean(topic).trim())) score += 3;
      return { entry, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.entry);
}
