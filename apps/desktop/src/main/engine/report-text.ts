/**
 * The financial reports in words: the lines of the result and of the balance, the biggest debtors and creditors, the
 * stock, each with the accounts the figure came from and the checks that failed. In the accountant's language.
 */
import type { Lang } from "../router.js";
import type { AgingReport } from "./aging.js";
import type { ReconcileRow } from "./bank-reconcile.js";
import type { Explanation } from "./explain.js";
import type { CostCheck } from "./stock-cost.js";
import type { DueDate, ProfitTaxAccrual, RegisterComparison, VatPosition } from "./tax-accrual.js";

import type { BalanceReport, DebtsReport, Line, ResultReport, StockReport } from "./financial.js";

const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 }).replace(/,/g, " ");

const W = {
  ru: {
    result: (from: string, to: string) => `Финансовый результат за ${from} – ${to}`,
    provisional: "предварительный",
    revenue: "Выручка",
    costOfSales: "Себестоимость продаж",
    grossProfit: "Валовая прибыль",
    periodExpenses: "Расходы периода",
    otherOperating: "Прочие операционные доходы и расходы (нетто)",
    operatingProfit: "Операционная прибыль",
    financialIncome: "Финансовые доходы",
    financialExpenses: "Финансовые расходы",
    emergency: "Чрезвычайные статьи",
    profitBeforeTax: "Прибыль до налогообложения",
    tax: "Налог на прибыль и прочие налоги",
    netProfit: "Чистая прибыль (убыток)",
    closing: "Счета итогового результата (99xx)",
    balance: (date: string) => `Баланс на ${date}`,
    longTermAssets: "Долгосрочные активы",
    stock: "Запасы и затраты",
    receivables: "Дебиторская задолженность",
    money: "Денежные средства",
    totalAssets: "ИТОГО АКТИВ",
    currentLiabilities: "Краткосрочные обязательства",
    longTermLiabilities: "Долгосрочные обязательства",
    equity: "Собственный капитал",
    currentResult: "Прибыль (убыток) текущего года",
    totalLiabilities: "ИТОГО ПАССИВ",
    balanced: "Баланс сходится: актив равен пассиву.",
    unbalanced: (d: number) => `Баланс не сходится, разница ${money(d)}.`,
    receivablesTitle: (date: string, n: number, total: number) =>
      `Дебиторская задолженность на ${date}: ${n} контрагентов, всего ${money(total)}`,
    payablesTitle: (date: string, n: number, total: number) =>
      `Кредиторская задолженность на ${date}: ${n} контрагентов, всего ${money(total)}`,
    advancesReceivables: (total: number) =>
      `Авансы полученные (кредитовое сальдо на дебиторских счетах): ${money(total)}`,
    advancesPayables: (total: number) =>
      `Авансы выданные (дебетовое сальдо на кредиторских счетах): ${money(total)}`,
    stockTitle: (date: string, n: number, total: number) =>
      `Остатки запасов на ${date}: ${n} позиций, ${money(total)}`,
    byWarehouse: "По складам:",
    negative: "Отрицательные остатки:",
    noCost: "Количество без стоимости:",
    noQuantity: "Стоимость без количества:",
    sources: "Посчитано программой по данным 1С, без модели. Каждая строка — из счетов, указанных рядом.",
    checks: "Что проверить:",
    estimate: "Ставки налогов взяты из таблицы программы и ещё не подтверждены налоговым консультантом.",
  },
  uz: {
    result: (from: string, to: string) => `Moliyaviy natija ${from} – ${to}`,
    provisional: "dastlabki",
    revenue: "Tushum",
    costOfSales: "Sotuvlar tannarxi",
    grossProfit: "Yalpi foyda",
    periodExpenses: "Davr xarajatlari",
    otherOperating: "Boshqa operatsion daromad va xarajatlar (netto)",
    operatingProfit: "Operatsion foyda",
    financialIncome: "Moliyaviy daromadlar",
    financialExpenses: "Moliyaviy xarajatlar",
    emergency: "Favqulodda moddalar",
    profitBeforeTax: "Soliqqa qadar foyda",
    tax: "Foyda solig'i va boshqa soliqlar",
    netProfit: "Sof foyda (zarar)",
    closing: "Yakuniy natija schetlari (99xx)",
    balance: (date: string) => `${date} dagi balans`,
    longTermAssets: "Uzoq muddatli aktivlar",
    stock: "Zaxiralar va xarajatlar",
    receivables: "Debitorlik qarzlari",
    money: "Pul mablag'lari",
    totalAssets: "JAMI AKTIV",
    currentLiabilities: "Qisqa muddatli majburiyatlar",
    longTermLiabilities: "Uzoq muddatli majburiyatlar",
    equity: "Xususiy kapital",
    currentResult: "Joriy yil foydasi (zarari)",
    totalLiabilities: "JAMI PASSIV",
    balanced: "Balans tengligi bajarildi: aktiv passivga teng.",
    unbalanced: (d: number) => `Balans teng emas, farq ${money(d)}.`,
    receivablesTitle: (date: string, n: number, total: number) =>
      `${date} dagi debitorlik qarzi: ${n} kontragent, jami ${money(total)}`,
    payablesTitle: (date: string, n: number, total: number) =>
      `${date} dagi kreditorlik qarzi: ${n} kontragent, jami ${money(total)}`,
    advancesReceivables: (total: number) =>
      `Olingan avanslar (debitor schetlaridagi kredit qoldiq): ${money(total)}`,
    advancesPayables: (total: number) =>
      `Berilgan avanslar (kreditor schetlaridagi debet qoldiq): ${money(total)}`,
    stockTitle: (date: string, n: number, total: number) =>
      `${date} dagi zaxira qoldig'i: ${n} pozitsiya, ${money(total)}`,
    byWarehouse: "Omborlar bo'yicha:",
    negative: "Manfiy qoldiqlar:",
    noCost: "Qiymatsiz miqdor:",
    noQuantity: "Miqdorsiz qiymat:",
    sources:
      "1C ma'lumotlari bo'yicha dastur hisobladi, modelsiz. Har bir qator yonida ko'rsatilgan schetlardan olingan.",
    checks: "Tekshirish kerak:",
    estimate: "Soliq stavkalari dasturning jadvalidan olingan, soliq maslahatchisi hali tasdiqlamagan.",
  },
  en: {
    result: (from: string, to: string) => `Financial result ${from} – ${to}`,
    provisional: "provisional",
    revenue: "Revenue",
    costOfSales: "Cost of sales",
    grossProfit: "Gross profit",
    periodExpenses: "Period expenses",
    otherOperating: "Other operating income and expenses (net)",
    operatingProfit: "Operating profit",
    financialIncome: "Financial income",
    financialExpenses: "Financial expenses",
    emergency: "Emergency items",
    profitBeforeTax: "Profit before tax",
    tax: "Profit tax and other taxes",
    netProfit: "Net profit (loss)",
    closing: "Final result accounts (99xx)",
    balance: (date: string) => `Balance at ${date}`,
    longTermAssets: "Long-term assets",
    stock: "Inventories and costs",
    receivables: "Receivables",
    money: "Cash and bank",
    totalAssets: "TOTAL ASSETS",
    currentLiabilities: "Current liabilities",
    longTermLiabilities: "Long-term liabilities",
    equity: "Equity",
    currentResult: "Profit (loss) of the current year",
    totalLiabilities: "TOTAL LIABILITIES AND EQUITY",
    balanced: "The balance closes: assets equal liabilities and equity.",
    unbalanced: (d: number) => `The balance does not close, difference ${money(d)}.`,
    receivablesTitle: (date: string, n: number, total: number) =>
      `Receivables at ${date}: ${n} counterparties, ${money(total)} in all`,
    payablesTitle: (date: string, n: number, total: number) =>
      `Payables at ${date}: ${n} counterparties, ${money(total)} in all`,
    advancesReceivables: (total: number) =>
      `Advances received (credit balance on receivable accounts): ${money(total)}`,
    advancesPayables: (total: number) => `Advances paid (debit balance on payable accounts): ${money(total)}`,
    stockTitle: (date: string, n: number, total: number) =>
      `Stock at ${date}: ${n} positions, ${money(total)}`,
    byWarehouse: "By warehouse:",
    negative: "Negative balances:",
    noCost: "Quantity with no cost:",
    noQuantity: "Cost with no quantity:",
    sources:
      "Worked out by the program from the 1C data, with no model. Each line is made of the accounts shown beside it.",
    checks: "To check:",
    estimate:
      "The tax rates come from the program's table and have not yet been confirmed by the tax adviser.",
  },
} as const;

const SOURCES_SHOWN = 4;

function line(label: string, l: Line | number, bold = false): string[] {
  if (typeof l === "number") return [`${bold ? "▸ " : "  "}${label}: ${money(l)}`];
  const out = [`${bold ? "▸ " : "  "}${label}: ${money(l.amount)}`];
  const accounts = l.sources
    .slice(0, SOURCES_SHOWN)
    .map((s) => `${s.account} ${money(s.amount)}`)
    .join(", ");
  if (accounts) out.push(`      ← ${accounts}${l.sources.length > SOURCES_SHOWN ? ", …" : ""}`);
  return out;
}

export function resultText(r: ResultReport, lang: Lang): string {
  const w = W[lang];
  const out = [`${w.result(r.from, r.to)}${r.provisional ? ` (${w.provisional})` : ""}`];
  out.push(...line(w.revenue, r.revenue));
  out.push(...line(w.costOfSales, r.costOfSales));
  out.push(...line(w.grossProfit, r.grossProfit, true));
  out.push(...line(w.periodExpenses, r.periodExpenses));
  if (r.otherOperating.amount !== 0) out.push(...line(w.otherOperating, r.otherOperating));
  out.push(...line(w.operatingProfit, r.operatingProfit, true));
  if (r.financialIncome.amount !== 0) out.push(...line(w.financialIncome, r.financialIncome));
  if (r.financialExpenses.amount !== 0) out.push(...line(w.financialExpenses, r.financialExpenses));
  if (r.emergency.amount !== 0) out.push(...line(w.emergency, r.emergency));
  out.push(...line(w.profitBeforeTax, r.profitBeforeTax, true));
  out.push(...line(w.tax, r.tax));
  out.push(...line(w.netProfit, r.netProfit, true));
  if (r.closing.amount !== 0) out.push(...line(w.closing, r.closing));
  if (r.findings.length > 0) out.push(w.checks, ...r.findings.map((f) => `  – ${f}`));
  out.push(w.sources);
  return out.join("\n");
}

export function balanceText(b: BalanceReport, lang: Lang): string {
  const w = W[lang];
  const out = [w.balance(b.date)];
  out.push(...line(w.longTermAssets, b.longTermAssets));
  out.push(...line(w.stock, b.stock));
  out.push(...line(w.receivables, b.receivables));
  out.push(...line(w.money, b.money));
  out.push(...line(w.totalAssets, b.totalAssets, true));
  out.push(...line(w.currentLiabilities, b.currentLiabilities));
  out.push(...line(w.longTermLiabilities, b.longTermLiabilities));
  out.push(...line(w.equity, b.equity));
  out.push(...line(w.currentResult, b.currentResult));
  out.push(...line(w.totalLiabilities, b.totalLiabilities, true));
  out.push(b.balanced ? w.balanced : w.unbalanced(b.difference));
  if (b.findings.length > 0) {
    out.push(w.checks);
    for (const f of b.findings.slice(0, 10)) out.push(`  – ${f.account} ${money(f.balance)}: ${f.why}`);
  }
  out.push(w.sources);
  return out.join("\n");
}

export function debtsText(d: DebtsReport, lang: Lang): string {
  const w = W[lang];
  const title = d.kind === "receivables" ? w.receivablesTitle : w.payablesTitle;
  const out = [title(d.date, d.count, d.total)];
  for (const p of d.parties.slice(0, 15)) out.push(`  ${p.party}: ${money(p.amount)}`);
  if (d.advances.length > 0) {
    out.push(
      d.kind === "receivables" ? w.advancesReceivables(d.advancesTotal) : w.advancesPayables(d.advancesTotal),
    );
    for (const p of d.advances.slice(0, 5)) out.push(`  ${p.party}: ${money(p.amount)}`);
  }
  out.push(w.sources);
  return out.join("\n");
}

export function stockText(s: StockReport, lang: Lang): string {
  const w = W[lang];
  const out = [w.stockTitle(s.date, s.positions, s.total)];
  for (const r of s.top.slice(0, 12))
    out.push(`  ${r.item} (${r.warehouse}): ${money(r.qty)} → ${money(r.amount)}`);
  if (s.byWarehouse.length > 1) {
    out.push(w.byWarehouse);
    for (const r of s.byWarehouse.slice(0, 6)) out.push(`  ${r.warehouse}: ${money(r.amount)}`);
  }
  const issues: [string, { item: string; warehouse: string; qty: number; amount: number }[]][] = [
    [w.negative, s.negative],
    [w.noCost, s.noCost],
    [w.noQuantity, s.noQuantity],
  ];
  for (const [label, rows] of issues) {
    if (rows.length === 0) continue;
    out.push(label);
    for (const r of rows.slice(0, 5))
      out.push(`  – ${r.item} (${r.warehouse}): ${money(r.qty)} / ${money(r.amount)}`);
  }
  out.push(w.sources);
  return out.join("\n");
}

/** What the tax tables' answers carry while the adviser has not approved them. */
export const estimateNote = (lang: Lang) => W[lang].estimate;

// --- The other reports: what moved the result, aging, taxes, the calendar, the registers, the bank -----------------

const X = {
  ru: {
    explainTitle: (from: string, to: string, bf: string, bt: string) =>
      `Что повлияло на результат ${from} – ${to} (сравнение с ${bf} – ${bt})`,
    group: { revenue: "Выручка", costOfSales: "Себестоимость", periodExpenses: "Расходы периода" },
    againstBefore: (n: number) => `было ${money(n)}`,
    agingTitle: (kind: string, date: string, total: number) =>
      `${kind === "receivables" ? "Дебиторская" : "Кредиторская"} задолженность по срокам на ${date}: ${money(total)}`,
    buckets: ["0–30 дней", "31–60", "61–90", "свыше 90"],
    overdue: (n: number) => `Просрочено более 30 дней: ${money(n)}`,
    oldest: (d: number) => `самая старая ${d} дн.`,
    truncated: "Данных за год больше, чем читается за один раз: результат неполный.",
    taxTitle: (from: string, to: string) => `Налоги за ${from} – ${to}`,
    profitTax: "Налог на прибыль",
    profitLine: (p: ProfitTaxAccrual) =>
      `  прибыль до налога ${money(p.profitBeforeTax)} × ${p.rate}% = ${money(p.due)}; начислено ${money(p.accrued)}; к начислению ${money(p.toAccrue)}`,
    entry: (d: string, c: string, a: number, note: string) =>
      `  проводка (предложение): Дт ${d} Кт ${c} ${money(a)}${note}`,
    chartMissing: (a: string) => ` — в плане счетов базы нет ${a}: подтвердите счёт`,
    turnoverTax: "Налог с оборота",
    vat: "НДС (по оборотам счетов 6410 и 4410)",
    vatMonth: (m: string, o: number, i: number, p: number) =>
      `  ${m}: начислено ${money(o)}, к зачёту ${money(i)}, ${p >= 0 ? "к уплате" : "к возмещению"} ${money(Math.abs(p))}`,
    vatTotal: (p: number) => `  итого ${p >= 0 ? "к уплате" : "к возмещению"}: ${money(Math.abs(p))}`,
    notApproved: "Ставки и сроки взяты из таблиц программы, налоговый консультант их ещё не подтвердил.",
    calendarTitle: (from: string, to: string) => `Сроки налогов и отчётности ${from} – ${to}`,
    noDue: "В этом промежутке сроков нет.",
    kind: { report: "отчёт", payment: "оплата" },
    taxName: {
      vat: "НДС",
      profit: "налог на прибыль",
      income: "НДФЛ",
      social: "социальный налог",
      inps: "ИНПС",
      turnover: "налог с оборота",
    },
    registersTitle: (from: string, to: string) => `Реестр счетов-фактур: 1С и Didox за ${from} – ${to}`,
    incoming: "Полученные",
    outgoing: "Выданные",
    registerLine: (a: number, b: number, m: number) => `  в 1С ${a}, в Didox ${b}, совпало ${m}`,
    onlyDidox: "  Есть в Didox, нет в 1С:",
    only1c: "  Есть в 1С, нет в Didox:",
    differs: "  Суммы расходятся:",
    reconcileTitle: "Остатки по банковской выписке и в 1С",
    rec: {
      match: "совпадает",
      difference: "расхождение",
      not_in_1c: "счёта нет в 1С",
      no_balance: "в выписке нет остатка",
    },
  },
  uz: {
    explainTitle: (from: string, to: string, bf: string, bt: string) =>
      `Natijaga ta'sir qilgan omillar ${from} – ${to} (${bf} – ${bt} bilan solishtirma)`,
    group: { revenue: "Tushum", costOfSales: "Tannarx", periodExpenses: "Davr xarajatlari" },
    againstBefore: (n: number) => `oldin ${money(n)}`,
    agingTitle: (kind: string, date: string, total: number) =>
      `${date} dagi ${kind === "receivables" ? "debitorlik" : "kreditorlik"} qarzi muddatlar bo'yicha: ${money(total)}`,
    buckets: ["0–30 kun", "31–60", "61–90", "90 dan ortiq"],
    overdue: (n: number) => `30 kundan ortiq muddati o'tgan: ${money(n)}`,
    oldest: (d: number) => `eng eskisi ${d} kun`,
    truncated: "Yillik ma'lumot bir martada o'qiladigandan ko'p: natija to'liq emas.",
    taxTitle: (from: string, to: string) => `${from} – ${to} uchun soliqlar`,
    profitTax: "Foyda solig'i",
    profitLine: (p: ProfitTaxAccrual) =>
      `  soliqqa qadar foyda ${money(p.profitBeforeTax)} × ${p.rate}% = ${money(p.due)}; hisoblangan ${money(p.accrued)}; hisoblanishi kerak ${money(p.toAccrue)}`,
    entry: (d: string, c: string, a: number, note: string) =>
      `  provodka (taklif): Dt ${d} Kt ${c} ${money(a)}${note}`,
    chartMissing: (a: string) => ` — bazaning schetlar rejasida ${a} yo'q: schetni tasdiqlang`,
    turnoverTax: "Aylanma soliq",
    vat: "QQS (6410 va 4410 schetlar aylanmasi bo'yicha)",
    vatMonth: (m: string, o: number, i: number, p: number) =>
      `  ${m}: hisoblangan ${money(o)}, hisobga olinadigan ${money(i)}, ${p >= 0 ? "to'lanadi" : "qaytariladi"} ${money(Math.abs(p))}`,
    vatTotal: (p: number) => `  jami ${p >= 0 ? "to'lanadi" : "qaytariladi"}: ${money(Math.abs(p))}`,
    notApproved:
      "Stavkalar va muddatlar dasturning jadvallaridan olingan, soliq maslahatchisi hali tasdiqlamagan.",
    calendarTitle: (from: string, to: string) => `Soliq va hisobot muddatlari ${from} – ${to}`,
    noDue: "Bu oraliqda muddat yo'q.",
    kind: { report: "hisobot", payment: "to'lov" },
    taxName: {
      vat: "QQS",
      profit: "foyda solig'i",
      income: "JShDS",
      social: "ijtimoiy soliq",
      inps: "INPS",
      turnover: "aylanma soliq",
    },
    registersTitle: (from: string, to: string) => `Schet-fakturalar reestri: 1C va Didox ${from} – ${to}`,
    incoming: "Olingan",
    outgoing: "Berilgan",
    registerLine: (a: number, b: number, m: number) => `  1C da ${a}, Didox da ${b}, mos kelgani ${m}`,
    onlyDidox: "  Didox da bor, 1C da yo'q:",
    only1c: "  1C da bor, Didox da yo'q:",
    differs: "  Summalar farq qiladi:",
    reconcileTitle: "Bank ko'chirmasi va 1C dagi qoldiq",
    rec: {
      match: "mos",
      difference: "farq bor",
      not_in_1c: "schet 1C da yo'q",
      no_balance: "ko'chirmada qoldiq yo'q",
    },
  },
  en: {
    explainTitle: (from: string, to: string, bf: string, bt: string) =>
      `What moved the result ${from} – ${to} (against ${bf} – ${bt})`,
    group: { revenue: "Revenue", costOfSales: "Cost of sales", periodExpenses: "Period expenses" },
    againstBefore: (n: number) => `was ${money(n)}`,
    agingTitle: (kind: string, date: string, total: number) =>
      `${kind === "receivables" ? "Receivables" : "Payables"} by age at ${date}: ${money(total)}`,
    buckets: ["0–30 days", "31–60", "61–90", "over 90"],
    overdue: (n: number) => `Older than 30 days: ${money(n)}`,
    oldest: (d: number) => `oldest ${d} days`,
    truncated: "The year holds more entries than one read returns: the result is incomplete.",
    taxTitle: (from: string, to: string) => `Taxes for ${from} – ${to}`,
    profitTax: "Profit tax",
    profitLine: (p: ProfitTaxAccrual) =>
      `  profit before tax ${money(p.profitBeforeTax)} × ${p.rate}% = ${money(p.due)}; accrued ${money(p.accrued)}; to accrue ${money(p.toAccrue)}`,
    entry: (d: string, c: string, a: number, note: string) =>
      `  entry (proposal): Dt ${d} Kt ${c} ${money(a)}${note}`,
    chartMissing: (a: string) => ` — the base's chart has no ${a}: confirm the account`,
    turnoverTax: "Turnover tax",
    vat: "VAT (from the turnovers of accounts 6410 and 4410)",
    vatMonth: (m: string, o: number, i: number, p: number) =>
      `  ${m}: charged ${money(o)}, to offset ${money(i)}, ${p >= 0 ? "payable" : "refundable"} ${money(Math.abs(p))}`,
    vatTotal: (p: number) => `  total ${p >= 0 ? "payable" : "refundable"}: ${money(Math.abs(p))}`,
    notApproved:
      "The rates and dates come from the program's tables; the tax adviser has not confirmed them yet.",
    calendarTitle: (from: string, to: string) => `Tax and reporting deadlines ${from} – ${to}`,
    noDue: "No deadlines in this range.",
    kind: { report: "report", payment: "payment" },
    taxName: {
      vat: "VAT",
      profit: "profit tax",
      income: "income tax",
      social: "social tax",
      inps: "INPS",
      turnover: "turnover tax",
    },
    registersTitle: (from: string, to: string) => `Invoice registers: 1C and Didox ${from} – ${to}`,
    incoming: "Received",
    outgoing: "Issued",
    registerLine: (a: number, b: number, m: number) => `  in 1C ${a}, in Didox ${b}, matched ${m}`,
    onlyDidox: "  In Didox, not in 1C:",
    only1c: "  In 1C, not in Didox:",
    differs: "  Amounts differ:",
    reconcileTitle: "Bank statement balance against 1C",
    rec: {
      match: "matches",
      difference: "differs",
      not_in_1c: "account not in 1C",
      no_balance: "no balance in the statement",
    },
  },
} as const;

const dayList = (rows: { number: string; date: string; inn: string; amount: number }[]) =>
  rows
    .slice(0, 8)
    .map((d) => `    – № ${d.number} ${d.date} INN ${d.inn}${d.amount ? ` ${money(d.amount)}` : ""}`);

export function explainText(
  d: { from: string; to: string; before: { from: string; to: string }; groups: Explanation[] },
  lang: Lang,
): string {
  const w = X[lang];
  const out = [w.explainTitle(d.from, d.to, d.before.from, d.before.to)];
  for (const g of d.groups) {
    out.push(
      `▸ ${w.group[g.group]}: ${money(g.total)}${g.totalBefore !== null ? ` (${w.againstBefore(g.totalBefore)})` : ""}`,
    );
    for (const r of g.drivers.slice(0, 8))
      out.push(
        `    ${r.who}: ${money(r.amount)} (${r.share}%)${r.change !== null ? `, ${r.change >= 0 ? "+" : ""}${money(r.change)}` : ""}`,
      );
  }
  out.push(W[lang].sources);
  return out.join("\n");
}

export function agingText(d: AgingReport & { truncated?: boolean }, lang: Lang): string {
  const w = X[lang];
  const out = [w.agingTitle(d.kind, d.date, d.total)];
  out.push(`  ${d.buckets.map((b, i) => `${w.buckets[i]}: ${money(b)}`).join(" | ")}`);
  out.push(w.overdue(d.overdue));
  for (const p of d.parties.slice(0, 12))
    out.push(
      `  ${p.party}: ${money(p.total)} (${p.buckets.map(money).join(" / ")}; ${w.oldest(p.oldestDays)})`,
    );
  if (d.advancesTotal > 0)
    out.push(
      (d.kind === "receivables" ? W[lang].advancesReceivables : W[lang].advancesPayables)(d.advancesTotal),
    );
  if (d.truncated) out.push(w.truncated);
  out.push(W[lang].sources);
  return out.join("\n");
}

export function taxAccrualText(
  d: {
    from: string;
    to: string;
    regime: string;
    profit: ProfitTaxAccrual | { error: string } | null;
    turnover: { revenue: number; rate: number; tax: number; approved: boolean } | { error: string } | null;
    vat: VatPosition | null;
  },
  lang: Lang,
): string {
  const w = X[lang];
  const out = [w.taxTitle(d.from, d.to)];
  let estimate = false;
  if (d.profit) {
    out.push(`▸ ${w.profitTax}`);
    if ("error" in d.profit) out.push(`  ${d.profit.error}`);
    else {
      out.push(w.profitLine(d.profit));
      if (d.profit.entry)
        out.push(
          w.entry(
            d.profit.entry.debit,
            d.profit.entry.credit,
            d.profit.entry.amount,
            d.profit.entry.missingAccounts.length
              ? w.chartMissing(d.profit.entry.missingAccounts.join(", "))
              : "",
          ),
        );
      estimate ||= !d.profit.approved;
    }
  }
  if (d.turnover) {
    out.push(`▸ ${w.turnoverTax}`);
    if ("error" in d.turnover) out.push(`  ${d.turnover.error}`);
    else {
      out.push(`  ${money(d.turnover.revenue)} × ${d.turnover.rate}% = ${money(d.turnover.tax)}`);
      estimate ||= !d.turnover.approved;
    }
  }
  if (d.vat) {
    out.push(`▸ ${w.vat}`);
    for (const m of d.vat.months) out.push(w.vatMonth(m.month, m.output, m.input, m.payable));
    out.push(w.vatTotal(d.vat.payable));
  }
  if (estimate) out.push(w.notApproved);
  out.push(W[lang].sources);
  return out.join("\n");
}

export function calendarText(d: { from: string; to: string; due: DueDate[] }, lang: Lang): string {
  const w = X[lang];
  const out = [w.calendarTitle(d.from, d.to)];
  if (d.due.length === 0) out.push(w.noDue);
  for (const x of d.due) out.push(`  ${x.date}: ${w.taxName[x.tax]}, ${w.kind[x.kind]} (${x.period})`);
  if (d.due.some((x) => !x.approved)) out.push(w.notApproved);
  out.push(W[lang].sources);
  return out.join("\n");
}

export function registersText(
  d: { from: string; to: string; incoming?: RegisterSide; outgoing?: RegisterSide },
  lang: Lang,
): string {
  const w = X[lang];
  const out = [w.registersTitle(d.from, d.to)];
  for (const [label, side] of [
    [w.incoming, d.incoming],
    [w.outgoing, d.outgoing],
  ] as const) {
    if (!side) continue;
    out.push(`▸ ${label}`, w.registerLine(side.in1c, side.inDidox, side.matched));
    if (side.onlyInDidox.length) out.push(w.onlyDidox, ...dayList(side.onlyInDidox));
    if (side.onlyIn1c.length) out.push(w.only1c, ...dayList(side.onlyIn1c));
    if (side.amountDiffers.length) {
      out.push(w.differs);
      for (const x of side.amountDiffers.slice(0, 8))
        out.push(`    – № ${x.number} ${x.date}: 1C ${money(x.in1c)}, Didox ${money(x.inDidox)}`);
    }
  }
  out.push(W[lang].sources);
  return out.join("\n");
}

type RegisterSide = RegisterComparison & { in1c: number; inDidox: number };

export function reconcileText(d: { rows: ReconcileRow[] }, lang: Lang): string {
  const w = X[lang];
  const out: string[] = [w.reconcileTitle];
  for (const r of d.rows)
    out.push(
      `  ${r.account} (${r.date}): ${w.rec[r.status]}` +
        (r.statement !== null ? `; ${money(r.statement)}` : "") +
        (r.inBooks !== null ? ` / 1C ${money(r.inBooks)}` : "") +
        (r.difference ? `, Δ ${money(r.difference)}` : ""),
    );
  out.push(W[lang].sources);
  return out.join("\n");
}

const COST = {
  ru: {
    title: (item: string, method: string, date: string) =>
      `Себестоимость списаний «${item}» на ${date}, метод ${method}`,
    line: (e: number, b: number, d: number) =>
      `  по методу ${money(e)}, проведено в 1С ${money(b)}, разница ${money(d)}`,
    status: {
      match: "Совпадает.",
      difference: "Расхождение: проверьте партии и порядок списания.",
      no_issues: "Списаний не было.",
      short: "Списано больше, чем поступило: отрицательный остаток.",
    },
    closing: (q: number, v: number) => `  остаток по методу: ${money(q)} на ${money(v)}`,
    semiOff: "Производства нет: функции полуфабрикатов выключены.",
    semi: "Незавершённое производство и полуфабрикаты (счета 20xx/21xx):",
  },
  uz: {
    title: (item: string, method: string, date: string) =>
      `«${item}» chiqimlari tannarxi ${date} holatiga, usul ${method}`,
    line: (e: number, b: number, d: number) =>
      `  usul bo'yicha ${money(e)}, 1C da yozilgan ${money(b)}, farq ${money(d)}`,
    status: {
      match: "Mos.",
      difference: "Farq bor: partiyalar va chiqim tartibini tekshiring.",
      no_issues: "Chiqim bo'lmagan.",
      short: "Kirimdan ko'p chiqim: manfiy qoldiq.",
    },
    closing: (q: number, v: number) => `  usul bo'yicha qoldiq: ${money(q)}, qiymati ${money(v)}`,
    semiOff: "Ishlab chiqarish yo'q: yarim tayyor mahsulot funksiyalari o'chirilgan.",
    semi: "Ishlab chiqarishdagi qoldiq va yarim tayyor mahsulot (20xx/21xx schetlar):",
  },
  en: {
    title: (item: string, method: string, date: string) =>
      `Cost of the issues of «${item}» at ${date}, method ${method}`,
    line: (e: number, b: number, d: number) =>
      `  by the method ${money(e)}, booked in 1C ${money(b)}, difference ${money(d)}`,
    status: {
      match: "Agrees.",
      difference: "Differs: check the lots and the order of issue.",
      no_issues: "Nothing was issued.",
      short: "More was issued than came in: negative stock.",
    },
    closing: (q: number, v: number) => `  stock by the method: ${money(q)} worth ${money(v)}`,
    semiOff: "No production: the semi-finished functions are off.",
    semi: "Work in progress and semi-finished goods (accounts 20xx/21xx):",
  },
} as const;

export function costText(d: CostCheck & { date: string }, lang: Lang): string {
  const w = COST[lang];
  return [
    w.title(d.item, d.method.toUpperCase(), d.date),
    w.line(d.expected, d.booked, d.difference),
    `  ${w.status[d.status]}`,
    w.closing(d.closing.qty, d.closing.value),
    W[lang].sources,
  ].join("\n");
}

export function semiText(d: StockReport & { producer: boolean }, lang: Lang): string {
  const w = COST[lang];
  if (!d.producer) return `${w.semiOff}\n${W[lang].sources}`;
  return `${w.semi}\n${stockText(d, lang)}`;
}

/** Any report in words, by the `report` field it carries. */
export function anyReportText(data: unknown, lang: Lang): string {
  const d = data as { report: string } & Record<string, unknown>;
  switch (d.report) {
    case "result":
      return resultText(data as ResultReport, lang);
    case "balance":
      return balanceText(data as BalanceReport, lang);
    case "stock":
      return stockText(data as StockReport, lang);
    case "stock_cost":
      return costText(data as Parameters<typeof costText>[0], lang);
    case "stock_semi":
      return semiText(data as Parameters<typeof semiText>[0], lang);
    case "result_explain":
      return explainText(data as Parameters<typeof explainText>[0], lang);
    case "aging_receivables":
    case "aging_payables":
      return agingText(data as Parameters<typeof agingText>[0], lang);
    case "tax_accrual":
      return taxAccrualText(data as Parameters<typeof taxAccrualText>[0], lang);
    case "tax_calendar":
      return calendarText(data as Parameters<typeof calendarText>[0], lang);
    case "tax_registers":
      return registersText(data as Parameters<typeof registersText>[0], lang);
    case "bank_reconcile":
      return reconcileText(data as Parameters<typeof reconcileText>[0], lang);
    default:
      return debtsText(data as DebtsReport, lang);
  }
}
