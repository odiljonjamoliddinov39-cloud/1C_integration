/**
 * Attack: questions to the knowledge base written the way people really write them — a letter wrong, missing or
 * doubled, a different case, extra chatter around — must still find the entry; a question about nothing known must
 * find nothing rather than something confident.
 */
import { KNOWLEDGE, searchKnowledge } from "@platform/shared";
import { describe, expect, it } from "vitest";

import { cases, Rng, seed } from "./rng.js";

const CHATTER = [
  "подскажи пожалуйста",
  "как у нас",
  "мне нужно знать про",
  "scusi",
  "iltimos tushuntiring",
  "explain to me",
  "what is the rule for",
  "?!",
  "bro",
];

/** One typo in a word of five letters or more: a letter lost, doubled, swapped with its neighbour, or replaced. */
function typo(rng: Rng, word: string): string {
  if (word.length < 5) return word;
  const i = rng.int(1, word.length - 2);
  switch (rng.int(0, 3)) {
    case 0:
      return word.slice(0, i) + word.slice(i + 1);
    case 1:
      return word.slice(0, i) + word[i] + word.slice(i);
    case 2:
      return word.slice(0, i) + (word[i + 1] ?? "") + (word[i] ?? "") + word.slice(i + 2);
    default:
      return word.slice(0, i) + (word[i] === "a" ? "o" : "a") + word.slice(i + 1);
  }
}

describe("attack: the knowledge base", () => {
  it("finds an entry through one typo per word and chatter around the question", () => {
    const rng = new Rng(seed(230));
    const lost: string[] = [];
    const n = cases(4000);
    for (let i = 0; i < n; i++) {
      const entry = rng.pick(KNOWLEDGE);
      const topic = rng.pick(entry.topics);
      const wordsOf = topic.split(/\s+/);
      const worded = wordsOf.map((w) => (rng.chance(0.5) ? typo(rng, w) : w)).join(" ");
      const question = `${rng.pick(CHATTER)} ${rng.chance(0.5) ? worded.toUpperCase() : worded}`;
      if (!searchKnowledge(question, 3).some((f) => f.id === entry.id))
        lost.push(`${entry.id} ← "${question}"`);
    }
    // A typo in the first letters of a one-word topic can lose it; the rest must be found.
    expect(lost.length / n, lost.slice(0, 8).join("\n")).toBeLessThan(0.04);
  });

  it("finds nothing for words that mean nothing here", () => {
    const rng = new Rng(seed(231));
    const nonsense = [
      "зебра",
      "банан",
      "football",
      "weather",
      "ob-havo",
      "кошка",
      "pizza",
      "marathon",
      "музыка",
      "ёлка",
      "bitcoin",
      "рецепт борща",
    ];
    for (let i = 0; i < cases(2000); i++) {
      const q = Array.from({ length: rng.int(1, 4) }, () => rng.pick(nonsense)).join(" ");
      expect(searchKnowledge(q, 3), q).toEqual([]);
    }
  });
});
