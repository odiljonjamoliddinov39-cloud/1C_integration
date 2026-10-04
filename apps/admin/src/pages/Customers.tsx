import type { SubscriptionStatus } from "@platform/shared";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";

import { StatusBadge } from "@/components/StatusBadge";
import { Card, Empty, ErrorText, Input, Select, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { date, relative, usd } from "@/lib/format";
import { href } from "@/lib/router";

export function CustomersPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<SubscriptionStatus | "">("");
  const query = useDeferredValue(q);
  const accounts = useQuery({
    queryKey: ["accounts", query, status],
    queryFn: () => api.accounts(query, status),
    placeholderData: (previous) => previous,
  });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <Input
          className="w-72"
          placeholder="Search by name or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select value={status} onChange={(e) => setStatus(e.target.value as SubscriptionStatus | "")}>
          <option value="">All statuses</option>
          <option value="trial">Trial</option>
          <option value="active">Active</option>
          <option value="grace">Grace (unpaid)</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">{accounts.data?.length ?? 0} customers</span>
      </div>
      <ErrorText error={accounts.error} />
      {accounts.data?.length === 0 ? (
        <Empty>No customers match.</Empty>
      ) : (
        <Table
          head={["Customer", "Status", "Plan ends", "PCs", "Companies", "Last activity", "AI, 30 d", "Since"]}
        >
          {accounts.data?.map((a) => (
            <tr key={a.id} className="hover:bg-muted/50">
              <Td>
                <a className="font-medium text-primary hover:underline" href={href(`customers/${a.id}`)}>
                  {a.name}
                </a>
                <div className="text-xs text-muted-foreground">{a.ownerEmail}</div>
              </Td>
              <Td>
                <StatusBadge status={a.status} blocked={a.blocked} />
              </Td>
              <Td>
                {date(a.endsAt)}
                <div className="text-xs text-muted-foreground">{relative(a.endsAt)}</div>
              </Td>
              <Td>{a.activeDevices}</Td>
              <Td>{a.companies}</Td>
              <Td>{relative(a.lastActivityAt)}</Td>
              <Td>{usd(a.aiCostUsd30d)}</Td>
              <Td>{date(a.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
