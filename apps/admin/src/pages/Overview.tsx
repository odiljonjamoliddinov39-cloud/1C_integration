import { useQuery } from "@tanstack/react-query";

import { CostChart } from "@/components/CostChart";
import { ErrorText, Section, Stat, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { compact, usd } from "@/lib/format";
import { href } from "@/lib/router";

export function OverviewPage() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const top = useQuery({ queryKey: ["usage", 30], queryFn: () => api.usage(30) });
  const o = overview.data;
  if (overview.error) return <ErrorText error={overview.error} />;
  if (!o) return null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Customers" value={o.accounts} note={`${o.newAccounts7d} new in 7 days`} />
        <Stat
          label="Paying · trial"
          value={`${o.byStatus.active} · ${o.byStatus.trial}`}
          note={`${o.byStatus.grace} unpaid (grace), ${o.byStatus.suspended} suspended`}
        />
        <Stat label="PCs active today" value={o.activeDevices24h} note="license checked in 24 h" />
        <Stat
          label="AI cost, 30 days"
          value={usd(o.ai.costUsd30d)}
          note={`${usd(o.ai.costUsdToday)} today · ${compact(o.ai.tokens30d)} tokens`}
        />
      </div>
      <Section title="AI cost per day (USD, last 30 days)">
        <CostChart days={o.usage} />
      </Section>
      <Section
        title="Top AI users, 30 days"
        actions={
          <a className="text-xs text-primary" href={href("usage")}>
            All
          </a>
        }
      >
        <Table head={["Customer", "Requests", "Tokens", "Cost"]}>
          {(top.data ?? []).slice(0, 5).map((row) => (
            <tr key={row.accountId}>
              <Td>
                <a className="text-primary hover:underline" href={href(`customers/${row.accountId}`)}>
                  {row.accountName}
                </a>
              </Td>
              <Td>{row.requests}</Td>
              <Td>{compact(row.tokens)}</Td>
              <Td>{usd(row.costUsd)}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}
