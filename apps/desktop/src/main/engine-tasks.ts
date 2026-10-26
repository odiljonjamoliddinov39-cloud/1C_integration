/**
 * The jobs the program does by itself, with no model: entering a bank statement or Didox documents, loading the
 * exchange rates, checking the balances and the currency revaluation. The message is read here (what is asked, for
 * which period), the job is run by the assistant through the same tools the model would call, and the answer is
 * written here from what the tool returned. The model is for what the program cannot settle; when its budget is gone,
 * these jobs still work.
 */
import { searchKnowledge } from "@platform/shared";

import type { Lang } from "./router.js";

export type ReportKind =
  | "result"
  | "result_explain"
  | "balance"
  | "receivables"
  | "payables"
  | "aging_receivables"
  | "aging_payables"
  | "stock"
  | "stock_semi"
  | "tax_accrual"
  | "tax_calendar"
  | "tax_registers"
  | "bank_reconcile";

export type EngineTask =
  | { kind: "bank"; from?: string; to?: string }
  | { kind: "didox_in"; from: string; to: string }
  | { kind: "didox_sales"; from: string; to: string }
  | { kind: "rates"; from?: string; to?: string; currencies?: string[] }
  | { kind: "balances"; date: string }
  | {
      kind: "report";
      report: ReportKind;
      from: string;
      to: string;
    }
  | { kind: "revaluation"; from: string; to: string }
  | {
      kind: "calc";
      input:
        | { op: "vat"; amount: number; rate?: number; mode: "exclusive" | "inclusive" }
        | { op: "payroll"; gross?: number; net?: number };
    };

const norm = (text: string) =>
  text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‘’`ʻʼ]/g, "'");

const ENTER =
  /(кирит|киргиз|kirit|kirgiz|введи|ввести|вноси|внес[иё]|занес[иё]|оприходу|enter\b|import|загрузи в 1[сc]|1[сc]\s*(га|ga)\s*(кирит|kirit))/u;
const SALES = /(sotuv|сотув|реализац|продаж|chiquvchi|чиқувчи|исходящ|выставлен|sales)/u;
const DIDOX = /(didox|дидокс|дидок|didoks)/u;
const STATEMENT = /(выписк|ko'chirma|кўчирма|кучирма|bank|банк|statement|vypiska)/u;

const todayOf = (today: string) => today.slice(0, 10);

const pad = (n: number | string) => String(n).padStart(2, "0");

/** The period a message names: two dates, a year ("2024 йил"), or nothing. */
export function periodIn(text: string): { from: string; to: string } | null {
  const t = norm(text);
  const dates = [...t.matchAll(/(\d{1,2})[./](\d{1,2})[./](\d{4})/g)].map(
    (m) => `${m[3]}-${pad(m[2] ?? "")}-${pad(m[1] ?? "")}`,
  );
  const iso = [...t.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)].map((m) => m[0]);
  const found = [...dates, ...iso].filter((d) => !Number.isNaN(Date.parse(d))).sort();
  if (found.length >= 2) return { from: found[0] as string, to: found.at(-1) as string };
  const year =
    /(?<!\d)(20\d{2})\s*(йил|yil|y\.|год|г\.|-yil)/u.exec(t) ?? /(?:за|for|in)\s+(20\d{2})(?!\d)/u.exec(t);
  if (year) return { from: `${year[1]}-01-01`, to: `${year[1]}-12-31` };
  return null;
}

/** One date a message names ("2024-12-31", "31.12.2024"), or null. */
export function singleDate(text: string): string | null {
  const t = norm(text);
  const dmy = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(t);
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const found = iso ? iso[0] : dmy ? `${dmy[3]}-${pad(dmy[2] ?? "")}-${pad(dmy[1] ?? "")}` : null;
  return found && !Number.isNaN(Date.parse(found)) ? found : null;
}

/** The amount a message names: "1 000 000", "1,250,000.50", "12 млн"; null when there is none. */
export function amountIn(text: string): number | null {
  const t = norm(text).replace(/\d{1,2}\s*%/g, " ");
  const found = [
    ...t.matchAll(
      /(\d{1,3}(?:[\s,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(млн|mln|million|миллион|ming|минг|тыс)?/gu,
    ),
  ];
  let best: number | null = null;
  for (const m of found) {
    let raw = m[1] ?? "";
    // "1 000 000" and "1,000,000" are thousands; "1250000.50" and "1250,5" have a fraction.
    if (/^\d{1,3}(?:[\s,.]\d{3})+$/.test(raw)) raw = raw.replace(/[\s,.]/g, "");
    else
      raw = raw
        .replace(/\s/g, "")
        .replace(/,(\d{1,2})$/, ".$1")
        .replace(/,/g, "");
    let n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const unit = m[2] ?? "";
    if (/млн|mln|million|миллион/.test(unit)) n *= 1_000_000;
    else if (/ming|минг|тыс/.test(unit)) n *= 1000;
    if (best === null || n > best) best = n;
  }
  return best !== null && best >= 1 ? best : null;
}

const CHECK = /(tekshir|текшир|провер|check|audit)/u;
const DIDOX_WORD = /(didox|дидокс|дидок|didoks)/u;

/** The statement a message asks for: the financial result, the balance, the debts, the stock, the taxes. */
function readReport(t: string, hasBank: boolean): ReportKind | null {
  const EXPLAIN =
    /(tushuntir|тушунтир|объясн|explain|nima uchun|nega\b|nimaga|sabab|нима учун|нега|почему|why|omillar|омиллар|факторы|drivers)/u;
  const RESULT =
    /(moliyaviy\s*natija|молиявий\s*натижа|финансов\p{L}*\s*результат|foyda|фойда|zarar|зарар|прибыл|убыт|p&l|profit|income statement|financial result|2-shakl|2-форма|2-форм)/u;
  if (RESULT.test(t)) return EXPLAIN.test(t) ? "result_explain" : "result";
  const AGING =
    /(muddat\p{L}*\s*o'tgan|муддати\s*ўтган|просроч|срок\p{L}*\s*давност|aging|overdue|kechik|кечик|eskirgan|старени)/u;
  const DEBITOR = /(debitor|дебитор|receivable)/u;
  const KREDITOR = /(kreditor|кредитор|payable)/u;
  if (
    AGING.test(t) ||
    ((DEBITOR.test(t) || KREDITOR.test(t)) && /(muddat|муддат|срок|возраст|yosh|ёш)/u.test(t))
  )
    return KREDITOR.test(t) && !DEBITOR.test(t) ? "aging_payables" : "aging_receivables";
  if (DEBITOR.test(t)) return "receivables";
  if (KREDITOR.test(t)) return "payables";
  const TAX = /(soliq|солиқ|налог|tax)/u;
  if (
    /(kalendar|календар|deadline|muddatlar|муддатлар|сроки сдач|сроки уплат|qachon\s*(topshir|to'la)|когда\s*(сдава|плати))/u.test(
      t,
    ) &&
    (TAX.test(t) || /(hisobot|ҳисобот|отчет|report)/u.test(t))
  )
    return "tax_calendar";
  if (
    /(xaridlar|харидлар|sotuvlar|сотувлар).*(kitob|китоб)|книг\p{L}*\s*(покупок|продаж)|purchase.*sales.*(book|ledger)|реестр/u.test(
      t,
    ) ||
    (DIDOX_WORD.test(t) &&
      /(solishtir|солиштир|taqqosla|таққосла|сверк|сверь|reconcil|compare|mos kel|мос кел)/u.test(t))
  )
    return "tax_registers";
  if (
    TAX.test(t) &&
    /(hisobla|ҳисобла|hisob-kitob|начисл|рассчита|accru|calculate|qancha|қанча|сколько|how much|nechta|to'lash kerak|к уплате|tayyorla)/u.test(
      t,
    ) &&
    !CHECK.test(t) &&
    // A year in the message ("2026 yil") is a period, not a sum.
    amountIn(
      t
        .replace(/(?<!\d)20\d{2}\s*(йил|yil|год|г\.|-yil)/gu, " ")
        .replace(/(?:за|for|in)\s+20\d{2}(?!\d)/gu, " "),
    ) === null
  )
    return "tax_accrual";
  if (
    hasBank &&
    /(ko'chirma|кўчирма|кучирма|выписк|statement|bank|банк)/u.test(t) &&
    /(solishtir|солиштир|taqqosla|таққосла|сверь|сверк|reconcil|compare|mos|мос|qoldig'i.*1[сc]|остаток.*1[сc])/u.test(
      t,
    )
  )
    return "bank_reconcile";
  if (/(yarim\s*tayyor|ярим\s*тайёр|полуфабрикат|незавершенн|semi-?finished|work in progress)/u.test(t))
    return "stock_semi";
  if (
    /(ombor|склад|warehouse|tovar\p{L}*\s*(qoldiq|ostatk)|товар\p{L}*\s*(остат|қолдиқ)|stock|запас|zaxira)/u.test(
      t,
    ) &&
    /(qoldiq|қолдиқ|остат|balance|ko'rsat|кўрсат|покаж|show|nechta|сколько|қанча|qancha)/u.test(t)
  )
    return "stock";
  // The balance sheet, not the check of the balances (that is "balances" below).
  if (/(balans|баланс|balance sheet|1-shakl|1-форма|1-форм)/u.test(t) && !CHECK.test(t)) return "balance";
  return null;
}

export function readEngineTask(text: string, ctx: { hasBank: boolean; today: string }): EngineTask | null {
  const t = norm(text);
  if (t.trim().length > 400) return null;
  const period = periodIn(t);
  const year = todayOf(ctx.today).slice(0, 4);
  const whole = period ?? { from: `${year}-01-01`, to: todayOf(ctx.today) };

  if (/(qayta\s*baholash|қайта\s*баҳола|қайта\s*бахола|переоценк|revaluation)/u.test(t))
    return { kind: "revaluation", ...whole };
  if (/(курс|kurs)\p{L}*/u.test(t) && /(yukla|юкла|загруз|load|qo'y|қўй|запиш)/u.test(t)) {
    const currencies = [
      ...(/(usd|доллар|dollar)/u.test(t) ? ["USD"] : []),
      ...(/(rub|рубл|rubl)/u.test(t) ? ["RUB"] : []),
      ...(/(eur|евро|yevro)/u.test(t) ? ["EUR"] : []),
    ];
    return { kind: "rates", ...(period ?? {}), ...(currencies.length > 0 ? { currencies } : {}) };
  }
  const report = readReport(t, ctx.hasBank);
  if (report === "tax_calendar") {
    // Deadlines ahead: from the date named (or today) for the period named (or 45 days).
    const today = todayOf(ctx.today);
    const ahead = new Date(Date.parse(today) + 45 * 86_400_000).toISOString().slice(0, 10);
    return { kind: "report", report, from: period?.from ?? singleDate(t) ?? today, to: period?.to ?? ahead };
  }
  if (report)
    return {
      kind: "report",
      report,
      from: (period ?? { from: `${year}-01-01` }).from,
      to: period?.to ?? singleDate(t) ?? todayOf(ctx.today),
    };
  if (
    /(qoldiq|қолдиқ|остатк|оборотн|saldo|balance|баланс)\p{L}*/u.test(t) &&
    /(tekshir|текшир|провер|check|ko'r|кўр|покаж|show)/u.test(t)
  )
    return { kind: "balances", date: period?.to ?? todayOf(ctx.today) };
  if (DIDOX.test(t) && ENTER.test(t)) {
    return SALES.test(t) ? { kind: "didox_sales", ...whole } : { kind: "didox_in", ...whole };
  }
  if (ctx.hasBank && ENTER.test(t) && (STATEMENT.test(t) || !DIDOX.test(t)))
    return { kind: "bank", ...(period ?? {}) };
  // A sum to work out: VAT, or the pay-roll taxes of a salary.
  const amount = amountIn(t);
  if (amount !== null) {
    if (/(qqs|ндс|vat|қҚс|ққс)/u.test(t)) {
      // A rate named in the message is used; otherwise the company's tax table gives the rate of the day.
      const typed = /(\d{1,2}(?:[.,]\d)?)\s*%/.exec(t)?.[1]?.replace(",", ".");
      const inclusive =
        /(ichida|ичида|включ|с ндс|ндс билан|qqs bilan|ққс билан|including|incl|inclusive)/u.test(t);
      return {
        kind: "calc",
        input: {
          op: "vat",
          amount,
          ...(typed ? { rate: Number(typed) } : {}),
          mode: inclusive ? "inclusive" : "exclusive",
        },
      };
    }
    if (/(oylik|ойлик|зарплат|salary|jshds|жшдс|ндфл|ndfl|inps|инпс|иншп|payroll)/u.test(t)) {
      const net = /(qo'lga|қўлга|на руки|net\b|чист|olinadigan|олинадиган)/u.test(t);
      return { kind: "calc", input: { op: "payroll", ...(net ? { net: amount } : { gross: amount }) } };
    }
  }
  return null;
}

// --- The words of the answers ------------------------------------------------------------------------------

const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 }).replace(/,/g, " ");

const T = {
  ru: {
    entered: (n: number) => `Введено документов: ${n}.`,
    failed: (n: number) => `1С не приняла: ${n}.`,
    already: (n: number) => `Уже были в 1С: ${n}.`,
    transfers: (n: number) => `Переводов между своими счетами: ${n} док.`,
    created: (n: number) => `Создано справочных объектов (контрагенты, договоры): ${n}.`,
    left: (n: number) => `Не разобрано программой: ${n}.`,
    reasons: "Причины:",
    transfersLeft: (n: number) => `Переводов и конвертаций между своими счетами не введено: ${n}. Причины:`,
    notes: (n: number) => `Решений программы, которые стоит проверить: ${n}.`,
    rates: "Курсы валют не загружены:",
    declined: "Карточка отклонена: ничего не записано.",
    nothing: "Вводить нечего: всё уже в 1С или вне периода.",
    next: "Что осталось — напишите, как поступить (модель разберёт), или проведите введённое командой «проведи».",
    failedHead: "Ошибки 1С:",
    problem: "Ошибка:",
    balancesOk: (date: string) => `Остатки на ${date}: замечаний нет.`,
    balances: (date: string, n: number) => `Остатки на ${date}: замечаний ${n}.`,
    exchange: (inc: number, exp: number) =>
      `Курсовые разницы (95xx доход / 96xx расход): ${money(inc)} / ${money(exp)}.`,
    revOk: "Переоценка не требуется: остатки в сумах совпадают с курсом.",
    rev: (n: number, gain: number, loss: number) =>
      `Переоценка валютных остатков нужна по ${n} позициям: доход ${money(gain)}, расход ${money(loss)}. Её выполняет 1С («Закрытие месяца → Переоценка валютных средств»), потом проверьте снова.`,
    noRate: "Нет курса на дату — загрузите курсы:",
    ratesDone: (n: number) => `Курсы валют записаны: ${n}.`,
    ratesHave: "Курсы за период уже в 1С.",
    sources: "Программа сделала это сама, без модели.",
  },
  uz: {
    entered: (n: number) => `Kiritilgan hujjatlar: ${n}.`,
    failed: (n: number) => `1C qabul qilmadi: ${n}.`,
    already: (n: number) => `1C da avvaldan bor: ${n}.`,
    transfers: (n: number) => `O'z hisoblari orasidagi o'tkazmalar: ${n} ta hujjat.`,
    created: (n: number) => `Yaratilgan spravochnik elementlari (kontragent, shartnoma): ${n}.`,
    left: (n: number) => `Dastur hal qila olmagan: ${n}.`,
    reasons: "Sabablari:",
    transfersLeft: (n: number) =>
      `O'z hisoblari orasidagi o'tkazma va konvertatsiyalar kiritilmadi: ${n}. Sabablari:`,
    notes: (n: number) => `Dastur o'zi qaror qilgan, tekshirishga arziydigan holatlar: ${n}.`,
    rates: "Valyuta kurslari yuklanmadi:",
    declined: "Kartochka rad etildi: hech narsa yozilmadi.",
    nothing: "Kiritadigan narsa yo'q: hammasi 1C da bor yoki davrdan tashqarida.",
    next: "Qolganini qanday hal qilishni yozing (model ko'radi) yoki kiritilganlarni «проведи» buyrug'i bilan provedit qiling.",
    failedHead: "1C xatolari:",
    problem: "Xato:",
    balancesOk: (date: string) => `${date} dagi qoldiqlar: e'tiroz yo'q.`,
    balances: (date: string, n: number) => `${date} dagi qoldiqlar: e'tirozlar ${n} ta.`,
    exchange: (inc: number, exp: number) =>
      `Kurs farqlari (95xx daromad / 96xx xarajat): ${money(inc)} / ${money(exp)}.`,
    revOk: "Qayta baholash shart emas: so'mdagi qoldiqlar kursga mos.",
    rev: (n: number, gain: number, loss: number) =>
      `Valyuta qoldiqlarini qayta baholash ${n} pozitsiya bo'yicha kerak: daromad ${money(gain)}, xarajat ${money(loss)}. Uni 1C o'zi bajaradi («Закрытие месяца → Переоценка валютных средств»), keyin qayta tekshiring.`,
    noRate: "Sanaga kurs yo'q — kurslarni yuklang:",
    ratesDone: (n: number) => `Valyuta kurslari yozildi: ${n} ta.`,
    ratesHave: "Davr kurslari 1C da bor.",
    sources: "Buni dastur o'zi, modelsiz bajardi.",
  },
  en: {
    entered: (n: number) => `Documents entered: ${n}.`,
    failed: (n: number) => `1C did not accept: ${n}.`,
    already: (n: number) => `Already in 1C: ${n}.`,
    transfers: (n: number) => `Transfers between own accounts: ${n} documents.`,
    created: (n: number) => `Directory items created (counterparties, contracts): ${n}.`,
    left: (n: number) => `The program could not settle: ${n}.`,
    reasons: "Reasons:",
    transfersLeft: (n: number) => `Moves and conversions between own accounts not entered: ${n}. Reasons:`,
    notes: (n: number) => `Decisions the program made that are worth checking: ${n}.`,
    rates: "Exchange rates not loaded:",
    declined: "Card declined: nothing was written.",
    nothing: "Nothing to enter: it is all in 1C already or outside the period.",
    next: "Tell me how to settle the rest (the model will look), or post what was entered with «post them».",
    failedHead: "1C errors:",
    problem: "Error:",
    balancesOk: (date: string) => `Balances at ${date}: nothing to flag.`,
    balances: (date: string, n: number) => `Balances at ${date}: ${n} to look at.`,
    exchange: (inc: number, exp: number) =>
      `Exchange differences (95xx income / 96xx expense): ${money(inc)} / ${money(exp)}.`,
    revOk: "No revaluation needed: the balances in soums agree with the rates.",
    rev: (n: number, gain: number, loss: number) =>
      `The currency balances need revaluing in ${n} positions: gain ${money(gain)}, loss ${money(loss)}. 1C does it («Закрытие месяца → Переоценка валютных средств»); check again afterwards.`,
    noRate: "No rate on the date — load the rates:",
    ratesDone: (n: number) => `Exchange rates written: ${n}.`,
    ratesHave: "The rates for the period are in 1C already.",
    sources: "The program did this by itself, with no model.",
  },
} as const;

interface BatchData {
  status?: string;
  applied?: unknown[];
  failed?: { n?: number; error?: string; message?: string }[];
  refusedBefore?: { message?: string }[];
  enteredBefore?: number;
  alreadyIn1c?: { count?: number } | unknown;
  transfersEntered?: { documents?: number };
  transfersNotEntered?: { count?: number; problems?: { message?: string; rows?: number }[] };
  createdInThisRun?: unknown[];
  notCreated?: unknown[];
  needsAttention?: { count?: number; problems?: { rows?: unknown[]; message?: string }[] };
  notes?: unknown[];
  ratesNotLoaded?: string;
  counts?: { applied?: number };
}

/** What a job that entered documents did, in the accountant's language: counts, what failed and why, what is left. */
export function batchText(data: unknown, lang: Lang): string {
  const w = T[lang];
  const d = (data ?? {}) as BatchData;
  if (d.status === "declined_by_user") return w.declined;
  const entered = (d.counts?.applied ?? d.applied?.length ?? 0) + (d.enteredBefore ?? 0);
  const lines: string[] = [];
  if (entered > 0) lines.push(w.entered(entered));
  const failed = d.failed ?? [];
  if (failed.length > 0) {
    lines.push(w.failed(failed.length));
    lines.push(w.failedHead);
    for (const f of failed.slice(0, 5)) lines.push(`  – ${f.message ?? f.error ?? "?"}`);
  }
  const already = (d.alreadyIn1c as { count?: number } | undefined)?.count;
  if (already) lines.push(w.already(already));
  if (d.transfersEntered?.documents) lines.push(w.transfers(d.transfersEntered.documents));
  if (d.createdInThisRun?.length) lines.push(w.created(d.createdInThisRun.length));
  const left = d.needsAttention?.count ?? 0;
  if (left > 0) {
    lines.push(w.left(left));
    lines.push(w.reasons);
    for (const p of (d.needsAttention?.problems ?? []).slice(0, 6))
      lines.push(`  – ${p.message ?? "?"}${p.rows?.length ? ` (${p.rows.length})` : ""}`);
  }
  const transfersLeft = d.transfersNotEntered?.count ?? 0;
  if (transfersLeft > 0) {
    lines.push(w.transfersLeft(transfersLeft));
    for (const p of (d.transfersNotEntered?.problems ?? []).slice(0, 6))
      lines.push(`  – ${p.message ?? "?"}${p.rows ? ` (${p.rows})` : ""}`);
  }
  if (d.notes?.length) lines.push(w.notes(d.notes.length));
  if (d.ratesNotLoaded) lines.push(`${w.rates} ${d.ratesNotLoaded}`);
  if (lines.length === 0) lines.push(w.nothing);
  if (left > 0 || failed.length > 0 || transfersLeft > 0) lines.push(w.next);
  lines.push(w.sources);
  return lines.join("\n");
}

export function failureText(message: string, lang: Lang): string {
  return `${T[lang].problem} ${message}\n${T[lang].sources}`;
}

export function balancesText(
  data: {
    date: string;
    findings: { account: string; name: string; balance: number; why: string }[];
    exchangeDifferences: { income: number; expense: number };
  },
  lang: Lang,
): string {
  const w = T[lang];
  const lines = [
    data.findings.length === 0 ? w.balancesOk(data.date) : w.balances(data.date, data.findings.length),
  ];
  for (const f of data.findings.slice(0, 12)) lines.push(`  – ${f.account} ${money(f.balance)}: ${f.why}`);
  if (data.exchangeDifferences.income || data.exchangeDifferences.expense)
    lines.push(w.exchange(data.exchangeDifferences.income, data.exchangeDifferences.expense));
  lines.push(w.sources);
  return lines.join("\n");
}

export function revaluationText(
  data: {
    differences: number;
    totals: { gain: number; loss: number };
    noRate?: string[];
    findings: { month: string; account: string; currency: string; adjustment: number; entry: string }[];
  },
  lang: Lang,
): string {
  const w = T[lang];
  const lines: string[] = [];
  if (data.noRate?.length) lines.push(`${w.noRate} ${data.noRate.join(", ")}`);
  lines.push(data.differences === 0 ? w.revOk : w.rev(data.differences, data.totals.gain, data.totals.loss));
  for (const f of data.findings.slice(0, 10)) lines.push(`  – ${f.month} ${f.entry}`);
  lines.push(w.sources);
  return lines.join("\n");
}

export function ratesText(data: unknown, lang: Lang): string {
  const w = T[lang];
  const d = (data ?? {}) as BatchData & { status?: string };
  if (d.status === "already_exists") return `${w.ratesHave}\n${w.sources}`;
  if (d.status === "declined_by_user") return w.declined;
  // One entry per currency; its presentation says how many rates it wrote ("USD: 249 rates written").
  const written = (d.applied ?? []).reduce<number>((n, a) => {
    const text = String((a as { object?: { presentation?: string } }).object?.presentation ?? "");
    return n + (Number(/(\d+) rates written/.exec(text)?.[1]) || 0);
  }, 0);
  return `${w.ratesDone(written)}\n${w.sources}`;
}

/** The codes under which the model cannot answer (no budget, no quota, no key, the provider's billing): the program answers. */
export const MODEL_OFF_CODES = new Set([
  "AI_BUDGET_EXCEEDED",
  "AI_USER_DAILY_LIMIT",
  "AI_QUESTIONS_LIMIT",
  "AI_DAILY_LIMIT",
  "AI_QUOTA_EXCEEDED",
  "AI_NOT_CONFIGURED",
  "AI_OUT_OF_SERVICE",
  "AI_PROVIDER_BILLING",
  "AI_UNAVAILABLE",
]);

const OFFLINE = {
  ru: {
    head: "Модель сейчас не отвечает (лимит или недоступна). Ответ из базы знаний программы:",
    confirm: "Подтвердите по практике компании:",
    none: "Модель сейчас не отвечает, а в базе знаний программы нет ответа на этот вопрос. Без модели программа делает сама: ввод банковской выписки («введи выписку»), ввод документов Didox («введи Didox за 2024 год»), проведение («проведи»), загрузку курсов валют («загрузи курсы USD за 2024 год»), проверку остатков («проверь остатки») и переоценки («проверь переоценку за 2024 год»), а также типовые вопросы по данным 1С.",
  },
  uz: {
    head: "Model hozir javob bermayapti (limit yoki mavjud emas). Dasturning bilim bazasidan javob:",
    confirm: "Kompaniya amaliyoti bo'yicha tasdiqlang:",
    none: "Model hozir javob bermayapti, dasturning bilim bazasida bu savolga javob yo'q. Modelsiz dastur o'zi bajaradi: bank ko'chirmasini kiritish («ko'chirmani kirit»), Didox hujjatlarini kiritish («Didox 2024 yilni kirit»), provedit qilish («проведи»), valyuta kurslarini yuklash («USD kurslarini 2024 yil yukla»), qoldiqlarni tekshirish («qoldiqlarni tekshir») va qayta baholashni tekshirish («qayta baholashni tekshir 2024 yil»), shuningdek 1C ma'lumotlari bo'yicha tayyor savollar.",
  },
  en: {
    head: "The model is not answering now (limit reached or unavailable). The answer from the program's knowledge base:",
    confirm: "Confirm against the company's practice:",
    none: "The model is not answering now and the program's knowledge base has no answer to this. With no model the program itself does: entering a bank statement («enter the statement»), Didox documents («enter Didox for 2024»), posting («post them»), loading exchange rates («load USD rates for 2024»), checking the balances («check the balances») and the revaluation («check the revaluation for 2024»), and the usual questions about the 1C data.",
  },
} as const;

/** What the program says to a question when the model cannot answer: the knowledge base's entries, or what it does by itself. */
export function offlineAnswer(question: string, lang: Lang): string {
  const w = OFFLINE[lang];
  const entries = searchKnowledge(question, 2);
  if (entries.length === 0) return w.none;
  const parts = entries.map(
    (e) =>
      `${e.title}\n${e.lines.map((l) => `  – ${l}`).join("\n")}${e.confirm ? `\n  ${w.confirm} ${e.confirm}` : ""}`,
  );
  return `${w.head}\n\n${parts.join("\n\n")}`;
}

const CALC_TITLE = {
  vat: { ru: "НДС", uz: "QQS", en: "VAT" },
  payroll: { ru: "Заработная плата и налоги", uz: "Ish haqi va soliqlar", en: "Pay-roll and taxes" },
} as const;

/** A calculation's result, one figure a line (nested figures flattened one level), in the accountant's language. */
export function calcText(op: "vat" | "payroll", result: Record<string, unknown>, lang: Lang): string {
  const lines: string[] = [CALC_TITLE[op][lang]];
  const show = (key: string, value: unknown) => {
    if (typeof value === "number") lines.push(`  ${key}: ${money(value)}`);
    else if (typeof value === "string" || typeof value === "boolean")
      lines.push(`  ${key}: ${String(value)}`);
  };
  for (const [key, value] of Object.entries(result)) {
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [k, v] of Object.entries(value)) show(`${key}.${k}`, v);
    else show(key, value);
  }
  lines.push(T[lang].sources);
  return lines.join("\n");
}

/** What the search for bank documents entered twice found and did, in the accountant's language. */
export function duplicatesText(data: unknown, lang: Lang): string {
  const d = (data ?? {}) as {
    status?: string;
    removed?: number;
    groups?: {
      account: string;
      day: string;
      amount: string;
      rows: number;
      documents: number;
      kept: string;
      removed: string;
    }[];
    checked?: {
      accounts: string[];
      statementRows: number;
      documents: number;
      unjudged: number;
      withoutRow: number;
      missing: number;
    };
  };
  const w = {
    ru: {
      declined: "Карточка отклонена: ничего не удалено.",
      none: (c: string) => `Дублей нет. ${c}`,
      checked: (n: { statementRows: number; documents: number; accounts: number }) =>
        `Проверено: строк выписок ${n.statementRows}, документов 1С ${n.documents}, счетов ${n.accounts}. Дубль — документ сверх числа строк выписки (счёт, день, сумма, направление).`,
      done: (n: number) => `Помечено на удаление дублей: ${n}. 1С их не проводит; пометку можно снять.`,
      found: (n: number) => `Найдено дублей: ${n}.`,
      line: (g: {
        account: string;
        day: string;
        amount: string;
        rows: number;
        documents: number;
        kept: string;
        removed: string;
      }) =>
        `  – ${g.day} · ${g.account.slice(0, 5)}… · ${g.amount}: в выписке ${g.rows}, в 1С ${g.documents}; остался ${g.kept}, лишний ${g.removed}`,
      aside: (u: number, o: number, m: number) =>
        `Не трогал: документов чужих счетов ${u}; документов без строки в выписке ${o}. Строк выписки, для которых в 1С документов меньше: ${m}.`,
      source: "Программа сделала это сама, без модели.",
    },
    uz: {
      declined: "Kartochka rad etildi: hech narsa o'chirilmadi.",
      none: (c: string) => `Takror yo'q. ${c}`,
      checked: (n: { statementRows: number; documents: number; accounts: number }) =>
        `Tekshirildi: ko'chirma qatorlari ${n.statementRows}, 1C hujjatlari ${n.documents}, hisoblar ${n.accounts}. Takror — ko'chirma qatorlari sonidan ortiqcha hujjat (hisob, kun, summa, yo'nalish bo'yicha).`,
      done: (n: number) =>
        `Takror hujjatlar o'chirishga belgilandi: ${n} ta. 1C ularni o'tkazmaydi; belgini olib tashlash mumkin.`,
      found: (n: number) => `Topilgan takrorlar: ${n} ta.`,
      line: (g: {
        account: string;
        day: string;
        amount: string;
        rows: number;
        documents: number;
        kept: string;
        removed: string;
      }) =>
        `  – ${g.day} · ${g.account.slice(0, 5)}… · ${g.amount}: ko'chirmada ${g.rows}, 1C da ${g.documents}; qoldi ${g.kept}, ortiqcha ${g.removed}`,
      aside: (u: number, o: number, m: number) =>
        `Tegmadim: boshqa hisoblarning hujjatlari ${u}; ko'chirmada qatori yo'q hujjatlar ${o}. 1C da hujjati kam bo'lgan ko'chirma qatorlari: ${m}.`,
      source: "Buni dastur o'zi, modelsiz bajardi.",
    },
    en: {
      declined: "Card declined: nothing was deleted.",
      none: (c: string) => `No duplicates. ${c}`,
      checked: (n: { statementRows: number; documents: number; accounts: number }) =>
        `Checked: ${n.statementRows} statement rows, ${n.documents} documents of 1C, ${n.accounts} accounts. A duplicate is a document beyond the number of statement rows (account, day, amount, direction).`,
      done: (n: number) =>
        `Duplicates marked for deletion: ${n}. 1C does not post them; the mark can be lifted.`,
      found: (n: number) => `Duplicates found: ${n}.`,
      line: (g: {
        account: string;
        day: string;
        amount: string;
        rows: number;
        documents: number;
        kept: string;
        removed: string;
      }) =>
        `  – ${g.day} · ${g.account.slice(0, 5)}… · ${g.amount}: statement ${g.rows}, 1C ${g.documents}; kept ${g.kept}, extra ${g.removed}`,
      aside: (u: number, o: number, m: number) =>
        `Left alone: documents of other accounts ${u}; documents with no statement row ${o}. Statement rows with fewer documents in 1C: ${m}.`,
      source: "The program did this itself, no model.",
    },
  }[lang];
  if (d.status === "declined_by_user") return w.declined;
  const c = d.checked;
  const checked = c
    ? w.checked({ statementRows: c.statementRows, documents: c.documents, accounts: c.accounts.length })
    : "";
  const lines: string[] = [];
  if (d.status === "no_duplicates") lines.push(w.none(checked));
  else {
    if (d.removed !== undefined) lines.push(w.done(d.removed));
    else lines.push(w.found(d.groups?.length ?? 0));
    if (checked) lines.push(checked);
    for (const g of (d.groups ?? []).slice(0, 25)) lines.push(w.line(g));
    if ((d.groups?.length ?? 0) > 25) lines.push(`  … ${(d.groups?.length ?? 0) - 25}`);
  }
  if (c && (c.unjudged > 0 || c.withoutRow > 0 || c.missing > 0))
    lines.push(w.aside(c.unjudged, c.withoutRow, c.missing));
  lines.push(w.source);
  return lines.join("\n");
}

/** What the setting right of the postings of the bank documents did, in the accountant's language. */
export function postingsText(data: unknown, lang: Lang): string {
  const d = (data ?? {}) as {
    status?: string;
    retire?: number;
    reledger?: number;
    retired?: number;
    reledgered?: number;
    unknownLedger?: number;
    checked?: number;
    accountsWithoutLedger?: string[];
    reentered?: { enteredBefore?: number; applied?: unknown[]; status?: string; error?: string } | null;
  };
  const w = {
    ru: {
      declined: "Карточка отклонена: ничего не изменено.",
      none: (n: number) =>
        `Проверено банковских документов: ${n}. Все проведены на счёт банка своего расчётного счёта, переводов формы «Перевод на другой счёт» нет: исправлять нечего.`,
      done: (a: number, b: number) =>
        `Исправлено: счёт банка у ${a} документов (проведены заново); переводов «Перевод на другой/с другого счёта» снято и введено заново: ${b}.`,
      reentered: (n: number) => `Введено заново из выписки: ${n} (не проведены: «проведи»).`,
      checked: (n: number) => `Проверено документов: ${n}.`,
      noLedger: (list: string) =>
        `У банковских счетов нет счёта учёта в карточке 1С (документы не тронуты): ${list}. Укажите его в карточке счёта (5530 — блокировка, 5210 — валютный).`,
      next: "Дальше: «проведи», потом «проверь остатки».",
      source: "Программа сделала это сама, без модели.",
    },
    uz: {
      declined: "Kartochka rad etildi: hech narsa o'zgarmadi.",
      none: (n: number) =>
        `Tekshirilgan bank hujjatlari: ${n}. Hammasi o'z hisobining bank schyotiga o'tgan, «Перевод на другой счет» shaklidagi o'tkazma yo'q: tuzatadigan narsa yo'q.`,
      done: (a: number, b: number) =>
        `Tuzatildi: bank schyoti ${a} ta hujjatda (qayta o'tkazildi); «Перевод на другой/с другого счета» o'tkazmalari olib tashlanib, qayta kiritildi: ${b} ta.`,
      reentered: (n: number) => `Ko'chirmadan qayta kiritildi: ${n} ta (o'tkazilmagan: «проведи»).`,
      checked: (n: number) => `Tekshirilgan hujjatlar: ${n}.`,
      noLedger: (list: string) =>
        `Bank hisoblarining 1C kartochkasida hisob raqami (счёт учёта) yo'q (hujjatlarga tegilmadi): ${list}. Uni hisob kartochkasida ko'rsating (5530 — blokirovka, 5210 — valyuta).`,
      next: "Keyingisi: «проведи», keyin «qoldiqlarni tekshir».",
      source: "Buni dastur o'zi, modelsiz bajardi.",
    },
    en: {
      declined: "Card declined: nothing was changed.",
      none: (n: number) =>
        `Bank documents checked: ${n}. All are booked to the bank account of their own account and there is no «Перевод на другой счёт» move: nothing to set right.`,
      done: (a: number, b: number) =>
        `Set right: the bank account of ${a} documents (posted again); moves of the operation «Перевод на другой/с другого счёта» taken back and entered again: ${b}.`,
      reentered: (n: number) => `Entered again from the statement: ${n} (not posted: «post them»).`,
      checked: (n: number) => `Documents checked: ${n}.`,
      noLedger: (list: string) =>
        `The bank accounts have no ledger account on their card in 1C (documents left alone): ${list}. Give it on the account's card (5530 for blocked funds, 5210 for a currency account).`,
      next: "Next: «post them», then «check the balances».",
      source: "The program did this itself, no model.",
    },
  }[lang];
  if (d.status === "declined_by_user") return w.declined;
  const lines: string[] = [];
  if (d.status === "nothing_to_fix") lines.push(w.none(d.checked ?? 0));
  else {
    lines.push(w.done(d.reledgered ?? d.reledger ?? 0, d.retired ?? d.retire ?? 0));
    if (d.checked) lines.push(w.checked(d.checked));
    const entered = d.reentered?.applied?.length ?? d.reentered?.enteredBefore;
    if (entered) lines.push(w.reentered(entered));
    lines.push(w.next);
  }
  if ((d.accountsWithoutLedger ?? []).length > 0)
    lines.push(w.noLedger((d.accountsWithoutLedger ?? []).join(", ")));
  lines.push(w.source);
  return lines.join("\n");
}
