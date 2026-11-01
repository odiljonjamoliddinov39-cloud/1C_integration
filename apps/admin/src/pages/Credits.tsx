import type {
  AdminCreditRequest,
  AdminCreditsReport,
  AdminView,
  CreditTransactionView,
} from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge, Button, Empty, ErrorText, Input, Section, Select, Stat, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { intlLocale, t } from "@/lib/i18n";
import { href } from "@/lib/router";

const number = (value: number) => new Intl.NumberFormat(intlLocale()).format(Math.round(value * 100) / 100);

const TYPE_NAMES: Record<CreditTransactionView["type"], string> = {
  monthly_grant: "Monthly credits",
  trial_grant: "Trial credits",
  purchase: "Purchase",
  bonus: "Bonus",
  ai_usage: "AI use",
  rollover: "Carried over",
  admin_adjustment: "Admin adjustment",
};

const REQUEST_STATUS: Record<
  AdminCreditRequest["status"],
  { name: string; tone: "warning" | "success" | "danger" | "muted" }
> = {
  pending: { name: "Waiting", tone: "warning" },
  approved: { name: "Approved", tone: "success" },
  rejected: { name: "Rejected", tone: "danger" },
  cancelled: { name: "Cancelled", tone: "muted" },
};

/** Purchase requests: the customer asked for credits on the website; the admin approves (credits are added) or rejects. */
export function CreditRequestsTable({
  requests,
  showCustomer,
}: {
  requests: AdminCreditRequest[];
  showCustomer: boolean;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<Record<string, string>>({});
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["credit-requests"] });
    void queryClient.invalidateQueries({ queryKey: ["credits-report"] });
    void queryClient.invalidateQueries({ queryKey: ["account-credits"] });
  };
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      (approve ? api.approveCreditRequest : api.rejectCreditRequest)(id, {
        note: note[id]?.trim() || undefined,
      }),
    onSuccess: refresh,
  });
  if (requests.length === 0) return <Empty>{t("No purchase requests.")}</Empty>;
  return (
    <>
      <ErrorText error={decide.error} />
      <Table
        head={[
          t("When"),
          ...(showCustomer ? [t("Customer")] : []),
          t("Credits"),
          t("Sum"),
          t("Balance"),
          t("Status"),
          t("Note"),
          "",
        ]}
      >
        {requests.map((r) => (
          <tr key={r.id}>
            <Td>{dateTime(r.createdAt)}</Td>
            {showCustomer && (
              <Td>
                <a className="hover:underline" href={href(`customers/${r.accountId}`)}>
                  {r.accountName}
                </a>
                {r.userEmail && <div className="text-xs text-muted-foreground">{r.userEmail}</div>}
              </Td>
            )}
            <Td className="font-semibold">+{number(r.credits)}</Td>
            <Td>
              {number(r.totalSom)} {t("sum")}
            </Td>
            <Td>{number(r.balanceCredits)}</Td>
            <Td>
              <Badge tone={REQUEST_STATUS[r.status].tone}>{t(REQUEST_STATUS[r.status].name)}</Badge>
            </Td>
            <Td className="text-muted-foreground">
              {r.status === "pending" ? (
                <Input
                  className="min-w-40"
                  placeholder={t("Note (optional)")}
                  value={note[r.id] ?? ""}
                  onChange={(e) => setNote({ ...note, [r.id]: e.target.value })}
                />
              ) : (
                r.note
              )}
            </Td>
            <Td className="text-right whitespace-nowrap">
              {r.status === "pending" && (
                <span className="inline-flex gap-2">
                  <Button
                    disabled={decide.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          t("Approve: add {count} credits to {name}?", {
                            count: number(r.credits),
                            name: r.accountName,
                          }),
                        )
                      )
                        decide.mutate({ id: r.id, approve: true });
                    }}
                  >
                    {t("Approve")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: r.id, approve: false })}
                  >
                    {t("Reject")}
                  </Button>
                </span>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </>
  );
}

/** Credits sold and spent, the price of a credit (CBU rate) with its history, and the recharges that failed. */
export function CreditsPage({ me }: { me: AdminView }) {
  const queryClient = useQueryClient();
  const report = useQuery({ queryKey: ["credits-report"], queryFn: api.creditsReport });
  const requests = useQuery({
    queryKey: ["credit-requests"],
    queryFn: api.creditRequests,
    refetchInterval: 30_000,
  });
  const owner = me.role === "owner";
  const done = (data: AdminCreditsReport) => queryClient.setQueryData(["credits-report"], data);
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const setRate = useMutation({
    mutationFn: () => api.setCreditRate({ somPerCredit: Number(price), reason }),
    onSuccess: (data) => {
      done(data);
      setPrice("");
      setReason("");
    },
  });
  if (report.error) return <ErrorText error={report.error} />;
  const r = report.data;
  if (!r) return null;
  return (
    <div className="space-y-4">
      <Section
        title={t("Purchase requests")}
        actions={
          requests.data && requests.data.pendingCount > 0 ? (
            <Badge tone="warning">{t("{count} waiting", { count: requests.data.pendingCount })}</Badge>
          ) : undefined
        }
      >
        <p className="mb-3 text-xs text-muted-foreground">
          {t(
            "A customer asks for more credits on the website. Approve it once the payment is received: the credits are added at the price of the request and an invoice marked paid is kept.",
          )}
        </p>
        <ErrorText error={requests.error} />
        <CreditRequestsTable requests={requests.data?.requests ?? []} showCustomer />
      </Section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label={t("Price of a credit")}
          value={`${number(r.somPerCredit)} ${t("sum")}`}
          note={t("CBU rate {rate}", { rate: number(r.cbuRate) })}
        />
        <Stat
          label={t("Sold, 30 days")}
          value={number(r.soldCredits30d)}
          note={`${number(r.soldSom30d)} ${t("sum")}`}
        />
        <Stat label={t("Spent, 30 days")} value={number(r.spentCredits30d)} />
        <Stat label={t("Carried over, 30 days")} value={number(r.rolledOverCredits30d)} />
        <Stat
          label={t("Balances in total")}
          value={number(r.totalBalanceCredits)}
          note={t("{count} account(s) at the cap", { count: r.accountsAtCap })}
        />
      </div>

      <Section title={t("Set the price by hand")}>
        <p className="mb-3 text-xs text-muted-foreground">
          {t(
            "The price follows the CBU rate and changes when the rate moves 5%. A price set here stays until then. Every change is kept below.",
          )}
        </p>
        <ErrorText error={setRate.error} />
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setRate.mutate();
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("Sum per credit")}
            <Input
              type="number"
              min={10}
              disabled={!owner}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            {t("Reason")}
            <Input disabled={!owner} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button
            disabled={!owner || setRate.isPending || !Number(price) || reason.trim().length < 3}
            type="submit"
          >
            {t("Set price")}
          </Button>
        </form>
      </Section>

      <Section title={t("Price history")}>
        {r.rates.length === 0 ? (
          <Empty>{t("No changes yet.")}</Empty>
        ) : (
          <Table head={[t("When"), t("Old"), t("New"), t("CBU rate"), t("By"), t("Note")]}>
            {r.rates.map((x) => (
              <tr key={x.id}>
                <Td>{dateTime(x.createdAt)}</Td>
                <Td>{number(x.oldSomPerCredit)}</Td>
                <Td className="font-semibold">{number(x.newSomPerCredit)}</Td>
                <Td>{number(x.cbuRate)}</Td>
                <Td>{x.setBy === "system" ? t("system") : t("admin")}</Td>
                <Td className="text-muted-foreground">{x.note}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title={t("Failed auto-recharges")}>
        {r.failures.length === 0 ? (
          <Empty>{t("None.")}</Empty>
        ) : (
          <Table head={[t("When"), t("Customer"), t("Credits"), t("Reason")]}>
            {r.failures.map((f) => (
              <tr key={f.id}>
                <Td>{dateTime(f.createdAt)}</Td>
                <Td>
                  <a className="hover:underline" href={href(`customers/${f.accountId}`)}>
                    {f.accountName}
                  </a>
                </Td>
                <Td>{number(f.amountCredits)}</Td>
                <Td className="text-muted-foreground">{f.reason}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

/** One customer's balance and credit history, with a form to add or take credits (owner only, a reason is required). */
export function CreditsSection({ id, owner }: { id: string; owner: boolean }) {
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ["account-credits", id], queryFn: () => api.accountCredits(id) });
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<"bonus" | "admin_adjustment">("bonus");
  const adjust = useMutation({
    mutationFn: () => api.adjustCredits(id, { credits: Number(credits), reason, kind }),
    onSuccess: () => {
      setCredits("");
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["account-credits", id] });
      void queryClient.invalidateQueries({ queryKey: ["credits-report"] });
    },
  });
  if (view.error) return <ErrorText error={view.error} />;
  const v = view.data;
  if (!v) return null;
  return (
    <Section
      title={t("AI credits")}
      actions={
        <Badge tone="info">
          {number(v.balanceCredits)} {t("credits")} · {number(v.balanceCredits * v.somPerCredit)} {t("sum")}
        </Badge>
      }
    >
      {v.requests.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-2 text-sm font-semibold">{t("Purchase requests")}</h3>
          <CreditRequestsTable requests={v.requests} showCustomer={false} />
        </div>
      )}
      {owner && (
        <>
          <ErrorText error={adjust.error} />
          <form
            className="mb-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              adjust.mutate();
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t("Credits (− to take away)")}
              <Input type="number" value={credits} onChange={(e) => setCredits(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t("Kind")}
              <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="bonus">{t("Bonus")}</option>
                <option value="admin_adjustment">{t("Correction")}</option>
              </Select>
            </label>
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              {t("Reason")}
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <Button disabled={adjust.isPending || !Number(credits) || reason.trim().length < 3} type="submit">
              {t("Apply")}
            </Button>
          </form>
        </>
      )}
      {v.history.length === 0 ? (
        <Empty>{t("No credit history yet.")}</Empty>
      ) : (
        <Table head={[t("When"), t("Type"), t("Credits"), t("Balance"), t("Note")]}>
          {v.history.map((h) => (
            <tr key={h.id}>
              <Td>{dateTime(h.createdAt)}</Td>
              <Td>{t(TYPE_NAMES[h.type])}</Td>
              <Td className={h.amountCredits < 0 ? "text-destructive" : undefined}>
                {h.amountCredits > 0 ? "+" : ""}
                {number(h.amountCredits)}
              </Td>
              <Td>{number(h.balanceAfter)}</Td>
              <Td className="text-muted-foreground">{h.note}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}
