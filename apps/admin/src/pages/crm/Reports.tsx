import type { AdminView } from "@platform/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Empty, ErrorText, Input, Section, Stat, Table, Td } from "@/components/ui";
import { api, downloadFile, leadParams } from "@/lib/api";
import { getLocale, t } from "@/lib/i18n";
import { LeadsTable } from "./Leads";

const dayOf = (offsetDays: number) =>
  new Date(Date.now() + 5 * 3_600_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);
const hours = (h: number | null) =>
  h === null ? "—" : h < 48 ? `${h} ${t("h")}` : `${Math.round((h / 24) * 10) / 10} ${t("days")}`;

/** Conversion of the funnel, time in a stage, the split by source and by manager, and the customers table. */
export function ReportsPage({ me }: { me: AdminView }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const report = useQuery({ queryKey: ["crm-report", from, to], queryFn: () => api.crmReport(from, to) });
  const exportFile = useMutation({
    mutationFn: () =>
      downloadFile(
        `/reports/export.xlsx?${leadParams({ from, to } as never)}&lang=${getLocale()}`,
        "crm-report.xlsx",
      ),
  });
  const r = report.data;
  const first = r?.funnel[0]?.reached ?? 0;
  const preset = (days: number | null) => {
    setFrom(days === null ? "" : dayOf(days));
    setTo(days === null ? "" : dayOf(0));
  };
  return (
    <div className="space-y-4">
      <Section
        title={t("Period")}
        actions={
          <Button variant="outline" disabled={exportFile.isPending} onClick={() => exportFile.mutate()}>
            {t("Download Excel")}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-muted-foreground">—</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant="ghost" onClick={() => preset(0)}>
            {t("Today")}
          </Button>
          <Button variant="ghost" onClick={() => preset(6)}>
            {t("7 days")}
          </Button>
          <Button variant="ghost" onClick={() => preset(29)}>
            {t("30 days")}
          </Button>
          <Button variant="ghost" onClick={() => preset(null)}>
            {t("All time")}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("The leads added in this period are counted.")}
        </p>
        <ErrorText error={report.error ?? exportFile.error} />
      </Section>

      {r && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t("Leads")} value={r.totalLeads} />
            <Stat label={t("Customers")} value={r.won} note={t("won")} />
            <Stat label={t("Lost")} value={r.lost} />
            <Stat label={t("Conversion")} value={`${r.conversionPct}%`} note={t("new lead → customer")} />
          </div>

          <Section title={t("Funnel conversion")}>
            {r.funnel.length === 0 || first === 0 ? (
              <Empty>{t("No leads in this period.")}</Empty>
            ) : (
              <div className="space-y-2">
                {r.funnel.map((step) => (
                  <div
                    key={step.stageId}
                    className="grid grid-cols-[9rem_1fr_9rem] items-center gap-3 text-sm max-sm:grid-cols-1"
                  >
                    <div className="font-medium">{step.name}</div>
                    <div className="h-7 rounded-lg bg-muted">
                      <div
                        className="flex h-7 items-center rounded-lg px-2 text-xs font-bold text-white"
                        style={{
                          width: `${Math.max(4, (step.reached / first) * 100)}%`,
                          backgroundColor: step.color,
                        }}
                      >
                        {step.reached}
                      </div>
                    </div>
                    <div className="tabular text-xs text-muted-foreground">
                      {step.fromPrevPct === null
                        ? t("start")
                        : t("{pct}% of previous, {first}% of all", {
                            pct: step.fromPrevPct,
                            first: step.fromFirstPct ?? 0,
                          })}
                    </div>
                  </div>
                ))}
                {r.lostStages.map((s) => (
                  <div key={s.stageId} className="text-xs text-muted-foreground">
                    {t("Outside the funnel")}: {s.name} —{" "}
                    <span className="tabular font-semibold">{s.leads}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={t("Time in a stage")}>
              <Table head={[t("Stage"), t("On average"), t("Moves")]}>
                {r.timeInStage.map((s) => (
                  <tr key={s.stageId}>
                    <Td>{s.name}</Td>
                    <Td>{hours(s.avgHours)}</Td>
                    <Td>{s.leads}</Td>
                  </tr>
                ))}
              </Table>
            </Section>
            <Section title={t("By source")}>
              {r.bySource.length === 0 ? (
                <Empty>—</Empty>
              ) : (
                <Table head={[t("Source"), t("Leads"), t("Customers"), t("Conversion")]}>
                  {r.bySource.map((s) => (
                    <tr key={s.source}>
                      <Td>{s.source || "—"}</Td>
                      <Td>{s.leads}</Td>
                      <Td>{s.won}</Td>
                      <Td>{s.conversionPct}%</Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>
          </div>

          <Section title={t("By manager")}>
            {r.byManager.length === 0 ? (
              <Empty>—</Empty>
            ) : (
              <Table
                head={[
                  t("Manager"),
                  t("Leads"),
                  t("Customers"),
                  t("Lost"),
                  t("Conversion"),
                  t("Won of closed"),
                ]}
              >
                {r.byManager.map((m) => (
                  <tr key={m.ownerId ?? "none"}>
                    <Td>{m.name || t("No manager")}</Td>
                    <Td>{m.leads}</Td>
                    <Td>{m.won}</Td>
                    <Td>{m.lost}</Td>
                    <Td>{m.conversionPct}%</Td>
                    <Td>{m.winRatePct === null ? "—" : `${m.winRatePct}%`}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        </>
      )}
      <LeadsTable me={me} compact />
    </div>
  );
}
