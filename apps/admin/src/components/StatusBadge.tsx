import type { SubscriptionStatus } from "@platform/shared";
import { t } from "@/lib/i18n";

import { Badge, type Tone } from "@/components/ui";

const STATUS: Record<SubscriptionStatus, [Tone, string]> = {
  free: ["muted", t("Free")],
  trial: ["info", t("Trial")],
  active: ["success", t("Active")],
  grace: ["warning", t("Grace (unpaid)")],
  suspended: ["danger", t("Suspended")],
  cancelled: ["muted", t("Cancelled")],
};

export function StatusBadge({ status, blocked }: { status: SubscriptionStatus | null; blocked?: boolean }) {
  if (blocked) return <Badge tone="danger">{t("Blocked")}</Badge>;
  if (!status) return <Badge>{t("No plan")}</Badge>;
  const [tone, label] = STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}
