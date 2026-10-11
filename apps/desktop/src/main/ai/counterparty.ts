/**
 * Finding the counterparty a question names, in the company's own 1C: the words of the question are
 * only a part of a name ("Texmash" for "TEXMASH IMPORT ООО") and often have an ending ("Texmashga").
 * A template runs only when exactly one counterparty fits; with none or several the model answers
 * (and asks which one), so a name is never guessed.
 */
import type { QueryResult } from "@platform/shared";

/** Runs a read-only 1C query with parameters; null when it failed. */
export type RunQuery = (query: string, params: Record<string, string>) => Promise<QueryResult | null>;

const FIND = `ВЫБРАТЬ ПЕРВЫЕ 6
	К.Наименование КАК Имя
ИЗ
	Справочник.Контрагенты КАК К
ГДЕ
	НЕ К.ПометкаУдаления
	И К.Наименование ПОДОБНО &Строка`;

/** The name as written, then with the last word's ending cut by one to three letters. */
export function nameVariants(words: string[]): string[] {
  const clean = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  if (clean.length === 0) return [];
  const variants = [clean.join(" ")];
  const last = clean[clean.length - 1] ?? "";
  for (const cut of [1, 2, 3]) {
    if (last.length - cut >= 4) variants.push([...clean.slice(0, -1), last.slice(0, -cut)].join(" "));
  }
  return variants;
}

export async function resolveCounterparty(run: RunQuery, words: string[]): Promise<string | null> {
  for (const variant of nameVariants(words)) {
    const result = await run(FIND, { Строка: `%${variant}%` });
    if (!result) return null;
    const names = [...new Set(result.rows.map((row) => String(row[0] ?? "")).filter(Boolean))];
    if (names.length === 1) return names[0] ?? null;
    if (names.length > 1) {
      const exact = names.filter((n) => n.toLowerCase() === variant.toLowerCase());
      return exact.length === 1 ? (exact[0] ?? null) : null; // several fit: the model asks which
    }
  }
  return null;
}
