import type { AdminView, PromoView } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "@/lib/i18n";

import { Badge, Button, Empty, ErrorText, Input, Section, Select, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { date } from "@/lib/format";

const BLANK = {
  code: "",
  kind: "percent" as "percent" | "fixed",
  value: "30",
  months: "12",
  maxUses: "10",
  plans: "",
  validTo: "",
};

/** Promo codes: percent or fixed amount, dates, uses, plans. A code never discounts add-ons. */
export function PromoPage({ me }: { me: AdminView }) {
  const queryClient = useQueryClient();
  const promos = useQuery({ queryKey: ["promos"], queryFn: api.promoCodes });
  const owner = me.role === "owner";
  const set = (data: PromoView[]) => queryClient.setQueryData(["promos"], data);
  const toggle = useMutation({
    mutationFn: (p: PromoView) => api.setPromoDisabled(p.code, !p.disabled),
    onSuccess: set,
  });
  const [form, setForm] = useState(BLANK);
  const create = useMutation({
    mutationFn: () =>
      api.createPromo({
        code: form.code,
        kind: form.kind,
        value: Number(form.value),
        months: form.months ? Number(form.months) : null,
        maxUses: form.maxUses ? Number(form.maxUses) : null,
        allowedPlans: form.plans
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        validTo: form.validTo ? new Date(form.validTo).toISOString() : null,
      }),
    onSuccess: (data) => {
      set(data);
      setForm(BLANK);
    },
  });
  return (
    <div className="space-y-4">
      <Section title={t("Promo codes")}>
        <ErrorText error={promos.error ?? toggle.error} />
        {promos.data?.length === 0 ? (
          <Empty>{t("No promo codes.")}</Empty>
        ) : (
          <Table head={[t("Code"), t("Discount"), t("Months"), t("Used"), t("Valid until"), t("Plans"), ""]}>
            {promos.data?.map((p) => (
              <tr key={p.code}>
                <Td className="font-medium">
                  {p.code} {p.disabled && <Badge tone="danger">{t("off")}</Badge>}
                </Td>
                <Td>{p.kind === "percent" ? `${p.value}%` : `${p.value} ${t("UZS")}`}</Td>
                <Td>{p.months ?? t("first payment")}</Td>
                <Td>
                  {p.usedCount}
                  {p.maxUses !== null ? ` / ${p.maxUses}` : ""}
                </Td>
                <Td>{date(p.validTo)}</Td>
                <Td>{p.allowedPlans.length ? p.allowedPlans.join(", ") : t("all paid")}</Td>
                <Td className="text-right">
                  {owner && (
                    <Button variant={p.disabled ? "outline" : "danger"} onClick={() => toggle.mutate(p)}>
                      {p.disabled ? t("Enable") : t("Disable")}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      {owner && (
        <Section title={t("Create a promo code")}>
          <form
            className="grid gap-2 sm:grid-cols-4 xl:grid-cols-8"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Input
              placeholder={t("CODE")}
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            />
            <Select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as "percent" | "fixed" })}
            >
              <option value="percent">{t("percent")}</option>
              <option value="fixed">{t("fixed sum")}</option>
            </Select>
            <Input
              type="number"
              min={1}
              required
              placeholder={t("Value")}
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
            />
            <Input
              type="number"
              min={1}
              placeholder={t("Months (empty: first payment)")}
              value={form.months}
              onChange={(e) => setForm({ ...form, months: e.target.value })}
            />
            <Input
              type="number"
              min={1}
              placeholder={t("Max uses")}
              value={form.maxUses}
              onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
            />
            <Input
              placeholder={t("Plans: start,business")}
              value={form.plans}
              onChange={(e) => setForm({ ...form, plans: e.target.value })}
            />
            <Input
              type="date"
              value={form.validTo}
              onChange={(e) => setForm({ ...form, validTo: e.target.value })}
            />
            <Button disabled={create.isPending}>{t("Create")}</Button>
          </form>
          <ErrorText error={create.error} />
          <p className="mt-2 text-xs text-muted-foreground">
            {t("Launch code for the first 10 customers: 30%, 12 months, max uses 10.")}
          </p>
        </Section>
      )}
    </div>
  );
}
