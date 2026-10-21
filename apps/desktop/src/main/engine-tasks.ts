/**
 * The jobs the program does by itself, with no model: entering a bank statement or Didox documents, loading the
 * exchange rates, checking the balances and the currency revaluation. The message is read here (what is asked, for
 * which period), the job is run by the assistant through the same tools the model would call, and the answer is
 * written here from what the tool returned. The model is for what the program cannot settle; when its budget is gone,
 * these jobs still work.
 */
import { searchKnowledge } from "@platform/shared";

import type { Lang } from "./router.js";

export type EngineTask =
  | { kind: "bank"; from?: string; to?: string }
  | { kind: "didox_in"; from: string; to: string }
  | { kind: "didox_sales"; from: string; to: string }
  | { kind: "rates"; from?: string; to?: string; currencies?: string[] }
  | { kind: "balances"; date: string }
  | { kind: "revaluation"; from: string; to: string };

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
  if (d.notes?.length) lines.push(w.notes(d.notes.length));
  if (d.ratesNotLoaded) lines.push(`${w.rates} ${d.ratesNotLoaded}`);
  if (lines.length === 0) lines.push(w.nothing);
  if (left > 0 || failed.length > 0) lines.push(w.next);
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
