import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { BillingView, LicenseView } from "../../../shared/ipc";
import { aiCredits, aiQuestionsLeft } from "@/lib/billing";
import { formatTime } from "@/lib/format";

const TRIAL_DAYS = 14;

type Tone = "ok" | "low" | "out";

/** A day's or a week's limit: green, then yellow from 80%, red when it is reached. */
const limitTone = (share: number): Tone => (share >= 1 ? "out" : share >= 0.8 ? "low" : "ok");

/** A name and its value on one line, a thin bar under it, and a smaller hint. */
function Meter({
  label,
  value,
  share,
  low,
  hint,
}: {
  label: string;
  value: string;
  share: number;
  low: Tone;
  hint?: string;
}) {
  const color = low === "out" ? "bg-destructive" : low === "low" ? "bg-warning" : "bg-emerald-400";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sidebar-muted">{label}</span>
        <span
          className={`font-semibold whitespace-nowrap tabular-nums ${low === "out" ? "text-red-300" : ""}`}
        >
          {value}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${color}`}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%` }}
        />
      </div>
      {hint && <div className="mt-1 text-[11px] text-sidebar-muted/80">{hint}</div>}
    </div>
  );
}

/** The licence in the sidebar: its state, until when, and for a trial how much of it has passed. */
export function LicenseCard({
  license,
  billing,
}: {
  license: LicenseView | null;
  billing: BillingView | null;
}) {
  const { t, i18n } = useTranslation();
  const [now] = useState(() => Date.now());
  const credits = aiCredits(billing);
  /** Credits as soum (the sidebar speaks soum), and what an amount is worth in questions. */
  const som = (n: number, unit = false) =>
    `${Math.round(n * (credits?.somPerCredit ?? 0)).toLocaleString(i18n.language)}${unit ? ` ${t("billing.sum")}` : ""}`;
  const estimate = (n: number) => {
    if (!credits) return undefined;
    const questions = Math.round((n * credits.somPerCredit) / credits.questionSom);
    const tokens =
      credits.tokensPerQuestion === null
        ? ""
        : ` · ${t("billing.estTokens", { n: (questions * credits.tokensPerQuestion).toLocaleString(i18n.language) })}`;
    return `${t("billing.estQuestions", { n: questions.toLocaleString(i18n.language) })}${tokens}`;
  };
  // With credits the balance replaces the question count.
  const ai = credits ? null : aiQuestionsLeft(billing);
  const planName = billing ? t(`billing.plan.${billing.entitlements.plan}`) : null;
  const label = !license
    ? t("license.none")
    : license.mode === "read_only"
      ? t("license.readOnly")
      : t(`license.status.${license.status}`);
  const tone = !license
    ? "bg-warning"
    : license.mode === "read_only" || license.status === "grace"
      ? "bg-destructive"
      : "bg-emerald-400";
  const until = license ? Date.parse(license.paidUntil) : NaN;
  const left = Number.isFinite(until) ? until - now : NaN;
  const passed =
    license?.status === "trial" && Number.isFinite(left)
      ? Math.min(1, Math.max(0, 1 - left / (TRIAL_DAYS * 86_400_000)))
      : null;
  return (
    <div
      className="rounded-2xl bg-sidebar-panel p-4 text-sidebar-foreground"
      title={license ? t("license.checked", { time: formatTime(license.checkedAt, i18n.language) }) : ""}
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className={`h-2.5 w-2.5 rounded-full ${tone}`} />
        {planName ? `${planName} · ${label}` : label}
      </div>
      {license && license.status !== "free" && (
        <div className="mt-1.5 text-xs text-sidebar-muted">
          {t("license.until", { date: formatTime(license.paidUntil, i18n.language) })}
        </div>
      )}
      {ai && (
        <div className="mt-2 text-xs text-sidebar-foreground/90">
          {ai.left > 0 ? t("billing.aiLeft", { left: ai.left, total: ai.total }) : t("billing.aiNone")}
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/15">
            <div
              className={`h-full rounded-full ${ai.left === 0 ? "bg-destructive" : ai.left / Math.max(1, ai.total) <= 0.2 ? "bg-warning" : "bg-emerald-400"}`}
              style={{ width: `${Math.round((ai.left / Math.max(1, ai.total)) * 100)}%` }}
            />
          </div>
        </div>
      )}
      {credits && (
        <div className="mt-3 space-y-3 border-t border-white/10 pt-3 text-xs">
          <Meter
            label={t("billing.planLabel")}
            value={som(credits.balance, true)}
            share={credits.balance / Math.max(1, credits.monthly, credits.balance)}
            low={credits.balance === 0 ? "out" : billing?.credits?.low ? "low" : "ok"}
            hint={estimate(credits.balance)}
          />
          {credits.daily && (
            <Meter
              label={t("billing.dayLabel")}
              value={`${som(Math.min(credits.daily.usedCredits, credits.daily.limitCredits))} / ${som(credits.daily.limitCredits)}`}
              share={credits.daily.usedCredits / Math.max(1, credits.daily.limitCredits)}
              low={limitTone(credits.daily.usedCredits / Math.max(1, credits.daily.limitCredits))}
              hint={t("billing.limitResets", { when: formatTime(credits.daily.resetsAt, i18n.language) })}
            />
          )}
          {credits.weekly && (
            <Meter
              label={t("billing.weekLabel")}
              value={`${som(Math.min(credits.weekly.usedCredits, credits.weekly.limitCredits))} / ${som(credits.weekly.limitCredits)}`}
              share={credits.weekly.usedCredits / Math.max(1, credits.weekly.limitCredits)}
              low={limitTone(credits.weekly.usedCredits / Math.max(1, credits.weekly.limitCredits))}
              hint={t("billing.limitResets", { when: formatTime(credits.weekly.resetsAt, i18n.language) })}
            />
          )}
          {(credits.extra > 0 || credits.extraEnabled) && (
            <div className="rounded-lg bg-white/5 px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sidebar-muted">{t("billing.extraLabel")}</span>
                <span className="font-semibold whitespace-nowrap tabular-nums">
                  {som(credits.extra, true)}
                </span>
              </div>
              <span
                className={`mt-1.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${credits.extraEnabled ? "bg-emerald-400/20 text-emerald-300" : "bg-white/10 text-sidebar-muted"}`}
              >
                {credits.extraEnabled ? t("billing.extraOn") : t("billing.extraOff")}
              </span>
            </div>
          )}
          {credits.blocked && credits.resetsAt && (
            <div className="rounded-lg bg-warning/15 px-2.5 py-2 text-amber-200">
              {t("billing.creditsLimit", { when: formatTime(credits.resetsAt, i18n.language) })}
            </div>
          )}
        </div>
      )}
      {passed !== null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/15">
          <div
            className="h-full rounded-full bg-emerald-400"
            style={{ width: `${Math.round(passed * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function ReadOnlyBanner({ license }: { license: LicenseView | null }) {
  const { t } = useTranslation();
  if (!license || license.mode !== "read_only") return null;
  return (
    <div className="bg-destructive/10 px-6 py-2 text-sm text-destructive">
      {t(`license.reason.${license.reason ?? "invalid"}`)}
    </div>
  );
}
