// Number and date formatting in the current UI language (set by I18nProvider).
// Labels (document types, statuses, ...) live in i18n.tsx.

let locale = "ru-RU";
let compactSuffixes: [number, string][] = [];
const cache = new Map<string, Intl.NumberFormat>();

// Uzbek uses the same separators as Russian (2 880 000,00; 02.10.2026), and not every browser
// ships Uzbek number data, so Uzbek formats with ru-RU and its own short-number words.
const FORMAT_LOCALE: Record<string, string> = { "uz-Latn-UZ": "ru-RU" };
const SUFFIXES: Record<string, [number, string][]> = {
  "uz-Latn-UZ": [[1e9, "mlrd"], [1e6, "mln"], [1e3, "ming"]],
  "ru-RU": [[1e9, "млрд"], [1e6, "млн"], [1e3, "тыс."]],
  "en-GB": [[1e9, "B"], [1e6, "M"], [1e3, "K"]],
};

function numberFormat(kind: "money" | "compact"): Intl.NumberFormat {
  const key = `${locale}:${kind}`;
  let f = cache.get(key);
  if (!f) {
    f =
      kind === "money"
        ? new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    cache.set(key, f);
  }
  return f;
}

export function setFormatLocale(next: string) {
  locale = FORMAT_LOCALE[next] ?? next;
  compactSuffixes = SUFFIXES[next] ?? SUFFIXES["en-GB"];
}

export function fmtMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return numberFormat("money").format(Number(value));
}

export function fmtCompact(value: string | number): string {
  const n = Number(value);
  for (const [size, word] of compactSuffixes) {
    if (Math.abs(n) >= size) return `${numberFormat("compact").format(n / size)} ${word}`;
  }
  return numberFormat("compact").format(n);
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(locale);
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startOfYear(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export function startOfMonth(): string {
  return today().slice(0, 8) + "01";
}

/** "2026-09" -> "2026-09-30" */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}
