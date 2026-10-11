import { useQuery } from "@tanstack/react-query";

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
          label="MRR"
          value={sum(r.mrrSum)}
          note="paid plans and recurring add-ons per month, VAT excluded"
        />
        <Stat
          label="Paid accounts"
          value={r.paidAccounts}
          note={`${r.trialAccounts} on trial · ${r.freeAccounts} on Free`}
        />
        <Stat
          label="Free → paid"
          value={`${r.conversionPercent}%`}
          note={`of ${r.accounts} accounts ever paid`}
        />
        <Stat label="Collected, 30 days" value={sum(r.collected30dSum)} note="paid invoices, VAT included" />
      </div>
      <Section title="Paid accounts per plan">
        {r.byPlan.length === 0 ? (
          <Empty>No paid accounts yet.</Empty>
        ) : (
          <Table head={["Plan", "Accounts", "MRR"]}>
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
        title="Overdue invoices"
        actions={r.overdue.count > 0 ? <Badge tone="danger">{sum(r.overdue.totalSum)}</Badge> : undefined}
      >
        {r.overdue.count === 0 ? (
          <Empty>Nothing overdue.</Empty>
        ) : (
          <Table head={["Invoice", "Account", "Total", "Due"]}>
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
