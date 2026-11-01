import { describe, expect, it } from "vitest";

import { DICTIONARIES, errorText, pickLanguage } from "./i18n.js";

const keys = (value: unknown, prefix = ""): string[] =>
  Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );

describe("the CRM Mini App's words", () => {
  it("are the same keys in Uzbek and Russian, none of them empty", () => {
    expect(keys(DICTIONARIES.ru).sort()).toEqual(keys(DICTIONARIES.uz).sort());
    for (const dictionary of Object.values(DICTIONARIES))
      for (const key of keys(dictionary)) {
        const value = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], dictionary);
        expect(value, key).not.toBe("");
      }
  });

  it("choose the language: the saved one, else Telegram's, else Uzbek", () => {
    expect(pickLanguage("ru", "uz")).toBe("ru");
    expect(pickLanguage(null, "ru-RU")).toBe("ru");
    expect(pickLanguage(null, "en")).toBe("uz");
    expect(pickLanguage("xx", null)).toBe("uz");
  });

  it("says a known error in the person's language and an unknown one as the server did", () => {
    expect(errorText(DICTIONARIES.ru, "BAD_PHONE", "x")).toBe("Неверный номер телефона");
    expect(errorText(DICTIONARIES.uz, "SOMETHING", "Server said so")).toBe("Server said so");
  });
});
