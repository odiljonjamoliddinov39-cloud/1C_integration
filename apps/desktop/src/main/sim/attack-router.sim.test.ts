/**
 * Attack: short messages. A bare command to post (in any of its spellings, with any filler beside it) is settled by the
 * program; the moment the message names an object, a period, a counterparty or a number it is the model's — the program
 * must never take a real request for the bare command, and never ask the model to search for the object of a bare one.
 */
import { describe, expect, it } from "vitest";

import { readChoice, readPostCommand, type PostOption } from "../router.js";
import { cases, Rng, seed } from "./rng.js";

const VERBS = [
  "проведи",
  "проведите",
  "проведены",
  "проведен",
  "провести",
  "проводи",
  "proveden",
  "provodka",
  "o'tkaz",
  "oʻtkazing",
  "otkaz",
  "post",
  "posted",
  "posting",
];
const FILLERS = [
  "их",
  "все",
  "всё",
  "эти",
  "пожалуйста",
  "давай",
  "теперь",
  "сейчас",
  "now",
  "them",
  "please",
  "all",
  "ularni",
  "hammasini",
  "iltimos",
  "endi",
  "qiling",
  "ha",
  "ok",
];
const OBJECTS = [
  "документы",
  "реализации",
  "поступления",
  "сентябрь",
  "за",
  "октябрь",
  "Navroz",
  "123",
  "счёт-фактуры",
  "sotuvlarni",
  "hujjatlarni",
  "invoices",
  "sales",
  "payments",
  "банк",
  "кассу",
  "документ",
  "yesterday",
  "вчера",
  "2025",
];

describe("attack: bare commands", () => {
  it("a verb with fillers is the bare command, in any order and case", () => {
    const rng = new Rng(seed(300));
    for (let i = 0; i < cases(4000); i++) {
      const words = rng.shuffle([
        rng.pick(VERBS),
        ...Array.from({ length: rng.int(0, 4) }, () => rng.pick(FILLERS)),
      ]);
      let text = words.join(" ");
      if (rng.chance(0.3)) text = text.toUpperCase();
      if (rng.chance(0.3)) text += rng.pick(["?", "!", ".", "!!"]);
      expect(readPostCommand(text), text).toBe(true);
    }
  });

  it("a word that names an object, a period or a person makes it the model's", () => {
    const rng = new Rng(seed(301));
    for (let i = 0; i < cases(4000); i++) {
      const words = rng.shuffle([
        rng.pick(VERBS),
        rng.pick(OBJECTS),
        ...Array.from({ length: rng.int(0, 2) }, () => rng.pick(FILLERS)),
      ]);
      // "за" is a plain word, not a filler: a command carrying it is not a bare one.
      expect(readPostCommand(words.join(" ")), words.join(" ")).toBe(false);
    }
  });

  it("never takes other tasks for it", () => {
    for (const text of [
      "проверь",
      "проверь все",
      "покажи все",
      "выручка за сентябрь",
      "kassada qoldiq",
      "cash balance",
      "all",
      "ok",
      "ha",
      "да",
      "2",
      "",
      "?",
    ])
      expect(readPostCommand(text), text).toBe(false);
  });

  it("an answer to the options is a number inside them, 'all', or a word of a kind; nothing else", () => {
    const options: PostOption[] = [
      { label: "*", from: "a", to: "b", objects: ["x", "y"], count: 9 },
      { label: "Реализация товаров и услуг", from: "a", to: "b", objects: ["x"], count: 5 },
      { label: "Поступление на расчётный счёт", from: "a", to: "b", objects: ["y"], count: 4 },
    ];
    const rng = new Rng(seed(302));
    for (let i = 0; i < cases(2000); i++) {
      const n = rng.int(1, 3);
      expect(readChoice(String(n), options)).toBe(n);
      expect(readChoice(`${n}`.padStart(2, "0"), options)).toBe(n);
      expect(readChoice(String(rng.int(5, 99)), options)).toBeNull();
      expect(readChoice(rng.pick(["все", "да", "hammasi", "all", "ok", "yes"]), options)).toBe(1);
    }
    expect(readChoice("реализации", options)).toBe(2);
    expect(readChoice("поступление на счёт", options)).toBe(3);
    expect(readChoice("а что с курсом доллара", options)).toBeNull();
  });
});
