/**
 * Simulation: thousands of generated questions against the seeded templates. A question that says what a template's
 * phrase says (in any order, with endings, filler words, a month or a date) must find that template with its
 * parameters; one with an extra condition, two questions in one, or noise must go to the model (null).
 */
import { describe, expect, it } from "vitest";

import { type QueryTemplateView, seedTemplateInputs } from "@platform/shared";

import { matchTemplate } from "../ai/templates.js";
import { cases, Rng, seed } from "./rng.js";

const views: QueryTemplateView[] = seedTemplateInputs().map((t, i) => ({
  ...t,
  id: String(i),
  version: 1,
  updatedAt: "",
  source: "admin",
  company: null,
  accountName: null,
  hits: 0,
  rejected: 0,
}));
const today = new Date("2026-10-21T10:00:00Z");

const FILL = [
  "пожалуйста",
  "мне",
  "покажи",
  "сколько",
  "нас",
  "bugun",
  "hozir",
  "please",
  "show",
  "me",
  "now",
  "our",
];
// Filler words stay as they are: "сколькоni" is not a word anybody writes.
const FILL_STEMS = new Set(["сколько", "пожалуйста"]);
const SUFFIX = ["", "", "а", "у", "ом", "ы", "da", "ni", "ning", "s"];
const MONTH_FORMS: [string, number][] = [
  ["января", 1],
  ["февраль", 2],
  ["марта", 3],
  ["апреле", 4],
  ["мая", 5],
  ["июнь", 6],
  ["июля", 7],
  ["августа", 8],
  ["сентябрь", 9],
  ["октября", 10],
  ["ноябрь", 11],
  ["декабре", 12],
  ["yanvar", 1],
  ["mart", 3],
  ["avgust", 8],
  ["oktyabr", 10],
  ["november", 11],
];
const EXTRA = [
  "по менеджерам",
  "разбивкой",
  "почему",
  "выросла",
  "договорам",
  "сравни",
  "отправь",
  "удали",
  "проведи",
  "по филиалам",
  "кроме",
  "только",
];
const NOISE = [
  "ёлка",
  "банан",
  "зебра",
  "lorem",
  "ipsum",
  "qwerty",
  "привет",
  "салом",
  "xyz",
  "случайно",
  "тест",
  "mashina",
];

const stems = (phrase: string) => phrase.split(" ").map((w) => (w.length > 4 ? w.slice(0, 4) : w));
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The words of a phrase worded like a person would: endings, case, filler, a "?" at the end. */
function wording(rng: Rng, phrase: string): string {
  const parts = rng
    .shuffle(phrase.split(" "))
    .map((w) => (w.length > 4 && !FILL_STEMS.has(w) ? w + rng.pick(SUFFIX) : w));
  if (rng.chance(0.5)) parts.splice(rng.int(0, parts.length), 0, rng.pick(FILL));
  let text = parts.join(" ");
  const casing = rng.int(0, 9);
  if (casing < 3) text = text.toUpperCase();
  else if (casing < 6) text = text[0]?.toUpperCase() + text.slice(1);
  return text + (rng.chance(0.3) ? "?" : "");
}

const simple = views.filter((t) => !t.params.some((p) => p.type === "counterparty" || p.type === "text"));
const withText = views.filter((t) => t.params.some((p) => p.type === "text"));

describe("simulation: questions the templates recognise", () => {
  it("finds the template and the period for thousands of worded questions", () => {
    const rng = new Rng(seed(1));
    const wrong: string[] = [];
    const n = cases(6000);
    for (let i = 0; i < n; i++) {
      const template = rng.pick(simple);
      const phrase = rng.pick(template.intents);
      let question = wording(rng, phrase);
      let month: [number, number] | null = null; // [year, month]
      let day: string | null = null;
      const hasMonth = template.params.some((p) => p.type === "month_start");
      const hasDate = template.params.some((p) => p.type === "date");
      if (hasMonth && rng.chance(0.6)) {
        const [name, m] = rng.pick(MONTH_FORMS);
        const year = rng.pick([2024, 2025, 2026]);
        question += ` ${rng.chance(0.5) ? "за " : ""}${name} ${year}`;
        month = [year, m];
      } else if (hasDate && rng.chance(0.6)) {
        const y = rng.int(2024, 2026);
        const m = rng.int(1, 12);
        const d = rng.int(1, 28);
        question += ` на ${pad(d)}.${pad(m)}.${y}`;
        day = `${y}-${pad(m)}-${pad(d)}`;
      }
      const match = matchTemplate(question, views, today);
      if (!match) {
        wrong.push(`NULL  ${template.code} ← ${question}`);
        continue;
      }
      // An equal-or-longer phrase of another template may legitimately win (same wording, richer template).
      const ok =
        match.template.code === template.code ||
        match.template.intents.some(
          (p) => stems(p).length >= stems(phrase).length && stems(p).every((s) => stems(phrase).includes(s)),
        );
      if (!ok) wrong.push(`OTHER ${template.code} → ${match.template.code} ← ${question}`);
      if (month && match.template.code === template.code) {
        const [y, m] = month;
        const start = match.params["Начало"];
        const end = match.params["Конец"];
        if (start !== `${y}-${pad(m)}-01` || end !== `${y}-${pad(m)}-${pad(lastDay(y, m))}`)
          wrong.push(`PERIOD ${question} → ${String(start)}..${String(end)}`);
      }
      if (day && match.template.code === template.code && match.params["Дата"] !== day)
        wrong.push(`DATE ${question} → ${String(match.params["Дата"])}`);
    }
    expect(wrong.slice(0, 20), `${wrong.length} of ${n}`).toEqual([]);
  });

  it("takes a quoted account from the question", () => {
    const rng = new Rng(seed(2));
    const wrong: string[] = [];
    for (let i = 0; i < cases(500); i++) {
      const template = rng.pick(withText);
      const code = rng.pick(["50", "51", "60.01", "62.01", "6010", "9010", "20.1"]);
      const phrase = rng.pick(template.intents);
      const question = `${wording(rng, phrase).replace(/\?$/, "")} «${code}»`;
      const match = matchTemplate(question, views, today);
      if (match?.template.code !== template.code)
        wrong.push(`${template.code} ← ${question} → ${match?.template.code}`);
      else if (!Object.values(match.params).includes(code)) wrong.push(`PARAM ${question}`);
    }
    expect(wrong.slice(0, 20), `${wrong.length}`).toEqual([]);
  });

  it("hands over to the model: an extra condition, two questions in one, noise", () => {
    const rng = new Rng(seed(3));
    const wrong: string[] = [];
    const n = cases(6000);
    for (let i = 0; i < n; i++) {
      const kind = rng.int(0, 2);
      let question: string;
      if (kind === 0) {
        const template = rng.pick(simple);
        question = `${wording(rng, rng.pick(template.intents)).replace(/\?$/, "")} ${rng.pick(EXTRA)}`;
      } else if (kind === 1) {
        const [a, b] = [rng.pick(simple), rng.pick(simple)];
        if (a === b) continue;
        const [pa, pb] = [rng.pick(a.intents), rng.pick(b.intents)];
        const [sa, sb] = [stems(pa), stems(pb)];
        // One phrase inside the other is the same question asked in more words, not two questions.
        if (sa.every((s) => sb.includes(s)) || sb.every((s) => sa.includes(s))) continue;
        question = `${wording(rng, pa).replace(/\?$/, "")} и ${wording(rng, pb)}`;
        // Two phrases that together are a third template's phrase would be that template's question.
        const merged = new Set([...sa, ...sb]);
        if (views.some((t) => t.intents.some((p) => stems(p).every((s) => merged.has(s))))) continue;
      } else {
        question = rng.shuffle(NOISE).slice(0, rng.int(1, 5)).join(" ");
      }
      const match = matchTemplate(question, views, today);
      if (match) wrong.push(`${match.template.code} ← ${question}`);
    }
    expect(wrong.slice(0, 20), `${wrong.length} of ${n}`).toEqual([]);
  });

  it("never throws and never takes a long question for a template", () => {
    const rng = new Rng(seed(4));
    for (let i = 0; i < cases(3000); i++) {
      const junk = Array.from({ length: rng.int(0, 40) }, () =>
        rng.pick([
          ...NOISE,
          ...FILL,
          ...EXTRA,
          "«",
          "»",
          "123",
          "-5,5",
          "01.13.2026",
          "99.99.9999",
          "'",
          '"',
          "\\",
          "%",
          "(",
          "ё",
        ]),
      ).join(" ");
      expect(() => matchTemplate(junk, views, today)).not.toThrow();
      if (junk.split(/\s+/).length > 14) expect(matchTemplate(junk, views, today)).toBeNull();
    }
  });
});
