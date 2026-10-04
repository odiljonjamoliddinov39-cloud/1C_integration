import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Card, Empty, ErrorText, Select, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { compact, usd } from "@/lib/format";
import { href } from "@/lib/router";

export function UsagePage() {
  const [days, setDays] = useState(30);
  const usage = useQuery({ queryKey: ["usage", days], queryFn: () => api.usage(days) });
  const total = (usage.data ?? []).reduce((s, r) => s + r.costUsd, 0);
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-border p-3">
        <h1 className="text-sm font-semibold">AI usage by customer</h1>
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </Select>
        <span className="tabular ml-auto text-sm text-muted-foreground">Total {usd(total)}</span>
      </div>
      <ErrorText error={usage.error} />
      {usage.data?.length === 0 ? (
        <Empty>No AI use in this period.</Empty>
      ) : (
        <Table head={["Customer", "Requests", "Tokens", "Cost", "Share"]}>
          {usage.data?.map((r) => (
            <tr key={r.accountId}>
              <Td>
                <a className="text-primary hover:underline" href={href(`customers/${r.accountId}`)}>
                  {r.accountName}
                </a>
              </Td>
              <Td>{r.requests}</Td>
              <Td>{compact(r.tokens)}</Td>
              <Td>{usd(r.costUsd)}</Td>
              <Td>{total > 0 ? `${Math.round((r.costUsd / total) * 100)}%` : "—"}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
