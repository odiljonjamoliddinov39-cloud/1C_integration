import { Select } from "@/components/ui";
import { LOCALES, type Locale, getLocale, setLocale } from "@/lib/i18n";

/** The dashboard's language; choosing one reloads the page in it, and the choice is kept in this browser. */
export function LanguageSelect({ className }: { className?: string }) {
  return (
    <Select
      className={className}
      aria-label="Language"
      value={getLocale()}
      onChange={(e) => setLocale(e.target.value as Locale)}
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </Select>
  );
}
