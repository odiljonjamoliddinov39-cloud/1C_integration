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

/** A date with the time of day, for when a limit starts over. */
export function formatDateTime(d: Date, locale: Locale): string {
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${formatDate(d, locale)}, ${time}`;
}
