import { useQuery } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

import { Badge, Empty, ErrorText, Section, Stat, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { date, sum } from "@/lib/format";
import { href } from "@/lib/router";

/** Money: MRR, who pays for what, how many Free accounts became paid, and what is overdue. */
export function RevenuePage() {
  const revenue = useQuery({ queryKey: ["revenue"], queryFn: api.revenue });
  if (revenue.error) return <ErrorText error={revenue.error} />;
  const r = revenue.data;
  if (!r) return null;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label={t("MRR")}
          value={sum(r.mrrSum)}
          note={t("paid plans and recurring add-ons per month, VAT excluded")}
        />
        <Stat
          label={t("Paid accounts")}
          value={r.paidAccounts}
          note={t("{trial} on trial · {free} on Free", { trial: r.trialAccounts, free: r.freeAccounts })}
        />
        <Stat
          label={t("Free → paid")}
          value={`${r.conversionPercent}%`}
          note={t("of {count} accounts ever paid", { count: r.accounts })}
        />
        <Stat
          label={t("Collected, 30 days")}
          value={sum(r.collected30dSum)}
          note={t("paid invoices, VAT included")}
        />
      </div>
      <Section title={t("Paid accounts per plan")}>
        {r.byPlan.length === 0 ? (
          <Empty>{t("No paid accounts yet.")}</Empty>
        ) : (
          <Table head={[t("Plan"), t("Accounts"), t("MRR")]}>
            {r.byPlan.map((p) => (
              <tr key={p.plan}>
                <Td className="font-medium">{p.plan}</Td>
                <Td>{p.accounts}</Td>
                <Td>{sum(p.mrrSum)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Section
        title={t("Overdue invoices")}
        actions={r.overdue.count > 0 ? <Badge tone="danger">{sum(r.overdue.totalSum)}</Badge> : undefined}
      >
        {r.overdue.count === 0 ? (
          <Empty>{t("Nothing overdue.")}</Empty>
        ) : (
          <Table head={[t("Invoice"), t("Account"), t("Total"), t("Due")]}>
            {r.overdue.items.map((i) => (
              <tr key={i.number}>
                <Td className="font-medium">{i.number}</Td>
                <Td>
                  <a className="hover:underline" href={href("subscriptions")}>
                    {i.accountName}
                  </a>
                </Td>
                <Td>{sum(i.totalSum)}</Td>
                <Td>{date(i.dueAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
