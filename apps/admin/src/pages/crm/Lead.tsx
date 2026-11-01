import type { AdminView, CallResult, CrmLeadRow } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Empty, ErrorText, Input, Section, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { href } from "@/lib/router";
import { CardForm } from "./CardForm";
import { CALL_RESULT_OPTIONS, StageBadge, callResultLabel, duration } from "./common";

/** The lead's own fields; it starts again from the saved lead when that changes (the key). */
function LeadForm({ id, lead, onSaved }: { id: string; lead: CrmLeadRow; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: lead.name,
    phone: lead.phone,
    source: lead.source ?? "",
    company: lead.company ?? "",
  });
  const save = useMutation({
    mutationFn: () =>
      api.crmUpdateLead(id, {
        name: form.name,
        phone: form.phone,
        source: form.source || null,
        company: form.company || null,
      }),
    onSuccess: onSaved,
  });
  return (
    <>
      <form
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Input
          placeholder={t("Name")}
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Input
          placeholder={t("Phone")}
          required
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
        <Input
          placeholder={t("Source")}
          value={form.source}
          onChange={(e) => setForm({ ...form, source: e.target.value })}
        />
        <Input
          placeholder={t("Company")}
          value={form.company}
          onChange={(e) => setForm({ ...form, company: e.target.value })}
        />
        <Button disabled={save.isPending}>{t("Save")}</Button>
      </form>
      <ErrorText error={save.error} />
    </>
  );
}

/** One lead: who it is, where it stands, who works with it, and what has happened (calls, notes, the moves between stages). */
export function LeadPage({ id, me }: { id: string; me: AdminView }) {
  const queryClient = useQueryClient();
  const staff = me.role !== "manager";
  const detail = useQuery({ queryKey: ["crm-lead", id], queryFn: () => api.crmLead(id) });
  const funnel = useQuery({ queryKey: ["crm-funnel"], queryFn: api.crmFunnel });
  const team = useQuery({ queryKey: ["crm-team"], queryFn: api.crmTeam, enabled: staff });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["crm-lead", id] });
    void queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
    void queryClient.invalidateQueries({ queryKey: ["crm-funnel"] });
  };
  const lead = detail.data?.lead;

  const move = useMutation({
    mutationFn: (stageId: string) => api.crmMoveLead(id, stageId),
    onSuccess: refresh,
  });
  const assign = useMutation({
    mutationFn: (ownerId: string) => api.crmUpdateLead(id, { ownerId: ownerId || null }),
    onSuccess: refresh,
  });

  const [note, setNote] = useState("");
  const addNote = useMutation({
    mutationFn: () => api.crmAddNote(id, note),
    onSuccess: () => {
      setNote("");
      refresh();
    },
  });
  const [call, setCall] = useState<{ result: CallResult; minutes: string; note: string }>({
    result: "answered",
    minutes: "",
    note: "",
  });
  const addCall = useMutation({
    mutationFn: () =>
      api.crmAddCall(id, {
        result: call.result,
        durationSec: call.minutes ? Math.round(Number(call.minutes) * 60) : undefined,
        note: call.note || undefined,
      }),
    onSuccess: () => {
      setCall({ result: "answered", minutes: "", note: "" });
      refresh();
    },
  });

  return (
    <div className="space-y-4">
      <a className="text-sm text-muted-foreground hover:underline" href={href("crm/leads")}>
        ← {t("Leads")}
      </a>
      <ErrorText error={detail.error} />
      {lead && (
        <>
          <Section
            title={lead.name}
            actions={
              <a className="text-sm font-semibold text-primary" href={`tel:${lead.phone}`}>
                {lead.phone}
              </a>
            }
          >
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <StageBadge name={lead.stageName} color={lead.stageColor} />
              <Select
                value={lead.stageId}
                onChange={(e) => move.mutate(e.target.value)}
                disabled={move.isPending}
              >
                {funnel.data?.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              {staff ? (
                <Select
                  value={lead.ownerId ?? ""}
                  onChange={(e) => assign.mutate(e.target.value)}
                  disabled={assign.isPending}
                >
                  <option value="">{t("No manager")}</option>
                  {team.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-sm text-muted-foreground">{lead.ownerName}</span>
              )}
              <span className="text-xs text-muted-foreground">
                {t("Last contact")}: {lead.lastContactAt ? dateTime(lead.lastContactAt) : "—"} · {t("Added")}:{" "}
                {dateTime(lead.createdAt)}
              </span>
            </div>
            <LeadForm
              key={`${lead.name}|${lead.phone}|${lead.source}|${lead.company}`}
              id={id}
              lead={lead}
              onSaved={refresh}
            />
            <div className="mt-2">
              <ErrorText error={move.error ?? assign.error} />
            </div>
          </Section>

          <CardForm leadId={id} saved={detail.data?.values ?? {}} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={t("Calls")}>
              <form
                className="mb-4 grid gap-2 sm:grid-cols-[1fr_7rem_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  addCall.mutate();
                }}
              >
                <Select
                  value={call.result}
                  onChange={(e) => setCall({ ...call, result: e.target.value as CallResult })}
                >
                  {CALL_RESULT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  min={0}
                  step="0.5"
                  placeholder={t("Minutes")}
                  value={call.minutes}
                  onChange={(e) => setCall({ ...call, minutes: e.target.value })}
                />
                <Button disabled={addCall.isPending}>{t("Log call")}</Button>
                <Input
                  className="sm:col-span-3"
                  placeholder={t("What was said")}
                  value={call.note}
                  onChange={(e) => setCall({ ...call, note: e.target.value })}
                />
              </form>
              <ErrorText error={addCall.error} />
              {detail.data?.calls.length === 0 ? (
                <Empty>{t("No calls yet.")}</Empty>
              ) : (
                <ul className="space-y-2 text-sm">
                  {detail.data?.calls.map((c) => (
                    <li key={c.id} className="rounded-xl border border-border px-3 py-2">
                      <div className="flex flex-wrap gap-x-3">
                        <span className="font-medium">{callResultLabel(c.result)}</span>
                        {c.durationSec !== null && <span className="tabular">{duration(c.durationSec)}</span>}
                        <span className="text-muted-foreground">
                          {c.byName} · {dateTime(c.startedAt)}
                        </span>
                      </div>
                      {c.note && <div className="mt-1 text-muted-foreground">{c.note}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={t("Notes")}>
              <form
                className="mb-4 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (note.trim()) addNote.mutate();
                }}
              >
                <Input
                  className="min-w-0 flex-1"
                  placeholder={t("Write a note")}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button disabled={addNote.isPending || !note.trim()}>{t("Add")}</Button>
              </form>
              <ErrorText error={addNote.error} />
              {detail.data?.notes.length === 0 ? (
                <Empty>{t("No notes yet.")}</Empty>
              ) : (
                <ul className="space-y-2 text-sm">
                  {detail.data?.notes.map((n) => (
                    <li key={n.id} className="rounded-xl border border-border px-3 py-2">
                      <div className="whitespace-pre-wrap">{n.text}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {n.authorName} · {dateTime(n.createdAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          <Section title={t("History of stages")}>
            <ol className="space-y-1.5 text-sm">
              {detail.data?.history.map((h) => (
                <li key={h.id} className="flex flex-wrap gap-x-2">
                  <span className="tabular w-32 shrink-0 text-muted-foreground">{dateTime(h.at)}</span>
                  <span>
                    {h.fromStage ? `${h.fromStage} → ` : t("Added to") + " "}
                    <span className="font-medium">{h.toStage}</span>
                  </span>
                  <span className="text-muted-foreground">{h.byName}</span>
                </li>
              ))}
            </ol>
          </Section>
        </>
      )}
    </div>
  );
}
