import type { AddonSaveInput, AdminPlansView, AdminView, PlanSaveInput, PlanView } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

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
  features: { excelExport: true, prioritySupport: true, support: "manager" },
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
      <Section title="Plans">
        <p className="mb-3 text-xs text-muted-foreground">
          A new price applies from a customer's next period; the period they paid for keeps the old one. Empty
          imports or audits mean unlimited. {owner ? "" : "Only owners can edit."}
        </p>
        <div className="space-y-4">
          {view.data.plans.map((p) => (
            <PlanEditor key={`${p.code}-${JSON.stringify(p)}`} plan={p} owner={owner} onSaved={done} />
          ))}
        </div>
      </Section>
      {owner && (
        <Section title="Add a custom plan">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value.toLowerCase())}
              className="w-40"
            />
            <Button disabled={create.isPending || newCode.length < 2} onClick={() => create.mutate()}>
              Create (hidden)
            </Button>
            <span className="text-xs text-muted-foreground">
              For more than 10 companies: create it, edit its limits above, then put an account on it from
              Subscriptions.
            </span>
          </div>
          <ErrorText error={create.error} />
        </Section>
      )}
      <Section title="Add-ons">
        <Table head={["Code", "Name", "Price", "Kind", "Plans", "Grants", "Public", ""]}>
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
  const set = <K extends keyof PlanSaveInput>(key: K, value: PlanSaveInput[K]) =>
    setForm({ ...form, [key]: value });
  const field = (label: string, node: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {node}
    </label>
  );
  const numeric = (
    key: "priceMonthSum" | "priceYearSum" | "companies" | "users" | "aiQuestionsPerMonth" | "sortOrder",
  ) => (
    <Input
      type="number"
      min={0}
      disabled={!owner}
      value={form[key]}
      onChange={(e) => set(key, num(e.target.value))}
    />
  );
  const nullable = (key: "importsPerMonth" | "auditsPerMonth") => (
    <Input
      type="number"
      min={0}
      placeholder="unlimited"
      disabled={!owner}
      value={form[key] ?? ""}
      onChange={(e) => set(key, e.target.value === "" ? null : num(e.target.value))}
    />
  );
  return (
    <div className="rounded-xl border border-border p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-semibold">{plan.code}</span>
        {!form.isPublic && <Badge tone="warning">hidden</Badge>}
        {dirty && <Badge tone="info">unsaved</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {field(
          "Name",
          <Input disabled={!owner} value={form.name} onChange={(e) => set("name", e.target.value)} />,
        )}
        {field("Price / month, sum", numeric("priceMonthSum"))}
        {field("Price / year, sum", numeric("priceYearSum"))}
        {field("Companies", numeric("companies"))}
        {field("Users", numeric("users"))}
        {field("AI questions / month", numeric("aiQuestionsPerMonth"))}
        {field("Imports / month", nullable("importsPerMonth"))}
        {field("Audits / month", nullable("auditsPerMonth"))}
        {field(
          "Support",
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
        {field("Order", numeric("sortOrder"))}
        {field(
          "Excel export",
          <Select
            disabled={!owner}
            value={String(form.features.excelExport)}
            onChange={(e) => set("features", { ...form.features, excelExport: e.target.value === "true" })}
          >
            <option value="true">yes</option>
            <option value="false">no</option>
          </Select>,
        )}
        {field(
          "On the pricing page",
          <Select
            disabled={!owner}
            value={String(form.isPublic)}
            onChange={(e) => set("isPublic", e.target.value === "true")}
          >
            <option value="true">shown</option>
            <option value="false">hidden</option>
          </Select>,
        )}
      </div>
      {owner && (
        <div className="mt-3 flex items-center gap-3">
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save {plan.code}
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
          <option value="true">shown</option>
          <option value="false">hidden</option>
        </Select>
      </Td>
      <Td>
        {owner && (
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        )}
        <ErrorText error={save.error} />
      </Td>
    </tr>
  );
}
