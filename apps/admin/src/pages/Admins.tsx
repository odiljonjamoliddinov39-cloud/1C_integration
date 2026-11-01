import type { AdminRole, AdminView } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "@/lib/i18n";

import { Badge, Button, ErrorText, Input, Section, Select, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";

/** A one-time password, shown once: the owner hands it to the person, who must change it at the first sign-in. */
function OneTimePassword({ who, password, onClose }: { who: string; password: string; onClose: () => void }) {
  return (
    <div className="mb-4 rounded-xl border border-warning/50 bg-warning/15 p-4 text-sm">
      <div className="font-semibold">{t("One-time password for {who}", { who })}</div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="rounded-lg bg-card px-3 py-1.5 font-mono text-base font-bold tracking-wide select-all">
          {password}
        </code>
        <Button variant="outline" onClick={() => void navigator.clipboard?.writeText(password)}>
          {t("Copy")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("Done")}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t(
          "It is shown only now and is not kept anywhere. Give it to the person: they must change it when they sign in.",
        )}
      </p>
    </div>
  );
}

export function AdminsPage({ me }: { me: AdminView }) {
  const queryClient = useQueryClient();
  const admins = useQuery({ queryKey: ["admins"], queryFn: api.admins });
  const [shown, setShown] = useState<{ who: string; password: string } | null>(null);
  const toggle = useMutation({
    mutationFn: (a: AdminView) => api.setAdminDisabled(a.id, !a.disabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admins"] }),
  });
  const reset = useMutation({
    mutationFn: (a: AdminView) =>
      api.resetAdminPassword(a.id).then((r) => ({ who: a.email, password: r.tempPassword })),
    onSuccess: (result) => {
      setShown(result);
      void queryClient.invalidateQueries({ queryKey: ["admins"] });
    },
  });
  const BLANK = { email: "", name: "", password: "", role: "manager" as AdminRole };
  const [form, setForm] = useState(BLANK);
  const create = useMutation({
    mutationFn: () =>
      api.createAdmin({
        email: form.email,
        name: form.name,
        role: form.role,
        ...(form.password ? { password: form.password } : {}),
      }),
    onSuccess: (created) => {
      setForm(BLANK);
      setShown(created.tempPassword ? { who: created.email, password: created.tempPassword } : null);
      void queryClient.invalidateQueries({ queryKey: ["admins"] });
    },
  });
  return (
    <div className="space-y-4">
      <Section title={t("Admins")}>
        {shown && (
          <OneTimePassword who={shown.who} password={shown.password} onClose={() => setShown(null)} />
        )}
        <ErrorText error={admins.error ?? toggle.error ?? reset.error} />
        <Table head={[t("Email"), t("Name"), t("Role"), t("Last sign-in"), ""]}>
          {admins.data?.map((a) => (
            <tr key={a.id}>
              <Td>{a.email}</Td>
              <Td>{a.name}</Td>
              <Td>
                <Badge tone={a.role === "owner" ? "info" : "muted"}>{t(a.role)}</Badge>
                {a.disabled && (
                  <span className="ml-2">
                    <Badge tone="danger">{t("disabled")}</Badge>
                  </span>
                )}
                {a.mustChangePassword && (
                  <span className="ml-2">
                    <Badge tone="warning">{t("one-time password")}</Badge>
                  </span>
                )}
              </Td>
              <Td>{relative(a.lastLoginAt)}</Td>
              <Td className="space-x-2 text-right whitespace-nowrap">
                <Button variant="outline" disabled={reset.isPending} onClick={() => reset.mutate(a)}>
                  {t("New password")}
                </Button>
                {a.id !== me.id && (
                  <Button variant={a.disabled ? "outline" : "danger"} onClick={() => toggle.mutate(a)}>
                    {a.disabled ? t("Enable") : t("Disable")}
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Section>
      <Section title={t("Add an admin")}>
        <form
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input
            type="email"
            placeholder={t("Email")}
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <Input
            placeholder={t("Name")}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AdminRole })}>
            <option value="manager">{t("Sales manager")}</option>
            <option value="support">{t("Support")}</option>
            <option value="owner">{t("Owner")}</option>
          </Select>
          <Input
            type="password"
            placeholder={t("Password (empty: a one-time one is made)")}
            minLength={10}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <Button disabled={create.isPending}>{t("Add")}</Button>
        </form>
        <ErrorText error={create.error} />
        <p className="mt-2 text-xs text-muted-foreground">
          {t(
            "Support can look up customers, extend licenses and manage PCs. Only owners can block accounts and manage admins.",
          )}{" "}
          {t(
            "A sales manager sees only the CRM, and only their own leads. They sign in to the CRM Mini App with this email and password.",
          )}
        </p>
      </Section>
    </div>
  );
}
