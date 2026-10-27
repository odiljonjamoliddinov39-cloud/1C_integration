import { describe, expect, it } from "vitest";

import { DICTIONARIES, LANGS, errorText, pickLanguage, translator } from "./i18n.js";

const keys = (node: unknown, prefix = ""): string[] =>
  Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === "string" ? [prefix + k] : keys(v, `${prefix}${k}.`),
  );

describe("Mini App words", () => {
  it("has the same keys in every language", () => {
    const base = keys(DICTIONARIES.en).sort();
    for (const lang of LANGS) expect(keys(DICTIONARIES[lang]).sort()).toEqual(base);
  });

  it("keeps the placeholders of every sentence in every language", () => {
    const placeholders = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort().join(",");
    for (const key of keys(DICTIONARIES.en)) {
      const english = key
        .split(".")
        .reduce<unknown>((n, p) => (n as Record<string, unknown>)[p], DICTIONARIES.en) as string;
      for (const lang of LANGS) {
        const text = key
          .split(".")
          .reduce<unknown>((n, p) => (n as Record<string, unknown>)[p], DICTIONARIES[lang]) as string;
        expect(placeholders(text), `${lang} ${key}`).toBe(placeholders(english));
      }
    }
  });

  it("fills placeholders and falls back to the key", () => {
    const t = translator("en");
    expect(t("waiting.result", { created: 3, skipped: 1, refused: 0 })).toBe(
      "Created 3, skipped 1, refused 0",
    );
    expect(translator("uz")("tabs.chat")).toBe("Chat");
  });

  it("explains known error codes in the user's language and passes unknown messages on", () => {
    expect(errorText("ru", "PIN_WRONG")).toBe("PIN неверный.");
    expect(errorText("en", "SOMETHING", "The server said so")).toBe("The server said so");
    expect(errorText("uz", undefined)).toBe(DICTIONARIES.uz.errors.UNKNOWN);
  });

  it("picks the saved language, then Telegram's, then Russian", () => {
    expect(pickLanguage("uz", "ru")).toBe("uz");
    expect(pickLanguage(null, "en-GB")).toBe("en");
    expect(pickLanguage(null, "de")).toBe("ru");
    expect(pickLanguage("xx", undefined)).toBe("ru");
  });
});
