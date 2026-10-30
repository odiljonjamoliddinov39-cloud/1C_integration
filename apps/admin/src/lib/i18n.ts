/**
 * The dashboard's language: English (the source texts), Uzbek and Russian. Every text in the UI is `t("English text")`; the
 * Uzbek and Russian dictionaries map that same text to its translation, and a text without one shows in English.
 * `{name}` in a text is filled from the values given. Changing the language reloads the page, so texts built at load time (lists, labels) follow it too.
 */
import { RU } from "./i18n-ru";
import { UZ } from "./i18n-uz";

export type Locale = "en" | "uz" | "ru";
export const LOCALES: { code: Locale; label: string }[] = [
  { code: "uz", label: "Oʻzbekcha" },
  { code: "ru", label: "Русский" },
  { code: "en", label: "English" },
];

const KEY = "admin.locale";

function initial(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "uz" || saved === "ru") return saved;
  } catch {
    // no storage: the browser's language decides
  }
  const language = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
  return language.startsWith("uz") ? "uz" : language.startsWith("ru") ? "ru" : "en";
}

const current: Locale = initial();
if (typeof document !== "undefined") document.documentElement.lang = current;
export const getLocale = (): Locale => current;

export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // not kept: the page starts from the browser's language again
  }
  window.location.reload();
}

const DICTIONARIES: Record<Locale, Record<string, string>> = { en: {}, uz: UZ, ru: RU };

/** The text in the current language; `{name}` is replaced by `vars.name`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const translated = DICTIONARIES[current][text] ?? text;
  return vars
    ? translated.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
    : translated;
}

/** The BCP 47 tag for dates and numbers. */
export const intlLocale = (): string => (current === "uz" ? "uz-UZ" : current === "ru" ? "ru-RU" : "en-GB");
