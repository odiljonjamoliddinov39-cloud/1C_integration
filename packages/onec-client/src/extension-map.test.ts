import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The extension's BSL cannot run outside 1C, and indexing a Структура by a key it does not have is a runtime
 * error that rolls the whole import back. So every name the received-invoice code reads from a map has to be a
 * key that map defines: checked here from the sources. (\w does not match Cyrillic: \p{L} does.)
 */
const bsl = (file: string) =>
  readFileSync(join(import.meta.dirname, "../../../onec/extension/src/CommonModules", file), "utf8");

/** Each function with the map function(s) its `Имена` comes from: a name must be in every one of them. */
const FUNCTIONS: [string, string[]][] = [
  ["СоздатьСчетФактуруПолученный", ["ПоступлениеТоваровУслуг"]],
  ["НайтиПовторПолученного", ["ПоступлениеТоваровУслуг"]],
  ["ПроверитьКолонкиСтрок", ["ПоступлениеТоваровУслуг"]],
  ["СчетаСтроки", ["ПоступлениеТоваровУслуг"]],
  ["УстановитьВидОперации", ["ПоступлениеТоваровУслуг"]],
  ["УстановитьЕдиницуСтроки", ["ПоступлениеТоваровУслуг"]],
  ["СоздатьСчетФактуруПоПоступлению", ["СчетФактураПолученный"]],
  ["ШапкаПоПоследнему", ["ПоступлениеТоваровУслуг", "СчетФактураПолученный"]],
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
  const main = bsl("PlatformAPI.bsl");
  const keysOf = (mapFunction: string) => {
    const start = map.indexOf(`Функция ${mapFunction}()`);
    expect(start, `${mapFunction} exists`).toBeGreaterThanOrEqual(0);
    return new Set(
      [
        ...map
          .slice(start, map.indexOf("КонецФункции", start))
          .matchAll(/Имена\.Вставить\("([\p{L}\d_]+)"/gu),
      ].map((m) => m[1]!),
    );
  };

  it("defines every name the code reads with Имена.Name", () => {
    for (const [name, maps] of FUNCTIONS) {
      const used = new Set([...body(main, name).matchAll(/Имена\.([\p{L}\d_]+)/gu)].map((m) => m[1]!));
      for (const mapFunction of maps) {
        const keys = keysOf(mapFunction);
        // Not vacuous: \w once made both sets empty.
        expect(keys.size, `${mapFunction} keys`).toBeGreaterThan(5);
        expect(
          [...used].filter((key) => !keys.has(key)),
          `${name} reads from ${mapFunction}`,
        ).toEqual([]);
      }
    }
    expect(body(main, "СоздатьСчетФактуруПоПоступлению").match(/Имена\./g)?.length ?? 0).toBeGreaterThan(10);
  });

  it("defines every name the code reads by indexing: Имена[Колонка] in the column loops", () => {
    const keys = keysOf("ПоступлениеТоваровУслуг");
    const used = new Set<string>();
    for (const m of main.matchAll(/Для Каждого (?:ИменаКолонки|ИмяКолонки) Из СтрРазделить\("([^"]+)"/g)) {
      for (const key of m[1]!.split(",")) used.add(key);
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((key) => !keys.has(key))).toEqual([]);
  });
});
