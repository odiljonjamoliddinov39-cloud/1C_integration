import { type AdminView, type AiPolicy, AiPolicy as AiPolicySchema } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "@/lib/i18n";

import { Badge, Button, ErrorText, Input, Section, Select } from "@/components/ui";
import { api } from "@/lib/api";

type NumberKey = {
  [K in keyof AiPolicy]: AiPolicy[K] extends number ? K : never;
}[keyof AiPolicy];

const LIMITS: { key: NumberKey; label: string; hint: string; step?: number }[] = [
  { key: "monthlyLimitUsd", label: t("Monthly limit per account, USD"), hint: t("0: no cap"), step: 1 },
  { key: "dailyLimitUsdPerUser", label: t("Daily limit per user, USD"), hint: t("0: no cap"), step: 0.5 },
  { key: "warnAtPercent", label: t("Warn at, % of a limit"), hint: t("1–100; 0: no warning") },
  {
    key: "dailyAlertUsd",
    label: t("Alert when a day costs over, USD"),
    hint: t("0: no alert; shown on AI cost"),
    step: 1,
  },
];
const TOOLS: { key: NumberKey; label: string; hint: string }[] = [
  {
    key: "maxOutputTokens",
    label: t("Max output tokens per call"),
    hint: t(
      "Thinking counts in it, and a card for a statement is one long call: keep it high (1 000–128 000)",
    ),
  },
  {
    key: "maxToolCalls",
    label: t("Max 1C reads per question"),
    hint: t("after them the model answers with what it has; 0: no cap"),
  },
  {
    key: "defaultRows",
    label: t("Rows per query, default"),
    hint: t("when the model sets no limit (1–1000)"),
  },
  { key: "maxRows", label: t("Rows per query, hard cap"), hint: "1–1000" },
  { key: "compactionThreshold", label: t("Summarize a chat above, tokens"), hint: t("50 000 or more") },
  { key: "cacheTtlMinutes", label: t("Answer cache lives, minutes"), hint: t("0: the answer cache is off") },
  {
    key: "learnMinHits",
    label: t("Learn a template after, times"),
    hint: t("the same question answered by the same query this many times (1–50)"),
  },
];

/** Every limit of the AI cost engine, editable here; the backend enforces them, the app only reads them. */
export function PoliciesPage({ me }: { me: AdminView }) {
  const policies = useQuery({ queryKey: ["ai-policies"], queryFn: api.aiPolicies });
  const [scope, setScope] = useState("default");
  if (policies.error) return <ErrorText error={policies.error} />;
  const data = policies.data;
  if (!data) return null;
  const plan = data.plans.find((p) => p.planId === scope);
  const saved = scope === "default" ? data.default : (plan?.policy ?? null);
  const owner = me.role === "owner";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("AI limits")}</h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "Every limit of the AI cost engine. A change applies from the next AI call; no app update needed. The Claude Console spend limit stays on as the outer fence.",
            )}
          </p>
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm">
          {t("Applies to")}
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="default">{t("Every plan (default)")}</option>
            {data.plans.map((p) => (
              <option key={p.planId} value={p.planId}>
                {t("Plan:")} {p.code} {p.policy ? t("(own policy)") : ""}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {saved ? (
        <PolicyForm
          key={`${scope}-${JSON.stringify(saved)}`}
          planId={scope === "default" ? null : scope}
          saved={saved}
          owner={owner}
          isDefault={scope === "default"}
        />
      ) : (
        <Section title={t("This plan uses the default policy")}>
          <p className="mb-3 text-sm text-muted-foreground">
            {t("Give it its own limits, starting from a copy of the default ones.")}
          </p>
          {owner && <CopyDefault planId={scope} policy={data.default} />}
        </Section>
      )}
    </div>
  );
}

function CopyDefault({ planId, policy }: { planId: string; policy: AiPolicy }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.saveAiPolicy({ planId, policy }),
    onSuccess: (data) => queryClient.setQueryData(["ai-policies"], data),
  });
  return (
    <>
      <Button disabled={save.isPending} onClick={() => save.mutate()}>
        {t("Create the plan's own policy")}
      </Button>
      <ErrorText error={save.error} />
    </>
  );
}

function PolicyForm({
  planId,
  saved,
  owner,
  isDefault,
}: {
  planId: string | null;
  saved: AiPolicy;
  owner: boolean;
  isDefault: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, v === null ? "" : String(v)])),
  );
  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const parsed = AiPolicySchema.safeParse({
    ...saved,
    ...Object.fromEntries(
      [...LIMITS, ...TOOLS].map(({ key }) => [key, draft[key] === "" ? Number.NaN : Number(draft[key])]),
    ),
    onLimit: draft.onLimit,
    templates: draft.templates === "true",
    learnTemplates: draft.learnTemplates === "true",
    reasoner: draft.reasoner === "true",
    reasonerModel: draft.reasonerModel,
    simpleModel: draft.simpleModel === "" ? null : draft.simpleModel,
  });
  const invalid =
    !parsed.success || parsed.data.defaultRows > parsed.data.maxRows
      ? parsed.success
        ? t("Default rows cannot be more than the hard cap.")
        : (parsed.error.issues[0]?.path.join(".") ?? "") + ": " + (parsed.error.issues[0]?.message ?? "")
      : null;
  const changed = parsed.success && JSON.stringify(parsed.data) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: (policy: AiPolicy | null) => api.saveAiPolicy({ planId, policy }),
    onSuccess: (data) => queryClient.setQueryData(["ai-policies"], data),
  });

  const field = (item: { key: NumberKey; label: string; hint: string; step?: number }) => (
    <label key={item.key} className="flex items-center gap-3 text-sm">
      <span className="w-64 shrink-0">{item.label}</span>
      <Input
        className="w-28"
        type="number"
        step={item.step ?? 1}
        min={0}
        disabled={!owner}
        value={draft[item.key] ?? ""}
        onChange={(e) => set(item.key, e.target.value)}
      />
      <span className="text-xs text-muted-foreground">{item.hint}</span>
    </label>
  );

  return (
    <div className="space-y-4">
      <Section title={t("Spend")}>
        <div className="space-y-2">
          {LIMITS.map(field)}
          <label className="flex items-center gap-3 text-sm">
            <span className="w-64 shrink-0">{t("At the limit")}</span>
            <Select disabled={!owner} value={draft.onLimit} onChange={(e) => set("onLimit", e.target.value)}>
              <option value="block">{t("Block, with a clear message")}</option>
              <option value="addon">{t("Block and offer a paid add-on")}</option>
            </Select>
          </label>
        </div>
      </Section>
      <Section title={t("Tools and context")}>
        <div className="space-y-2">{TOOLS.map(field)}</div>
      </Section>
      <Section title={t("Skipping the model")}>
        <div className="space-y-2">
          <label className="flex items-center gap-3 text-sm">
            <span className="w-64 shrink-0">{t("Query templates")}</span>
            <Select
              disabled={!owner}
              value={draft.templates}
              onChange={(e) => set("templates", e.target.value)}
            >
              <option value="true">{t("On: known questions are answered from 1C directly")}</option>
              <option value="false">{t("Off: every question goes to the model")}</option>
            </Select>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-64 shrink-0">{t("Learn templates automatically")}</span>
            <Select
              disabled={!owner}
              value={draft.learnTemplates}
              onChange={(e) => set("learnTemplates", e.target.value)}
            >
              <option value="true">{t("On: from questions the model answers with one query")}</option>
              <option value="false">{t("Off: only templates written here")}</option>
            </Select>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-64 shrink-0">{t("The engine reasons with Claude")}</span>
            <Select
              disabled={!owner}
              value={draft.reasoner}
              onChange={(e) => set("reasoner", e.target.value)}
            >
              <option value="true">
                {t("On: Claude decides what is reusable and writes the templates")}
              </option>
              <option value="false">{t("Off: traces are kept, nothing is decided")}</option>
            </Select>
            <Select
              aria-label={t("Reasoning model")}
              disabled={!owner}
              value={draft.reasonerModel}
              onChange={(e) => set("reasonerModel", e.target.value)}
            >
              <option value="claude-haiku-4-5">{t("Claude Haiku 4.5 (cheapest)")}</option>
              <option value="claude-sonnet-5-5">{t("Claude Sonnet 5.5")}</option>
            </Select>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-64 shrink-0">{t("Model for simple lookups")}</span>
            <Select
              disabled={!owner}
              value={draft.simpleModel}
              onChange={(e) => set("simpleModel", e.target.value)}
            >
              <option value="">{t("Off: the default model answers everything")}</option>
              <option value="claude-haiku-4-5">{t("Claude Haiku 4.5 (cheaper, faster)")}</option>
            </Select>
            {draft.simpleModel !== "" && (
              <Badge tone="warning">{t("turn on only after the test set passes")}</Badge>
            )}
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "The default model and effort are set on the AI model page. A failed step or a rejected answer always moves the question to the default model.",
            )}
          </p>
        </div>
      </Section>
      {owner ? (
        <div className="flex items-center gap-3">
          <Button
            disabled={!changed || Boolean(invalid) || save.isPending}
            onClick={() => parsed.success && save.mutate(parsed.data)}
          >
            {t("Save")}
          </Button>
          {!isDefault && (
            <Button
              variant="outline"
              disabled={save.isPending}
              onClick={() => {
                if (window.confirm(t("Remove this plan's own policy and use the default one?")))
                  save.mutate(null);
              }}
            >
              {t("Use the default policy")}
            </Button>
          )}
          {invalid && <span className="text-sm text-destructive">{invalid}</span>}
          <ErrorText error={save.error} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("Only an owner can change the limits.")}</p>
      )}
    </div>
  );
}
