/**
 * Query templates on this PC: a known question is recognized by rules (its words), its parameters
 * are read from the question, and a fixed 1C query answers it, with no model and no cost.
 *
 * The matcher is strict on purpose. A question matches only when every word of one of the
 * template's phrases is in it and nothing else is (but filler words and its parameters), so a longer or different question (an
 * extra condition, another period, another counterparty) goes to the model. A wrong template
 * answer is worse than a paid one; every answer also has an "Ask AI anyway" button.
 */
import type { QueryResult, QueryTemplateView, TemplateColumn, TemplateParam } from "@platform/shared";

/** Words that carry no meaning for matching: they may be in the question without counting as extra. */
const FILLER = new Set([
  "как",
  "какой",
  "какая",
  "какие",
  "каков",
  "сколько",
  "покажи",
  "показать",
  "скажи",
  "мне",
  "нам",
  "пожалуйста",
  "на",
  "в",
  "во",
  "по",
  "за",
  "у",
  "нас",
  "сейчас",
  "сегодня",
  "текущий",
  "текущая",
  "и",
  "а",
  "ли",
  "the",
  "a",
  "an",
  "is",
  "are",
  "what",
  "show",
  "me",
  "please",
  "now",
  "today",
  "current",
  "of",
  "at",
  "in",
  "on",
  "for",
  "our",
  "my",
  "bugun",
  "hozir",
  "menga",
  "ko'rsat",
  "qancha",
  // Particles that go with a name ("Texmashga", "Texmash uchun", "для Техмаша"), not part of what is asked.
  "ga",
  "ka",
  "qa",
  "uchun",
  "bilan",
  "ning",
  "dan",
  "для",
  "с",
  "к",
]);

/**
 * Verbs that ask for an action, not for a figure ("удали документы с пометкой удаления", "delete the duplicates"): a
 * template only reads, so a question that asks to do something goes to the model and its confirmation cards.
 * Whole words, so "удаления" in a phrase is not one of them.
 */
const ACTIONS = new Set([
  ...[
    "удали",
    "удалить",
    "проведи",
    "провести",
    "отправь",
    "отправить",
    "создай",
    "создать",
    "измени",
    "изменить",
  ],
  ...[
    "исправь",
    "исправить",
    "загрузи",
    "загрузить",
    "отмени",
    "отменить",
    "внеси",
    "внести",
    "запиши",
    "записать",
  ],
  ...[
    "оплати",
    "оплатить",
    "закрой",
    "закрыть",
    "перенеси",
    "перенести",
    "пересчитай",
    "пометь",
    "сними",
    "заполни",
  ],
  ...[
    "delete",
    "remove",
    "create",
    "post",
    "send",
    "change",
    "fix",
    "update",
    "close",
    "pay",
    "enter",
    "write",
  ],
  ...["o'chir", "o'chirib", "o'chirish", "yarat", "yubor", "o'zgartir", "to'g'irla", "yoz", "kirit", "yop"],
]);

/** Legal forms that stand next to a counterparty's name. */
const LEGAL_FORMS = new Set(["mchj", "ooo", "ооо", "мчж", "xk", "qk", "ao", "ак", "ип", "ok", "aj"]);

/** Words that are the same word with an ending ("texmash", "texmashga"): one is the start of the other. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/** Longest counterparty name taken from a question, in words. */
const MAX_NAME_WORDS = 4;

const MONTHS: Record<string, number> = {
  январ: 1,
  феврал: 2,
  март: 3,
  апрел: 4,
  мая: 5,
  май: 5,
  июн: 6,
  июл: 7,
  август: 8,
  сентябр: 9,
  октябр: 10,
  ноябр: 11,
  декабр: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  yanvar: 1,
  fevral: 2,
  mart: 3,
  aprel: 4,
  iyun: 6,
  iyul: 7,
  avgust: 8,
  sentabr: 9,
  sentyabr: 9,
  oktabr: 10,
  oktyabr: 10,
  noyabr: 11,
  dekabr: 12,
};

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‘’`ʻʼ]/g, "'");

/** The first 4 letters stand for the word, so endings do not matter ("остаток", "остатка"). */
const stem = (word: string) => (word.length > 4 ? word.slice(0, 4) : word);

function words(text: string): string[] {
  return normalize(text)
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export interface TemplateMatch {
  template: QueryTemplateView;
  /** Values of the &parameters, ready for RunQuery (a counterparty's is still to be found, see below). */
  params: Record<string, string | number>;
  /** The words of the question that name a counterparty, and the parameter they are for. */
  counterparty?: { param: string; words: string[] };
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

interface Found {
  value: string | number;
  /** The words of the question this value used up. */
  used: string[];
  /** The question names a date that does not exist, or several: the model reads it. */
  ambiguous?: true;
}

type Period = { start: string; end: string; used: string[]; ambiguous?: undefined } | { ambiguous: true };

const realDate = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m);

/** Every date the question writes ("15.09.2026", "15/9/26", "2026-09-15"), in order; null when one does not exist. */
function datesIn(q: string): { iso: string; text: string }[] | null {
  const found: { iso: string; text: string; at: number }[] = [];
  for (const m of q.matchAll(/(?<![\d.])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?![\d])/g)) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3]?.length === 2 ? `20${m[3]}` : m[3])];
    if (!realDate(y, mo, d)) return null;
    found.push({ iso: isoDate(y, mo, d), text: m[0], at: m.index ?? 0 });
  }
  for (const m of q.matchAll(/(?<![\d])(\d{4})-(\d{2})-(\d{2})(?![\d])/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!realDate(y, mo, d)) return null;
    found.push({ iso: m[0], text: m[0], at: m.index ?? 0 });
  }
  return found.sort((x, y) => x.at - y.at);
}

/** The months the question names (each once), with the words that named them. */
function monthsIn(q: string): { month: number; word: string }[] {
  const found = new Map<number, string>();
  for (const word of words(q)) {
    const hit = Object.entries(MONTHS).find(([name]) => word.startsWith(name));
    if (hit) found.set(hit[1], word);
  }
  return [...found].map(([month, word]) => ({ month, word }));
}

const YEAR_WORDS = ["год", "года", "году", "г", "yil", "yilda", "yilga", "yilgi", "year"];
const QUARTER_WORDS = ["квартал", "квартала", "kvartal", "chorak", "choragi", "quarter"];
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4 };

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
};

const todayIso = (today: Date) =>
  isoDate(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate());

/** A day: the one the question writes, "yesterday", "the end of <month>", else today. */
function findDate(question: string, today: Date): Found {
  const q = normalize(question);
  const dates = datesIn(q);
  if (dates === null || dates.length > 1) return { value: todayIso(today), used: [], ambiguous: true };
  const [one] = dates;
  if (one) return { value: one.iso, used: [one.text] };
  if (/(?<![\p{L}])(вчера|yesterday|kecha)(?![\p{L}])/u.test(q))
    return { value: addDays(todayIso(today), -1), used: ["вчера", "yesterday", "kecha"] };
  const months = monthsIn(q);
  if (/(конец|конце|end|oxiri|oxirida)/u.test(q) && months.length === 1 && months[0]) {
    const years = [...q.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map((m) => Number(m[1]));
    if (new Set(years).size > 1) return { value: todayIso(today), used: [], ambiguous: true };
    const y = years[0] ?? today.getUTCFullYear();
    return {
      value: isoDate(y, months[0].month, lastDay(y, months[0].month)),
      used: [months[0].word, String(y), "конец", "конце", "end", "oxiri", "oxirida"],
    };
  }
  return { value: todayIso(today), used: [] };
}

/**
 * The period a question asks for: a day, a range "from … to …", a month, a quarter, a year, "last month / year /
 * quarter", "this month / year"; this month when it names none. Two periods at once, or a date that does not exist,
 * is ambiguous: the model reads it.
 */
function findPeriod(question: string, today: Date): Period {
  const q = normalize(question);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const monthRange = (y: number, m1: number, m2 = m1) => ({
    start: isoDate(y, m1, 1),
    end: isoDate(y, m2, lastDay(y, m2)),
  });

  const dates = datesIn(q);
  if (dates === null || dates.length > 2) return { ambiguous: true };
  if (dates.length === 1 && dates[0])
    return { start: dates[0].iso, end: dates[0].iso, used: [dates[0].text] };
  if (dates.length === 2 && dates[0] && dates[1]) {
    if (dates[0].iso > dates[1].iso) return { ambiguous: true };
    return {
      start: dates[0].iso,
      end: dates[1].iso,
      used: [dates[0].text, dates[1].text, "по", "до", "to", "from", "gacha", "dan", "с"],
    };
  }

  const years = [...new Set([...q.matchAll(/(?<![\d.])(20\d{2})(?![\d.])/g)].map((m) => Number(m[1])))];
  if (years.length > 1) return { ambiguous: true };
  const explicitYear = years[0];
  const yearUsed = explicitYear ? [String(explicitYear), ...YEAR_WORDS] : [];

  // A quarter: "3 квартал", "3-й квартал", "III квартал", "3-chorak", "Q3", "квартал 3".
  const quarters = new Set<number>();
  for (const m of q.matchAll(
    /(?<![\p{L}\d])(\d|iv|iii|ii|i)\s*[-–]?\s*(?:й|ый|ой|ий|chi|nchi)?\s*[-–]?\s*(?:квартал\p{L}*|kvartal\p{L}*|chorak\p{L}*|quarter)/gu,
  )) {
    const n = /^\d$/.test(m[1] ?? "") ? Number(m[1]) : ROMAN[m[1] ?? ""];
    if (n) quarters.add(n);
  }
  for (const m of q.matchAll(/(?<![\p{L}\d])q([1-4])(?!\d)/gu)) quarters.add(Number(m[1]));
  for (const m of q.matchAll(/(?:квартал\p{L}*|kvartal\p{L}*|chorak\p{L}*)\s*([1-4])(?!\d)/gu))
    quarters.add(Number(m[1]));
  const months = monthsIn(q);
  if (quarters.size > 1 || (quarters.size === 1 && months.length > 0) || months.length > 1)
    return { ambiguous: true };
  const [quarter] = [...quarters];
  const quarterUsed = [
    ...QUARTER_WORDS,
    "й",
    "ый",
    "ой",
    "ий",
    "chi",
    "nchi",
    "q1",
    "q2",
    "q3",
    "q4",
    "i",
    "ii",
    "iii",
    "iv",
  ];
  if (quarter && quarter >= 1 && quarter <= 4) {
    const y = explicitYear ?? year;
    return { ...monthRange(y, quarter * 3 - 2, quarter * 3), used: [...quarterUsed, ...yearUsed] };
  }

  const month1 = months[0];
  if (month1) return { ...monthRange(explicitYear ?? year, month1.month), used: [month1.word, ...yearUsed] };
  if (explicitYear) return { ...monthRange(explicitYear, 1, 12), used: yearUsed };

  // Relative: last / this month, quarter, year.
  const last = /(прошл\p{L}*|last|o'tgan|oʻtgan|previous)/u.test(q);
  const current = /(этот|эт\p{L}*|текущ\p{L}*|this|shu|joriy)/u.test(q);
  const has = (list: string[]) => list.some((w) => new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, "u").test(q));
  if (has(["месяц", "месяца", "oy", "month"])) {
    if (last) {
      const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1];
      return {
        ...monthRange(y, m),
        used: [
          "прошлый",
          "прошлого",
          "месяц",
          "месяца",
          "last",
          "previous",
          "o'tgan",
          "oʻtgan",
          "oy",
          "month",
        ],
      };
    }
    if (current)
      return {
        ...monthRange(year, month),
        used: [
          "этот",
          "этого",
          "текущий",
          "текущего",
          "месяц",
          "месяца",
          "this",
          "shu",
          "joriy",
          "oy",
          "month",
        ],
      };
  }
  if (has(["год", "года", "году", "yil", "year"])) {
    if (last)
      return {
        ...monthRange(year - 1, 1, 12),
        used: ["прошлый", "прошлого", "прошлом", "last", "previous", "o'tgan", "oʻtgan", ...YEAR_WORDS],
      };
    if (current)
      return {
        start: isoDate(year, 1, 1),
        end: todayIso(today),
        used: ["этот", "этого", "этом", "текущий", "текущего", "this", "shu", "joriy", ...YEAR_WORDS],
      };
  }
  if (has(["квартал", "квартала", "chorak", "quarter", "kvartal"]) && (last || current)) {
    const q0 = Math.floor((month - 1) / 3) + 1;
    const [y, qq] = last ? (q0 === 1 ? [year - 1, 4] : [year, q0 - 1]) : [year, q0];
    return {
      ...monthRange(y, qq * 3 - 2, qq * 3),
      used: [
        "прошлый",
        "прошлого",
        "этот",
        "этого",
        "текущий",
        "last",
        "previous",
        "this",
        "shu",
        "joriy",
        "o'tgan",
        "oʻtgan",
        ...QUARTER_WORDS,
      ],
    };
  }
  return { ...monthRange(year, month), used: [] };
}

/** The template the question asks for, with its parameters, or null (the model answers). */
export function matchTemplate(
  question: string,
  templates: QueryTemplateView[],
  today = new Date(),
): TemplateMatch | null {
  const asked = words(question);
  if (asked.length === 0 || asked.length > 14) return null;
  const actions = asked.filter((w) => ACTIONS.has(w));
  let best: { match: TemplateMatch; size: number } | null = null;

  for (const template of templates) {
    if (!template.enabled) continue;
    const params: Record<string, string | number> = {};
    const used = new Set<string>();
    let usable = true;
    let counterpartyParam: string | null = null;
    for (const param of template.params) {
      if (param.type === "counterparty") {
        counterpartyParam = param.name;
      } else if (param.type === "date") {
        const found = findDate(question, today);
        if (found.ambiguous) usable = false;
        params[param.name] = found.value;
        found.used.forEach((u) => used.add(u));
      } else if (param.type === "month_start" || param.type === "month_end") {
        const period = findPeriod(question, today);
        if (period.ambiguous) usable = false;
        else {
          params[param.name] = param.type === "month_start" ? period.start : period.end;
          period.used.forEach((x) => used.add(x));
        }
      } else if (param.type === "number") {
        const number = /(?<![\d.])-?\d+(?:[.,]\d+)?(?![\d.])/.exec(normalize(question));
        if (!number) usable = false;
        else {
          params[param.name] = Number(number[0].replace(",", "."));
          used.add(number[0]);
        }
      } else {
        const quoted = /["«“]([^"»”]{1,100})["»”]/.exec(question)?.[1];
        if (!quoted) usable = false;
        else {
          params[param.name] = quoted.trim();
          for (const w of words(quoted)) used.add(w);
        }
      }
    }
    if (!usable) continue;

    const rest = asked.filter((w) => ![...used].some((u) => u.includes(w)) && !/^\d+$/.test(w));
    for (const phrase of template.intents) {
      const phraseStems = words(phrase)
        .filter((w) => !FILLER.has(w))
        .map(stem);
      // One word is too little to tell questions apart, except in a phrase an admin wrote on purpose
      // ("выручка", "debitorka"): the question must still say that word and nothing else of meaning.
      if (phraseStems.length < 2 && !(template.source === "admin" && phraseStems.length === 1)) continue;
      // An action the phrase itself does not name ("… and delete them") is not a question to read an answer to.
      if (actions.some((a) => !words(phrase).includes(a))) continue;
      const restStems = rest.filter((w) => !FILLER.has(w)).map(stem);
      if (!phraseStems.every((s) => restStems.includes(s))) continue;
      let counterparty: TemplateMatch["counterparty"];
      if (counterpartyParam) {
        // What is left of the question is a counterparty's name (a legal form next to it is not part of it).
        const left = rest
          .filter((w) => !FILLER.has(w) && !phraseStems.includes(stem(w)))
          .filter((w) => !LEGAL_FORMS.has(w));
        if (left.length === 0 || left.length > MAX_NAME_WORDS) continue;
        counterparty = { param: counterpartyParam, words: left };
      } else if (restStems.some((s) => !phraseStems.includes(s))) {
        // Any further word may be a condition that makes it another question.
        continue;
      }
      if (!best || phraseStems.length > best.size) {
        best = {
          match: { template, params, ...(counterparty ? { counterparty } : {}) },
          size: phraseStems.length,
        };
      }
    }
  }
  return best?.match ?? null;
}

// --- the answer ---------------------------------------------------------------------------------

const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

function format(value: unknown, column: TemplateColumn): string {
  if (value === null || value === undefined || value === "") return "";
  if (column.format === "money" || column.format === "number") {
    return typeof value === "number" ? money.format(value) : String(value);
  }
  if (column.format === "date" && typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
  }
  return String(value);
}

const escapeCell = (text: string) => text.replaceAll("|", "\\|").replace(/\s*\n\s*/g, " ");

/** The query's result as the chat shows it: a title, a table, an optional totals row. */
export function renderTemplate(template: QueryTemplateView, result: QueryResult, subject?: string): string {
  const columns = template.columns;
  const lines = [
    `**${template.title}${subject ? ` — ${subject}` : ""}**`,
    "",
    `| ${columns.map((c) => escapeCell(c.label)).join(" | ")} |`,
    `| ${columns.map((c) => (c.format === "money" || c.format === "number" ? "---:" : "---")).join(" | ")} |`,
    ...result.rows.map((row) => `| ${columns.map((c, i) => escapeCell(format(row[i], c))).join(" | ")} |`),
  ];
  if (result.rows.length === 0) lines.push(`| ${columns.map(() => "").join(" | ")} |`);
  if (template.totals && result.rows.length > 0) {
    const totals = columns.map((c, i) => {
      if (c.format !== "money" && c.format !== "number") return i === 0 ? "**Σ**" : "";
      const sum = result.rows.reduce(
        (s, row) => s + (typeof row[i] === "number" ? (row[i] as number) : 0),
        0,
      );
      return `**${money.format(Math.round(sum * 100) / 100)}**`;
    });
    lines.push(`| ${totals.join(" | ")} |`);
  }
  if (result.truncated) lines.push("", `_${result.rows.length}+ rows_`);
  return lines.join("\n");
}

// --- learning -------------------------------------------------------------------------------------

/** What a template learned from one answered question is made of. */
export interface Learned {
  phrase: string;
  query: string;
  params: TemplateParam[];
  columns: TemplateColumn[];
}

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_CELL = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;

function columnFormat(values: unknown[]): TemplateColumn["format"] {
  const filled = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (filled.length === 0) return "text";
  if (filled.every((v) => typeof v === "number")) return "number";
  if (filled.every((v) => typeof v === "string" && DATE_CELL.test(v))) return "date";
  return "text";
}

/** The text literals of a 1C query ("" inside one is a quote), whole, with their quotes. */
function queryLiterals(query: string): { literal: string; text: string }[] {
  const found: { literal: string; text: string }[] = [];
  for (const m of query.matchAll(/"((?:[^"]|"")*)"/g)) {
    const text = (m[1] ?? "").replaceAll('""', '"').replace(/%/g, "").trim();
    if (text.length >= 3) found.push({ literal: m[0], text });
  }
  return found;
}

const PARAM_NAME = /^[A-Za-zА-Яа-я_][A-Za-zА-Яа-я0-9_]*$/;

/**
 * Whether the model's answer to this question can become a template, and as what. Only a short
 * question without numbers or quoted values, answered by one query whose parameters are the date
 * or the month the question named (or today), or the name of a counterparty the question wrote, with
 * a whole result. Anything else is left to the model every time: a template must not depend on
 * something the question did not say.
 *
 * A counterparty's name in the question, found in a text the query holds (a parameter's value or a
 * literal in it), becomes a parameter of the query: the same question about another counterparty then
 * gives the same template, and the same query, so the questions about different counterparties are
 * one group for the engine to learn from.
 */
export function learnFromRun(
  question: string,
  input: { query: string; params?: Record<string, string | number | boolean | null> | undefined },
  result: QueryResult,
  today = new Date(),
): Learned | null {
  if (/[\d"«»“”]/.test(question) || result.truncated || result.rows.length === 0) return null;
  // A period written into the query itself cannot follow the question's period.
  if (/ДАТАВРЕМЯ|DATETIME|НАЧАЛОПЕРИОДА\s*\(\s*"/iu.test(input.query)) return null;

  const params: TemplateParam[] = [];
  const consumed = new Set<string>();
  /** Text parameters of the query: a counterparty's name, if the question has it. */
  const textParams: { name: string; value: string }[] = [];
  const aboutCounterparties = /Контрагент/iu.test(input.query);
  for (const [name, value] of Object.entries(input.params ?? {})) {
    if (typeof value === "string" && !DATE_VALUE.test(value) && aboutCounterparties) {
      if (!PARAM_NAME.test(name)) return null;
      textParams.push({ name, value: value.replace(/%/g, "").trim() });
      continue;
    }
    if (typeof value !== "string" || !DATE_VALUE.test(value)) return null;
    const types: TemplateParam["type"][] = [];
    if (findDate(question, today).value === value) types.push("date");
    const month = findPeriod(question, today);
    if (!month.ambiguous && value === month.start) types.push("month_start");
    if (!month.ambiguous && value === month.end) types.push("month_end");
    const type = types.length === 1 ? types[0] : undefined;
    if (!type || !PARAM_NAME.test(name)) return null;
    params.push({ name, type });
    if (type !== "date" && !month.ambiguous) month.used.forEach((u) => consumed.add(u));
  }

  const meaningful = words(question).filter(
    (w) => !FILLER.has(w) && ![...consumed].some((u) => u.includes(w) || w.includes(u)),
  );

  let phraseWords = meaningful;
  let query = input.query;
  if (aboutCounterparties) {
    // Which text in the query is the name the question wrote? The one that shares a word with it.
    const candidates = [
      ...textParams.map((p) => ({ text: p.value, param: p.name, literal: null as string | null })),
      ...queryLiterals(input.query).map((l) => ({
        text: l.text,
        param: null as string | null,
        literal: l.literal,
      })),
    ];
    let bound = false;
    for (const candidate of candidates) {
      const textWords = words(candidate.text);
      const named = meaningful.filter((w) => textWords.some((u) => sameWord(w, u)));
      if (named.length === 0) continue;
      const nameWords = meaningful.filter((w) => named.includes(w) || LEGAL_FORMS.has(w));
      const rest = meaningful.filter((w) => !nameWords.includes(w));
      if (rest.length < 2) continue;
      let paramName = candidate.param;
      if (!paramName) {
        paramName = "Контрагент";
        const taken = new Set([...params, ...textParams].map((p) => p.name));
        for (let n = 2; taken.has(paramName); n++) paramName = `Контрагент${n}`;
        query = query.split(candidate.literal ?? "").join(`&${paramName}`);
      }
      params.push({ name: paramName, type: "counterparty" });
      phraseWords = rest;
      bound = true;
      break;
    }
    // A text parameter that is not the question's counterparty is something it did not say.
    if (textParams.length > 0 && !bound) return null;
    if (textParams.length > 1) return null;
  }
  if (phraseWords.length < 2 || phraseWords.length > 10) return null;

  const columns = result.columns.map((label, i) => ({
    label: label || `#${i + 1}`,
    format: columnFormat(result.rows.map((row) => row[i])),
  }));
  if (columns.length === 0 || columns.length > 30) return null;
  return { phrase: phraseWords.join(" "), query, params, columns };
}
