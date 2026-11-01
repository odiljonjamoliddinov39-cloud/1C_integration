import { useTranslation } from "react-i18next";

import type { ConnectorStatus } from "../../../shared/ipc";
import { Badge } from "@/components/ui/card";
import { formatTime } from "@/lib/format";

export function errorText(t: (key: string) => string, code: string, message: string): string {
  const known = t(`errors.${code}`);
  return known === `errors.${code}` ? message : `${known} ${message}`;
}

/** The state in one pill: connected, an error, or not checked yet. */
export function ConnectorStatusBadge({ status }: { status: ConnectorStatus | null }) {
  const { t } = useTranslation();
  if (!status) return <Badge>{t("companies.notChecked")}</Badge>;
  if (status.ok) {
    return (
      <Badge tone="success">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
        {t("companies.ok")}
      </Badge>
    );
  }
  return (
    <Badge tone="danger">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {t("companies.error")}: {status.code}
    </Badge>
  );
}

/** What the state means: the extension and when it was checked, or what 1C said. */
export function ConnectorStatusDetail({ status }: { status: ConnectorStatus | null }) {
  const { t, i18n } = useTranslation();
  if (!status) return null;
  const when = t("companies.checkedAt", { time: formatTime(status.checkedAt, i18n.language) });
  if (status.ok) {
    return (
      <div className="text-xs text-muted-foreground">
        {t("companies.extension", { version: status.ping.extensionVersion })} · {when}
      </div>
    );
  }
  return (
    <div className="line-clamp-2 text-xs text-muted-foreground" title={status.message}>
      {errorText(t, status.code, status.message)}
    </div>
  );
}
