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
}

function findDate(question: string, today: Date): Found {
  const q = normalize(question);
  const dmy = /(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})/.exec(q);
  if (dmy) {
    const [whole = "", day = "", month = "", shortOrFull = ""] = dmy;
    const year = Number(shortOrFull.length === 2 ? `20${shortOrFull}` : shortOrFull);
    return { value: isoDate(year, Number(month), Number(day)), used: [whole] };
  }
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(q);
  if (iso) return { value: iso[0], used: [iso[0]] };
  return { value: isoDate(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()), used: [] };
}

/** The month named in the question (with its year), else this month; "last month" is the one before. */
function findMonth(question: string, today: Date): { year: number; month: number; used: string[] } {
  const q = normalize(question);
  let year = today.getUTCFullYear();
  let month = today.getUTCMonth() + 1;
  const used: string[] = [];
  if (/(прошл\p{L}* месяц|last month|o'tgan oy)/u.test(q)) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    return { year, month, used: ["прошлый", "месяц", "last", "o'tgan", "oy"] };
  }
  for (const word of words(q)) {
    const found = Object.entries(MONTHS).find(([name]) => word.startsWith(name));
    if (found) {
      month = found[1];
      used.push(word);
      break;
    }
  }
  const explicitYear = /\b(20\d{2})\b/.exec(q)?.[1];
  if (explicitYear) {
    year = Number(explicitYear);
    used.push(explicitYear);
  }
  return { year, month, used };
}

/** The template the question asks for, with its parameters, or null (the model answers). */
export function matchTemplate(
  question: string,
  templates: QueryTemplateView[],
  today = new Date(),
): TemplateMatch | null {
  const asked = words(question);
  if (asked.length === 0 || asked.length > 14) return null;
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
        params[param.name] = found.value;
        found.used.forEach((u) => used.add(u));
      } else if (param.type === "month_start" || param.type === "month_end") {
        const { year, month, used: u } = findMonth(question, today);
        params[param.name] =
          param.type === "month_start" ? isoDate(year, month, 1) : isoDate(year, month, lastDay(year, month));
        u.forEach((x) => used.add(x));
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
    const month = findMonth(question, today);
    if (value === isoDate(month.year, month.month, 1)) types.push("month_start");
    if (value === isoDate(month.year, month.month, lastDay(month.year, month.month))) types.push("month_end");
    const type = types.length === 1 ? types[0] : undefined;
    if (!type || !PARAM_NAME.test(name)) return null;
    params.push({ name, type });
    if (type !== "date") month.used.forEach((u) => consumed.add(u));
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
