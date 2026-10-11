import { useTranslation } from "react-i18next";

import { LANGUAGES, type Language, setLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function LanguageSelect({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  return (
    <select
      aria-label={t("header.language")}
      className={cn(
        "h-10 w-full rounded-xl border border-white/15 bg-sidebar-panel px-3 text-sm text-sidebar-foreground",
        className,
      )}
      value={i18n.language}
      onChange={(e) => setLanguage(e.target.value as Language)}
    >
      {Object.entries(LANGUAGES).map(([code, name]) => (
        <option key={code} value={code}>
          {name}
        </option>
      ))}
    </select>
  );
}
