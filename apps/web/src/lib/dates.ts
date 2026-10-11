import type { Locale } from "./i18n";

// Browsers often lack Uzbek month names ("2026 M10 18"), so Uzbek dates are written out here.
const UZ_MONTHS = [
  "yanvar",
  "fevral",
  "mart",
  "aprel",
  "may",
  "iyun",
  "iyul",
  "avgust",
  "sentabr",
  "oktabr",
  "noyabr",
  "dekabr",
];

export function formatDate(d: Date, locale: Locale): string {
  if (locale === "uz") return `${d.getFullYear()}-yil ${d.getDate()}-${UZ_MONTHS[d.getMonth()]}`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}
