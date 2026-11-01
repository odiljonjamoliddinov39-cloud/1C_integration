import { useTranslation } from "react-i18next";

import { LANGUAGES, type Language, setLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** `dark`: on the dark sidebar; `light`: on a light page (the sign-in screen). */
export function LanguageSelect({
  variant = "dark",
  className,
}: {
  variant?: "dark" | "light";
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  return (
    <select
      aria-label={t("header.language")}
      className={cn(
        "h-10 w-full rounded-xl border px-3 text-sm font-medium",
        variant === "dark"
          ? "on-dark border-white/15 bg-sidebar-panel text-sidebar-foreground hover:border-white/30"
          : "border-border bg-card text-foreground hover:border-primary/40",
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
