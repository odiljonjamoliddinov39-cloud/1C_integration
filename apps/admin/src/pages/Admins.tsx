import type { AdminRole, AdminView } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "@/lib/i18n";

import { Badge, Button, ErrorText, Input, Section, Select, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";

export function AdminsPage({ me }: { me: AdminView }) {
  const queryClient = useQueryClient();
  const admins = useQuery({ queryKey: ["admins"], queryFn: api.admins });
  const toggle = useMutation({
    mutationFn: (a: AdminView) => api.setAdminDisabled(a.id, !a.disabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admins"] }),
  });
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "support" as AdminRole });
  const create = useMutation({
    mutationFn: () => api.createAdmin(form),
    onSuccess: () => {
      setForm({ email: "", name: "", password: "", role: "support" });
      void queryClient.invalidateQueries({ queryKey: ["admins"] });
    },
  });
  return (
    <div className="space-y-4">
      <Section title={t("Admins")}>
        <ErrorText error={admins.error ?? toggle.error} />
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
              </Td>
              <Td>{relative(a.lastLoginAt)}</Td>
              <Td className="text-right">
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
          className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto_auto]"
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
          <Input
            type="password"
            placeholder={t("Password (10+ characters)")}
            minLength={10}
            required
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AdminRole })}>
            <option value="support">{t("Support")}</option>
            <option value="owner">{t("Owner")}</option>
          </Select>
          <Button disabled={create.isPending}>{t("Add")}</Button>
        </form>
        <ErrorText error={create.error} />
        <p className="mt-2 text-xs text-muted-foreground">
          {t(
            "Support can look up customers, extend licenses and manage PCs. Only owners can block accounts and manage admins.",
          )}
        </p>
      </Section>
    </div>
  );
}
