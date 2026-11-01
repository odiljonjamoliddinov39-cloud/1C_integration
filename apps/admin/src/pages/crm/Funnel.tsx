import type { AdminView } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Empty, ErrorText, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { date } from "@/lib/format";
import { t } from "@/lib/i18n";
import { href } from "@/lib/router";
import { leadLink } from "./common";

/** The funnel as a board: a column for each stage, the leads in it as cards; a card moves with the select. */
export function FunnelPage({ me }: { me: AdminView }) {
  void me;
  const queryClient = useQueryClient();
  const funnel = useQuery({ queryKey: ["crm-funnel"], queryFn: api.crmFunnel });
  const leads = useQuery({ queryKey: ["crm-board"], queryFn: () => api.crmLeads({ limit: 500 }) });
  const move = useMutation({
    mutationFn: (v: { id: string; stageId: string }) => api.crmMoveLead(v.id, v.stageId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["crm-board"] });
      void queryClient.invalidateQueries({ queryKey: ["crm-funnel"] });
      void queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
    },
  });
  const stages = funnel.data?.stages ?? [];
  const total = leads.data?.total ?? 0;
  return (
    <div className="space-y-3">
      <ErrorText error={funnel.error ?? leads.error ?? move.error} />
      {stages.length === 0 ? (
        <Empty>{t("No stages yet.")}</Empty>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {stages.map((stage) => {
            const cards = (leads.data?.leads ?? []).filter((l) => l.stageId === stage.id);
            return (
              <div key={stage.id} className="w-72 shrink-0 rounded-xl border border-border bg-muted/40">
                <div
                  className="flex items-center gap-2 border-b border-border px-3 py-2.5"
                  style={{ borderTop: `3px solid ${stage.color}`, borderRadius: "0.75rem 0.75rem 0 0" }}
                >
                  <span className="text-sm font-bold">{stage.name}</span>
                  {stage.isWon && <span className="text-xs text-success">{t("won")}</span>}
                  {stage.isLost && <span className="text-xs text-destructive">{t("lost")}</span>}
                  <span className="tabular ml-auto rounded-full bg-card px-2 py-0.5 text-xs font-semibold">
                    {stage.leads}
                  </span>
                </div>
                <div className="max-h-[70vh] space-y-2 overflow-y-auto p-2">
                  {cards.length === 0 && (
                    <div className="py-4 text-center text-xs text-muted-foreground">—</div>
                  )}
                  {cards.map((l) => (
                    <div
                      key={l.id}
                      className="rounded-lg border border-border bg-card p-2.5 text-sm shadow-sm"
                    >
                      <a className="font-semibold text-primary hover:underline" href={href(leadLink(l))}>
                        {l.name}
                      </a>
                      <div className="tabular text-xs text-muted-foreground">{l.phone}</div>
                      <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                        {l.source && <span>{l.source}</span>}
                        {l.ownerName && <span>{l.ownerName}</span>}
                        <span>{date(l.createdAt)}</span>
                      </div>
                      <Select
                        className="mt-2 h-8 w-full text-xs"
                        value={l.stageId}
                        disabled={move.isPending}
                        onChange={(e) => move.mutate({ id: l.id, stageId: e.target.value })}
                      >
                        {stages.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {total > 500 && (
        <div className="text-xs text-muted-foreground">
          {t("The board shows the newest 500 leads; the Leads page has them all.")}
        </div>
      )}
    </div>
  );
}
