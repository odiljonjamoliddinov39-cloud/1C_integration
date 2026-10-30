import { useQuery } from "@tanstack/react-query";
import { intlLocale, t } from "@/lib/i18n";

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
      {o.aiAlert && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <div className="font-semibold">
            {t("The AI provider is refusing our requests: customers cannot use the assistant")}
          </div>
          <div className="mt-1">{o.aiAlert.message}</div>
          <div className="mt-1 text-xs">
            {t(
              "Since {when}. Fix it at the provider (credit or billing); this clears itself after the next successful answer.",
              { when: new Date(o.aiAlert.at).toLocaleString(intlLocale()) },
            )}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t("Customers")}
          value={o.accounts}
          note={t("{count} new in 7 days", { count: o.newAccounts7d })}
        />
        <Stat
          label={t("Paying · trial")}
          value={`${o.byStatus.active} · ${o.byStatus.trial}`}
          note={t("{grace} unpaid (grace), {suspended} suspended", {
            grace: o.byStatus.grace,
            suspended: o.byStatus.suspended,
          })}
        />
        <Stat label={t("PCs active today")} value={o.activeDevices24h} note={t("license checked in 24 h")} />
        <Stat
          label={t("AI cost, 30 days")}
          value={usd(o.ai.costUsd30d)}
          note={t("{cost} today · {tokens} tokens", {
            cost: usd(o.ai.costUsdToday),
            tokens: compact(o.ai.tokens30d),
          })}
        />
      </div>
      <Section title={t("AI cost per day (USD, last 30 days)")}>
        <CostChart days={o.usage} />
      </Section>
      <Section
        title={t("Top AI users, 30 days")}
        actions={
          <a className="text-xs text-primary" href={href("usage")}>
            {t("All")}
          </a>
        }
      >
        <Table head={[t("Customer"), t("Requests"), t("Tokens"), t("Cost")]}>
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
