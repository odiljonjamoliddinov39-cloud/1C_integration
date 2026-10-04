import type { AccountDetail, AdminView } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { CostChart } from "@/components/CostChart";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge, Button, Empty, ErrorText, Input, Section, Stat, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { compact, date, dateTime, relative, usd } from "@/lib/format";
import { href } from "@/lib/router";

export function CustomerPage({ id, me }: { id: string; me: AdminView }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["account", id], queryFn: () => api.account(id) });
  const update = (data: AccountDetail) => {
    queryClient.setQueryData(["account", id], data);
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  };
  const block = useMutation({
    mutationFn: (blocked: boolean) => api.setBlocked(id, blocked),
    onSuccess: update,
  });
  const device = useMutation({
    mutationFn: ({ deviceId, revoked }: { deviceId: string; revoked: boolean }) =>
      api.setDeviceRevoked(deviceId, revoked),
    onSuccess: update,
  });

  if (detail.error) return <ErrorText error={detail.error} />;
  const d = detail.data;
  if (!d) return null;
  const a = d.account;
  const quotaShare = d.aiQuota > 0 ? Math.min(1, d.aiUsedTokens / d.aiQuota) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <a className="text-sm text-muted-foreground hover:underline" href={href("customers")}>
          ← Customers
        </a>
        <h1 className="text-xl font-semibold">{a.name}</h1>
        <StatusBadge status={a.status} />
        {a.blocked && <Badge tone="danger">Blocked</Badge>}
        {me.role === "owner" && (
          <Button
            variant={a.blocked ? "outline" : "danger"}
            className="ml-auto"
            disabled={block.isPending}
            onClick={() => {
              const verb = a.blocked ? "Unblock" : "Block";
              if (
                window.confirm(
                  `${verb} ${a.name}? ${a.blocked ? "" : "They will be signed out of the app and the assistant."}`,
                )
              )
                block.mutate(!a.blocked);
            }}
          >
            {a.blocked ? "Unblock" : "Block account"}
          </Button>
        )}
      </div>
      <ErrorText error={block.error ?? device.error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Plan" value={a.plan ?? "—"} note={`ends ${date(a.endsAt)} (${relative(a.endsAt)})`} />
        <Stat
          label="PCs in use"
          value={a.activeDevices}
          note={`${d.users.length} user(s), ${a.companies} company(ies)`}
        />
        <Stat
          label="AI quota used"
          value={`${Math.round(quotaShare * 100)}%`}
          note={`${compact(d.aiUsedTokens)} of ${compact(d.aiQuota)} tokens this period`}
        />
        <Stat
          label="AI cost, 30 days"
          value={usd(a.aiCostUsd30d)}
          note={`last activity ${relative(a.lastActivityAt)}`}
        />
      </div>

      <ExtendForm id={id} onDone={update} />

      <Section title="PCs">
        {d.devices.length === 0 ? (
          <Empty>No PC activated yet.</Empty>
        ) : (
          <Table head={["PC", "User", "Activated", "Last check", "", ""]}>
            {d.devices.map((pc) => (
              <tr key={pc.id}>
                <Td className="font-medium">{pc.name}</Td>
                <Td>{pc.userEmail}</Td>
                <Td>{date(pc.activatedAt)}</Td>
                <Td>{relative(pc.lastSeenAt)}</Td>
                <Td>
                  {pc.revoked ? <Badge tone="danger">Removed</Badge> : <Badge tone="success">In use</Badge>}
                </Td>
                <Td className="text-right">
                  <Button
                    variant={pc.revoked ? "outline" : "danger"}
                    disabled={device.isPending}
                    onClick={() => device.mutate({ deviceId: pc.id, revoked: !pc.revoked })}
                  >
                    {pc.revoked ? "Let back in" : "Remove"}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Removing a PC frees its seat; that PC goes read-only and cannot sign in again until let back in.
        </p>
      </Section>

      <Section title="AI cost per day (USD, last 30 days)">
        <CostChart days={d.usage} />
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Users">
          <Table head={["Email", "Name", "Role", "Last sign-in"]}>
            {d.users.map((u) => (
              <tr key={u.id}>
                <Td>{u.email}</Td>
                <Td>{u.name}</Td>
                <Td>{u.role}</Td>
                <Td>{relative(u.lastLoginAt)}</Td>
              </tr>
            ))}
          </Table>
        </Section>
        <Section title="Companies (INN and name only)">
          {d.companies.length === 0 ? (
            <Empty>None connected yet.</Empty>
          ) : (
            <Table head={["INN", "Name", "Connected"]}>
              {d.companies.map((c) => (
                <tr key={c.inn}>
                  <Td>{c.inn}</Td>
                  <Td>{c.name}</Td>
                  <Td>{date(c.connectedAt)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Subscriptions">
          <Table head={["Plan", "Status", "From", "Until"]}>
            {d.subscriptions.map((s) => (
              <tr key={s.id}>
                <Td>{s.plan}</Td>
                <Td>
                  <StatusBadge status={s.status} />
                </Td>
                <Td>{date(s.startsAt)}</Td>
                <Td>{date(s.endsAt)}</Td>
              </tr>
            ))}
          </Table>
        </Section>
        <Section title="Admin actions on this customer">
          {d.audit.length === 0 ? (
            <Empty>None yet.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.audit.map((e) => (
                <li key={e.id}>
                  <span className="text-muted-foreground">{dateTime(e.at)}</span> · <b>{e.action}</b> by{" "}
                  {e.adminEmail ?? "a removed admin"}
                  {Object.keys(e.payload).length > 0 && (
                    <div className="text-xs text-muted-foreground">{describe(e.payload)}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function ExtendForm({ id, onDone }: { id: string; onDone: (d: AccountDetail) => void }) {
  const [days, setDays] = useState("30");
  const [reason, setReason] = useState("");
  const extend = useMutation({
    mutationFn: () => api.extend(id, Number(days), reason),
    onSuccess: (data) => {
      setReason("");
      onDone(data);
    },
  });
  return (
    <Section title="Extend the license">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          extend.mutate();
        }}
      >
        <Input
          className="w-20"
          type="number"
          min={1}
          max={366}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
        <span className="text-sm text-muted-foreground">days</span>
        <Input
          className="min-w-64 flex-1"
          placeholder="Reason, e.g. paid by bank transfer"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button disabled={extend.isPending || !(Number(days) >= 1)}>Extend</Button>
        {extend.isSuccess && <span className="text-sm text-success">Done</span>}
      </form>
      <ErrorText error={extend.error} />
      <p className="mt-2 text-xs text-muted-foreground">
        Adds the days to the end date (or to today if it has passed) and reactivates a suspended account. The
        PCs pick it up at their next license check (within 6 hours, or when the app restarts).
      </p>
    </Section>
  );
}

function describe(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? date(v) : String(v)}`)
    .join(" · ");
}
