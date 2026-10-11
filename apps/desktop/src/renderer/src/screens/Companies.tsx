import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { CompanyView } from "../../../shared/ipc";
import { ConnectCompanyDialog } from "@/components/ConnectCompanyDialog";
import { DidoxTestDialog } from "@/components/DidoxTestDialog";
import { ConnectorStatusBadge } from "@/components/ConnectorStatus";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { describeInfobase, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Company avatars cycle through the palette. */
const AVATARS = [
  "bg-amber-200 text-amber-900",
  "bg-teal-100 text-teal-800",
  "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800",
];

/** The three steps of how it works, in the colors of the design. */
const STEPS = [
  { key: "connect", card: "bg-indigo-100 text-indigo-950", badge: "bg-indigo-700" },
  { key: "ask", card: "bg-teal-100 text-teal-950", badge: "bg-teal-700" },
  { key: "confirm", card: "bg-orange-100 text-orange-950", badge: "bg-orange-700" },
] as const;

export function CompaniesScreen({ onOpenAssistant }: { onOpenAssistant: (companyId: string) => void }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [didoxOpen, setDidoxOpen] = useState(false);
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => window.platform.companies.list() });
  const session = useQuery({ queryKey: ["session"], queryFn: () => window.platform.auth.session() });
  const readOnly = session.data?.license?.mode !== "active";
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["companies"] });
  const check = useMutation({
    mutationFn: (id: string) => window.platform.companies.checkStatus(id),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => window.platform.companies.remove(id),
    onSettled: refresh,
  });

  function confirmRemove(company: CompanyView) {
    if (window.confirm(t("companies.confirmRemove", { name: company.name }))) remove.mutate(company.id);
  }

  const initials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word.slice(0, 1).toUpperCase())
      .join("");

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("companies.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("companies.subtitle")}</p>
        </div>
        <Button variant="outline" className="ml-auto h-11 px-5" onClick={() => setDidoxOpen(true)}>
          {t("didox.button")}
        </Button>
        <Button
          className="h-11 px-5 shadow-lg shadow-primary/25"
          disabled={readOnly}
          onClick={() => setConnecting(true)}
        >
          <span aria-hidden="true" className="text-lg leading-none">
            +
          </span>
          {t("companies.connect")}
        </Button>
      </div>

      <div className="grid gap-4 min-[1100px]:grid-cols-2 2xl:grid-cols-3">
        {companies.data?.map((company, index) => (
          <Card key={company.id} className="flex flex-col gap-4 p-5">
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-base font-bold",
                  AVATARS[index % AVATARS.length],
                )}
              >
                {initials(company.name)}
              </span>
              <div className="min-w-0">
                <div className="text-lg leading-snug font-bold break-words">{company.name}</div>
                <div
                  className="truncate text-xs text-muted-foreground"
                  title={describeInfobase(company.infobase)}
                >
                  1C ·{" "}
                  {company.infobase.kind === "file" ? t("companies.fileBase") : t("companies.serverBase")}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <ConnectorStatusBadge status={company.lastStatus} />
              {company.aiEnabled && (
                <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  {t("companies.assistantOn")}
                </span>
              )}
            </div>
            <div className="space-y-0.5 text-xs text-muted-foreground">
              <div>
                {t("companies.inn")}: {company.inn || "—"} · {t("companies.user")}: {company.user || "—"}
              </div>
              <div>
                {t("companies.lastSync")}: {formatTime(company.lastSyncAt, i18n.language)}
              </div>
            </div>
            <div className="mt-auto flex flex-wrap gap-2">
              <Button
                variant="tint"
                className="flex-1 whitespace-nowrap"
                onClick={() => onOpenAssistant(company.id)}
              >
                {t("companies.openAssistant")}
              </Button>
              <Button
                variant="outline"
                disabled={check.isPending && check.variables === company.id}
                onClick={() => check.mutate(company.id)}
              >
                {t("companies.check")}
              </Button>
              <Button variant="destructive" onClick={() => confirmRemove(company)}>
                {t("companies.remove")}
              </Button>
            </div>
          </Card>
        ))}
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setConnecting(true)}
          className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 p-6 text-center transition-colors hover:bg-primary/10 disabled:opacity-50"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-3xl text-primary">
            +
          </span>
          <span className="font-bold text-primary">{t("companies.addNew")}</span>
          <span className="text-sm text-muted-foreground">
            {companies.data?.length === 0 ? t("companies.empty") : t("companies.addNewHint")}
          </span>
        </button>
      </div>

      <h2 className="mt-10 mb-4 text-lg font-bold">{t("companies.how.title")}</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <div key={step.key} className={cn("rounded-2xl p-5", step.card)}>
            <span
              className={cn(
                "mb-3 flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-white",
                step.badge,
              )}
            >
              {i + 1}
            </span>
            <div className="font-bold">{t(`companies.how.${step.key}.title`)}</div>
            <div className="mt-1 text-sm opacity-80">{t(`companies.how.${step.key}.text`)}</div>
          </div>
        ))}
      </div>

      {didoxOpen && <DidoxTestDialog onClose={() => setDidoxOpen(false)} />}

      {connecting && (
        <ConnectCompanyDialog
          onClose={() => setConnecting(false)}
          onConnected={() => {
            setConnecting(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
