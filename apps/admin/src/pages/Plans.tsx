import {
  type AddonSaveInput,
  type AdminPlansView,
  type AdminView,
  type PlanSaveInput,
  type PlanView,
  YEAR_PAID_MONTHS,
  yearPriceOf,
} from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { intlLocale, t } from "@/lib/i18n";

import { Badge, Button, ErrorText, Input, Section, Select, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";

const toInput = (p: PlanView): PlanSaveInput => ({
  name: p.name,
  priceMonthSum: p.priceMonthSum,
  priceYearSum: p.priceYearSum,
  companies: p.companies,
  users: p.users,
  importsPerMonth: p.importsPerMonth,
  auditsPerMonth: p.auditsPerMonth,
  aiQuestionsPerMonth: p.aiQuestionsPerMonth,
  monthlyCredits: p.monthlyCredits,
  features: p.features,
  isPublic: p.isPublic,
  sortOrder: p.sortOrder,
});

const SUPPORT = ["docs", "telegram", "telegram-priority", "manager"];
const NEW_PLAN: PlanSaveInput = {
  name: "Custom",
  priceMonthSum: 0,
  priceYearSum: 0,
  companies: 20,
  users: 10,
  importsPerMonth: null,
  auditsPerMonth: null,
  aiQuestionsPerMonth: 1500,
  monthlyCredits: 19_930,
  features: { excelExport: true, prioritySupport: true, support: "manager", telegram: true },
  isPublic: false,
  sortOrder: 50,
};

/** Prices and limits of the plans and add-ons. Plans are data: a change needs no release. */
export function PlansPage({ me }: { me: AdminView }) {
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ["billing-plans"], queryFn: api.billingPlans });
  const owner = me.role === "owner";
  const done = (data: AdminPlansView) => queryClient.setQueryData(["billing-plans"], data);
  const [newCode, setNewCode] = useState("custom");
  const create = useMutation({ mutationFn: () => api.savePlan(newCode, NEW_PLAN), onSuccess: done });
  if (view.error) return <ErrorText error={view.error} />;
  if (!view.data) return null;
  return (
    <div className="space-y-4">
      <Section title={t("Plans")}>
        <p className="mb-3 text-xs text-muted-foreground">
          {t(
            "A new price applies from a customer's next period; the period they paid for keeps the old one. Empty imports or audits mean unlimited.",
          )}{" "}
          {owner ? "" : t("Only owners can edit.")}
        </p>
        <div className="space-y-4">
          {view.data.plans.map((p) => (
            <PlanEditor key={`${p.code}-${JSON.stringify(p)}`} plan={p} owner={owner} onSaved={done} />
          ))}
        </div>
      </Section>
      {owner && (
        <Section title={t("Add a custom plan")}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value.toLowerCase())}
              className="w-40"
            />
            <Button disabled={create.isPending || newCode.length < 2} onClick={() => create.mutate()}>
              {t("Create (hidden)")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t(
                "For more than 10 companies: create it, edit its limits above, then put an account on it from Subscriptions.",
              )}
            </span>
          </div>
          <ErrorText error={create.error} />
        </Section>
      )}
      <Section title={t("Add-ons")}>
        <Table head={[t("Code"), t("Name"), t("Price"), t("Kind"), t("Plans"), t("Grants"), t("Public"), ""]}>
          {view.data.addons.map((a) => (
            <AddonRow key={`${a.code}-${JSON.stringify(a)}`} addon={a} owner={owner} onSaved={done} />
          ))}
        </Table>
      </Section>
    </div>
  );
}

function num(value: string): number {
  const n = Number(value.replace(/\s/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function PlanEditor({
  plan,
  owner,
  onSaved,
}: {
  plan: PlanView;
  owner: boolean;
  onSaved: (d: AdminPlansView) => void;
}) {
  const [form, setForm] = useState<PlanSaveInput>(toInput(plan));
  const save = useMutation({ mutationFn: () => api.savePlan(plan.code, form), onSuccess: onSaved });
  const dirty = JSON.stringify(form) !== JSON.stringify(toInput(plan));
  // The yearly price is always the monthly one for 10 months (12 for 10): it is shown, not typed.
  const set = <K extends keyof PlanSaveInput>(key: K, value: PlanSaveInput[K]) =>
    setForm({
      ...form,
      [key]: value,
      ...(key === "priceMonthSum" ? { priceYearSum: yearPriceOf(Number(value)) } : {}),
    });
  const field = (label: string, node: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {node}
    </label>
  );
  const numeric = (
    key: "priceMonthSum" | "companies" | "users" | "aiQuestionsPerMonth" | "monthlyCredits" | "sortOrder",
  ) => (
    <Input
      type="number"
      min={0}
      disabled={!owner}
      value={form[key]}
      onChange={(e) => set(key, num(e.target.value))}
    />
  );
  /** What a monthly limit comes to over a year, shown under the field. */
  const perYear = (monthly: number | null) =>
    monthly === null ? null : (
      <span className="text-[11px]">
        = {new Intl.NumberFormat(intlLocale()).format(monthly * 12)} {t("/ year")}
      </span>
    );
  const nullable = (key: "importsPerMonth" | "auditsPerMonth") => (
    <>
      <Input
        type="number"
        min={0}
        placeholder={t("unlimited")}
        disabled={!owner}
        value={form[key] ?? ""}
        onChange={(e) => set(key, e.target.value === "" ? null : num(e.target.value))}
      />
      {perYear(form[key])}
    </>
  );
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-semibold">{plan.code}</span>
        {!form.isPublic && <Badge tone="warning">{t("hidden")}</Badge>}
        {dirty && <Badge tone="info">{t("unsaved")}</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {field(
          t("Name"),
          <Input disabled={!owner} value={form.name} onChange={(e) => set("name", e.target.value)} />,
        )}
        {field(t("Price / month, sum"), numeric("priceMonthSum"))}
        {field(
          t("Price / year, sum (automatic)"),
          <>
            <Input type="number" disabled value={yearPriceOf(form.priceMonthSum)} readOnly />
            <span className="text-[11px]">
              {t("= monthly × {months} (2 months free)", { months: YEAR_PAID_MONTHS })}
              {form.priceMonthSum > 0 &&
                `, ${t("saves {amount}", {
                  amount: new Intl.NumberFormat(intlLocale()).format(
                    form.priceMonthSum * 12 - yearPriceOf(form.priceMonthSum),
                  ),
                })}`}
            </span>
          </>,
        )}
        {field(t("Companies"), numeric("companies"))}
        {field(t("Users"), numeric("users"))}
        {field(
          t("AI questions / month"),
          <>
            {numeric("aiQuestionsPerMonth")}
            {perYear(form.aiQuestionsPerMonth)}
          </>,
        )}
        {field(
          t("AI credits / month"),
          <>
            {numeric("monthlyCredits")}
            {perYear(form.monthlyCredits)}
          </>,
        )}
        {field(t("Imports / month"), nullable("importsPerMonth"))}
        {field(t("Audits / month"), nullable("auditsPerMonth"))}
        {field(
          t("Support"),
          <Select
            disabled={!owner}
            value={form.features.support}
            onChange={(e) => set("features", { ...form.features, support: e.target.value })}
          >
            {[...new Set([...SUPPORT, form.features.support])].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>,
        )}
        {field(t("Order"), numeric("sortOrder"))}
        {field(
          t("Excel export"),
          <Select
            disabled={!owner}
            value={String(form.features.excelExport)}
            onChange={(e) => set("features", { ...form.features, excelExport: e.target.value === "true" })}
          >
            <option value="true">{t("yes")}</option>
            <option value="false">{t("no")}</option>
          </Select>,
        )}
        {field(
          t("Telegram remote control"),
          <Select
            disabled={!owner}
            value={String(form.features.telegram)}
            onChange={(e) => set("features", { ...form.features, telegram: e.target.value === "true" })}
          >
            <option value="true">{t("yes")}</option>
            <option value="false">{t("no")}</option>
          </Select>,
        )}
        {field(
          t("On the pricing page"),
          <Select
            disabled={!owner}
            value={String(form.isPublic)}
            onChange={(e) => set("isPublic", e.target.value === "true")}
          >
            <option value="true">{t("shown")}</option>
            <option value="false">{t("hidden")}</option>
          </Select>,
        )}
      </div>
      {owner && (
        <div className="mt-3 flex items-center gap-3">
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {t("Save {code}", { code: plan.code })}
          </Button>
          <ErrorText error={save.error} />
        </div>
      )}
    </div>
  );
}

function AddonRow({
  addon,
  owner,
  onSaved,
}: {
  addon: AdminPlansView["addons"][number];
  owner: boolean;
  onSaved: (d: AdminPlansView) => void;
}) {
  const [price, setPrice] = useState(String(addon.priceSum));
  const [isPublic, setPublic] = useState(addon.isPublic);
  const save = useMutation({
    mutationFn: () => {
      const input: AddonSaveInput = {
        name: addon.name,
        priceSum: num(price),
        kind: addon.kind,
        allowedPlans: addon.allowedPlans,
        grants: addon.grants,
        isPublic,
      };
      return api.saveAddon(addon.code, input);
    },
    onSuccess: onSaved,
  });
  const dirty = num(price) !== addon.priceSum || isPublic !== addon.isPublic;
  return (
    <tr>
      <Td className="font-medium">{addon.code}</Td>
      <Td>{addon.name}</Td>
      <Td>
        <Input
          type="number"
          className="w-32"
          disabled={!owner}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </Td>
      <Td>{addon.kind === "one_off" ? "one-off" : "monthly"}</Td>
      <Td>{addon.allowedPlans.join(", ")}</Td>
      <Td>{JSON.stringify(addon.grants)}</Td>
      <Td>
        <Select
          disabled={!owner}
          value={String(isPublic)}
          onChange={(e) => setPublic(e.target.value === "true")}
        >
          <option value="true">{t("shown")}</option>
          <option value="false">{t("hidden")}</option>
        </Select>
      </Td>
      <Td>
        {owner && (
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {t("Save")}
          </Button>
        )}
        <ErrorText error={save.error} />
      </Td>
    </tr>
  );
}
