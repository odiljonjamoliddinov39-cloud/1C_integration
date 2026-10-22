/**
 * The financial reports in words: the lines of the result and of the balance, the biggest debtors and creditors, the
 * stock, each with the accounts the figure came from and the checks that failed. In the accountant's language.
 */
import type { Lang } from "../router.js";
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
