import type { SubscriptionStatus } from "@platform/shared";

import { Badge, type Tone } from "@/components/ui";

const STATUS: Record<SubscriptionStatus, [Tone, string]> = {
  trial: ["info", "Trial"],
  active: ["success", "Active"],
  grace: ["warning", "Grace (unpaid)"],
  suspended: ["danger", "Suspended"],
  cancelled: ["muted", "Cancelled"],
};

export function StatusBadge({ status, blocked }: { status: SubscriptionStatus | null; blocked?: boolean }) {
  if (blocked) return <Badge tone="danger">Blocked</Badge>;
  if (!status) return <Badge>No plan</Badge>;
  const [tone, label] = STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}
