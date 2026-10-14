import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The extension's BSL cannot run outside 1C, and indexing a Структура by a key it does not have is a runtime
 * error that rolls the whole import back. So every name the received-invoice code reads from the map has to
 * be a key the map defines: checked here from the sources.
 */
const bsl = (file: string) =>
  readFileSync(join(import.meta.dirname, "../../../onec/extension/src/CommonModules", file), "utf8");

const FUNCTIONS = [
  "СоздатьСчетФактуруПолученный",
  "НайтиПовторПолученного",
  "ПроверитьКолонкиСтрок",
  "ШапкаПоПоследнему",
  "СчетаСтроки",
  "УстановитьВидОперации",
  "УстановитьЕдиницуСтроки",
];

function body(source: string, name: string): string {
  const start = source.search(new RegExp(`(Функция|Процедура) ${name}\\(`));
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const ends = [source.indexOf("КонецФункции", start), source.indexOf("КонецПроцедуры", start)].filter(
    (i) => i > 0,
  );
  return source.slice(start, Math.min(...ends));
}

describe("PlatformAPI_Map for the received invoice", () => {
  const map = bsl("PlatformAPI_Map.bsl");
  const mapStart = map.indexOf("Функция ПоступлениеТоваровУслуг()");
  const keys = new Set(
    [
      ...map
        .slice(mapStart, map.indexOf("КонецФункции", mapStart))
        .matchAll(/Имена\.Вставить\("([\p{L}\d_]+)"/gu),
    ].map((m) => m[1]),
  );
  const main = bsl("PlatformAPI.bsl");

  it("defines every name the code reads with Имена.Name", () => {
    const used = new Set<string>();
    for (const name of FUNCTIONS)
      for (const m of body(main, name).matchAll(/Имена\.([\p{L}\d_]+)/gu)) used.add(m[1]!);
    // Not vacuous: \w does not match Cyrillic, which once made both sets empty.
    expect(keys.size).toBeGreaterThan(10);
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((key) => !keys.has(key))).toEqual([]);
  });

  it("defines every name the code reads by indexing: Имена[Колонка] in the column loops", () => {
    const used = new Set<string>();
    for (const m of main.matchAll(/Для Каждого (?:ИменаКолонки|ИмяКолонки) Из СтрРазделить\("([^"]+)"/g)) {
      for (const key of m[1]!.split(",")) used.add(key);
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((key) => !keys.has(key))).toEqual([]);
  });
});
