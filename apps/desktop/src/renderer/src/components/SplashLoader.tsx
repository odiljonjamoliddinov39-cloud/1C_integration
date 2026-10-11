import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import spaceEngineering from "@/assets/space-engineering.webp";
import { Logo } from "@/components/Logo";

/** How long the splash stays at least, so it is seen and not a flash. */
export const SPLASH_MIN_MS = 1500;
const FADE_MS = 450;

/**
 * The start-up screen: the product, a progress bar, and who made it. It stays until the app has
 * what it needs (`done`) and then fades away.
 */
export function SplashLoader({ done }: { done: boolean }) {
  const { t } = useTranslation();
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(timer);
  }, [done]);
  if (gone) return null;
  return (
    <div
      role="status"
      aria-label={t("appName")}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-10 bg-linear-to-br from-[#0b2670] via-[#12399a] to-[#1d5fe0] text-white transition-opacity duration-500"
      style={{ opacity: done ? 0 : 1, pointerEvents: done ? "none" : "auto" }}
    >
      <div className="flex flex-col items-center gap-4">
        <Logo size={64} />
        <div className="text-2xl font-bold tracking-tight">{t("appName")}</div>
        <div className="h-1 w-48 overflow-hidden rounded-full bg-white/20">
          <div className="se-bar h-full w-1/3 rounded-full bg-amber-300" />
        </div>
      </div>
      <div className="flex flex-col items-center gap-3">
        <span className="text-[11px] font-semibold tracking-[0.25em] text-white/70 uppercase">
          {t("splash.madeBy")}
        </span>
        <img
          src={spaceEngineering}
          alt="Space Engineering"
          width={176}
          height={176}
          className="se-float rounded-[2.2rem] shadow-2xl shadow-black/40"
        />
      </div>
    </div>
  );
}
