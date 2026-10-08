/**
 * Query templates on this PC: a known question is recognized by rules (its words), its parameters
 * are read from the question, and a fixed 1C query answers it, with no model and no cost.
 *
 * The matcher is strict on purpose. A question matches only when every word of one of the
 * template's phrases is in it and nothing else is (but filler words and its parameters), so a longer or different question (an
 * extra condition, another period, another counterparty) goes to the model. A wrong template
 * answer is worse than a paid one; every answer also has an "Ask AI anyway" button.
 */
import type { QueryResult, QueryTemplateView, TemplateColumn } from "@platform/shared";

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
]);

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
  /** Values of the &parameters, ready for RunQuery. */
  params: Record<string, string | number>;
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
    for (const param of template.params) {
      if (param.type === "date") {
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
      // One word is too little to tell questions apart.
      if (phraseStems.length < 2) continue;
      const restStems = rest.filter((w) => !FILLER.has(w)).map(stem);
      if (!phraseStems.every((s) => restStems.includes(s))) continue;
      // Any further word may be a condition that makes it another question.
      if (restStems.some((s) => !phraseStems.includes(s))) continue;
      if (!best || phraseStems.length > best.size) {
        best = { match: { template, params }, size: phraseStems.length };
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
export function renderTemplate(template: QueryTemplateView, result: QueryResult): string {
  const columns = template.columns;
  const lines = [
    `**${template.title}**`,
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
