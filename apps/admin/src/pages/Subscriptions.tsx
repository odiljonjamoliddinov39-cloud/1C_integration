import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { StatusBadge } from "@/components/StatusBadge";
import { Badge, Button, Empty, ErrorText, Input, Section, Select, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { date, dateTime, sum } from "@/lib/format";
import { href } from "@/lib/router";

/** Subscriptions: find an account by name or email, change its plan, extend it, mark a bank transfer paid. */
export function SubscriptionsPage({ accountId }: { accountId: string | null }) {
  return accountId ? <Detail accountId={accountId} /> : <List />;
}

function List() {
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState("");
  const plans = useQuery({ queryKey: ["billing-plans"], queryFn: api.billingPlans });
  const list = useQuery({
    queryKey: ["subscriptions", q, plan, status],
    queryFn: () => api.subscriptions(q, plan, status),
  });
  return (
    <Section title="Subscriptions">
      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          className="w-64"
          placeholder="Search by name or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
          <option value="">All plans</option>
          {plans.data?.plans.map((p) => (
            <option key={p.code} value={p.code}>
              {p.code}
            </option>
          ))}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["free", "trial", "active", "grace", "suspended", "cancelled"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">{list.data?.length ?? 0} accounts</span>
      </div>
      <ErrorText error={list.error} />
      {list.data?.length === 0 ? (
        <Empty>Nothing found.</Empty>
      ) : (
        <Table head={["Account", "Plan", "Status", "Period end", "Billing", "Unpaid", ""]}>
          {list.data?.map((r) => (
            <tr key={r.subscriptionId}>
              <Td>
                <div className="font-medium">{r.accountName}</div>
                <div className="text-xs text-muted-foreground">{r.ownerEmail}</div>
              </Td>
              <Td>{r.plan}</Td>
              <Td>
                <StatusBadge status={r.status as never} />
              </Td>
              <Td>{date(r.periodEnd)}</Td>
              <Td className="text-xs">
                {r.billingCycle}
                {r.cancelAtPeriodEnd && <Badge tone="warning">cancels</Badge>}
                {r.pendingPlan && <Badge tone="info">→ {r.pendingPlan}</Badge>}
                {r.promoCode && <Badge>{r.promoCode}</Badge>}
              </Td>
              <Td>{r.pendingInvoices > 0 ? <Badge tone="warning">{r.pendingInvoices}</Badge> : "—"}</Td>
              <Td className="text-right">
                <a className="text-primary hover:underline" href={href(`subscriptions/${r.accountId}`)}>
                  Open
                </a>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function Detail({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["billing-detail", accountId],
    queryFn: () => api.billingDetail(accountId),
  });
  const plans = useQuery({ queryKey: ["billing-plans"], queryFn: api.billingPlans });
  const [plan, setPlan] = useState("");
  const [days, setDays] = useState("");
  const [addon, setAddon] = useState("");
  const [reason, setReason] = useState("");
  const act = useMutation({
    mutationFn: (input: Parameters<typeof api.subscriptionAction>[1]) => {
      const id = detail.data?.subscription.subscriptionId;
      if (!id) throw new Error("not loaded");
      return api.subscriptionAction(id, { ...input, reason });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["billing-detail", accountId], data);
      void queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      void queryClient.invalidateQueries({ queryKey: ["revenue"] });
      setPlan("");
      setDays("");
      setAddon("");
    },
  });
  if (detail.error) return <ErrorText error={detail.error} />;
  const d = detail.data;
  if (!d) return null;
  const s = d.subscription;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <a className="text-sm text-muted-foreground hover:underline" href={href("subscriptions")}>
          ← Subscriptions
        </a>
        <h1 className="text-xl font-semibold">{s.accountName}</h1>
        <StatusBadge status={s.status as never} />
        <span className="text-sm text-muted-foreground">
          {s.plan} · {s.billingCycle} · until {date(s.periodEnd)}
        </span>
        <a className="ml-auto text-sm text-primary hover:underline" href={href(`customers/${accountId}`)}>
          Customer page
        </a>
      </div>

      <Section title="Change">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <div className="text-xs font-semibold text-muted-foreground uppercase">Put on a plan</div>
            <Select className="w-full" value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="">Choose…</option>
              {plans.data?.plans.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.code}
                </option>
              ))}
            </Select>
            <Button disabled={!plan || act.isPending} onClick={() => act.mutate({ plan })}>
              Set plan (1 period)
            </Button>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-semibold text-muted-foreground uppercase">Extend</div>
            <Input
              type="number"
              min={1}
              className="w-full"
              placeholder="Days"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            <Button disabled={!days || act.isPending} onClick={() => act.mutate({ days: Number(days) })}>
              Extend
            </Button>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-semibold text-muted-foreground uppercase">Give an add-on</div>
            <Select className="w-full" value={addon} onChange={(e) => setAddon(e.target.value)}>
              <option value="">Choose…</option>
              {plans.data?.addons.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code}
                </option>
              ))}
            </Select>
            <Button disabled={!addon || act.isPending} onClick={() => act.mutate({ addon, quantity: 1 })}>
              Grant
            </Button>
          </div>
        </div>
        <Input
          className="mt-3 w-full"
          placeholder="Reason (goes to the audit log)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <ErrorText error={act.error} />
      </Section>

      <Section title="Invoices">
        {d.invoices.length === 0 ? (
          <Empty>No invoices.</Empty>
        ) : (
          <Table head={["Invoice", "Created", "Items", "Total", "Status", ""]}>
            {d.invoices.map((i) => (
              <tr key={i.id}>
                <Td className="font-medium">{i.number}</Td>
                <Td>{date(i.createdAt)}</Td>
                <Td className="text-xs">{i.items.map((x) => x.title).join(", ")}</Td>
                <Td>{sum(i.totalSum)}</Td>
                <Td>
                  <Badge
                    tone={i.status === "paid" ? "success" : i.status === "pending" ? "warning" : "muted"}
                  >
                    {i.status}
                  </Badge>
                  {i.provider && <span className="ml-1 text-xs text-muted-foreground">{i.provider}</span>}
                </Td>
                <Td className="text-right">
                  {(i.status === "pending" || i.status === "expired") && (
                    <Button
                      variant="outline"
                      disabled={act.isPending}
                      onClick={() => {
                        if (
                          window.confirm(`Mark ${i.number} (${sum(i.totalSum)}) as paid by bank transfer?`)
                        ) {
                          act.mutate({ markPaidInvoiceId: i.id });
                        }
                      }}
                    >
                      Mark paid
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Add-ons">
        {d.addons.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <Table head={["Add-on", "Quantity", "From", "Until"]}>
            {d.addons.map((a, n) => (
              <tr key={n}>
                <Td className="font-medium">{a.code}</Td>
                <Td>{a.quantity}</Td>
                <Td>{date(a.validFrom)}</Td>
                <Td>{date(a.validTo)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Billing events">
        {d.events.length === 0 ? (
          <Empty>No events.</Empty>
        ) : (
          <Table head={["When", "Event", "Details"]}>
            {d.events.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap">{dateTime(e.createdAt)}</Td>
                <Td className="font-medium">{e.type}</Td>
                <Td className="text-xs text-muted-foreground">{JSON.stringify(e.payload)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
