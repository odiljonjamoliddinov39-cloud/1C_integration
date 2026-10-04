import { useTranslation } from "react-i18next";

import type { LicenseView } from "../../../shared/ipc";
import { Badge } from "@/components/ui/card";
import { formatTime } from "@/lib/format";

export function LicenseBadge({ license }: { license: LicenseView | null }) {
  const { t, i18n } = useTranslation();
  if (!license) return <Badge tone="warning">{t("license.none")}</Badge>;
  if (license.mode === "read_only") return <Badge tone="danger">{t("license.readOnly")}</Badge>;
  const until = formatTime(license.paidUntil, i18n.language);
  return (
    <span title={t("license.checked", { time: formatTime(license.checkedAt, i18n.language) })}>
      <Badge tone={license.status === "grace" ? "warning" : "success"}>
        {t(`license.status.${license.status}`)} · {t("license.until", { date: until })}
      </Badge>
    </span>
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
