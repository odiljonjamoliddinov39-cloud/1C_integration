import { useTranslation } from "react-i18next";

import type { ConnectorStatus } from "../../../shared/ipc";
import { Badge } from "@/components/ui/card";
import { formatTime } from "@/lib/format";

export function errorText(t: (key: string) => string, code: string, message: string): string {
  const known = t(`errors.${code}`);
  return known === `errors.${code}` ? message : `${known} ${message}`;
}

export function ConnectorStatusBadge({ status }: { status: ConnectorStatus | null }) {
  const { t, i18n } = useTranslation();
  if (!status) return <Badge>{t("companies.notChecked")}</Badge>;
  const when = t("companies.checkedAt", { time: formatTime(status.checkedAt, i18n.language) });
  if (status.ok) {
    return (
      <div>
        <Badge tone="success">{t("companies.ok")}</Badge>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {t("companies.extension", { version: status.ping.extensionVersion })} · {when}
        </div>
      </div>
    );
  }
  return (
    <div title={status.message}>
      <Badge tone="danger">
        {t("companies.error")}: {status.code}
      </Badge>
      <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
        {errorText(t, status.code, status.message)}
      </div>
    </div>
  );
}
