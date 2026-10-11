import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LicenseView } from "../../../shared/ipc";
import { formatTime } from "@/lib/format";

const TRIAL_DAYS = 30;

/** The licence in the sidebar: its state, until when, and for a trial how much of it has passed. */
export function LicenseCard({ license }: { license: LicenseView | null }) {
  const { t, i18n } = useTranslation();
  const [now] = useState(() => Date.now());
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
        {label}
      </div>
      {license && (
        <div className="mt-1.5 text-xs text-sidebar-muted">
          {t("license.until", { date: formatTime(license.paidUntil, i18n.language) })}
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
