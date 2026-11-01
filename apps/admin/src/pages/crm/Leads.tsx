import type { AdminView, CrmLeadsQuery } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Empty, ErrorText, Input, Section, Select, Table, Td } from "@/components/ui";
import { api, downloadFile, leadParams } from "@/lib/api";
import { date } from "@/lib/format";
import { getLocale, t } from "@/lib/i18n";
import { href } from "@/lib/router";
import { StageBadge, leadLink, useDebounced } from "./common";
import { ImportPanel } from "./ImportPanel";

const PAGE = 50;

/** The leads, with a search and the filters; `compact` (the reports' customers table) leaves out adding and importing. */
export function LeadsTable({ me, compact = false }: { me: AdminView; compact?: boolean }) {
  const staff = me.role !== "manager";
  const [q, setQ] = useState("");
  const [stageId, setStageId] = useState("");
  const [source, setSource] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [offset, setOffset] = useState(0);
  const search = useDebounced(q);
  const query: Partial<CrmLeadsQuery> = {
    q: search.trim() || undefined,
    stageId: stageId || undefined,
    source: source || undefined,
    ownerId: (ownerId || undefined) as CrmLeadsQuery["ownerId"],
  };
  const funnel = useQuery({ queryKey: ["crm-funnel"], queryFn: api.crmFunnel });
  const sources = useQuery({ queryKey: ["crm-sources"], queryFn: api.crmSources });
  const team = useQuery({ queryKey: ["crm-team"], queryFn: api.crmTeam, enabled: staff });
  const leads = useQuery({
    queryKey: ["crm-leads", query, offset],
    queryFn: () => api.crmLeads({ ...query, limit: PAGE, offset }),
    placeholderData: (previous) => previous,
  });
  const exportFile = useMutation({
    mutationFn: () =>
      downloadFile(`/leads/export.xlsx?${leadParams({ ...query })}&lang=${getLocale()}`, "leads.xlsx"),
  });
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setOffset(0);
    };
  const total = leads.data?.total ?? 0;

  return (
    <Section
      title={compact ? t("Customers table") : t("Leads")}
      actions={
        <Button variant="outline" disabled={exportFile.isPending} onClick={() => exportFile.mutate()}>
          {t("Download Excel")}
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          className="min-w-48 flex-1"
          placeholder={t("Search by name, phone or company")}
          value={q}
          onChange={(e) => reset(setQ)(e.target.value)}
        />
        <Select value={stageId} onChange={(e) => reset(setStageId)(e.target.value)}>
          <option value="">{t("All stages")}</option>
          {funnel.data?.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.leads})
            </option>
          ))}
        </Select>
        <Select value={source} onChange={(e) => reset(setSource)(e.target.value)}>
          <option value="">{t("All sources")}</option>
          {sources.data?.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        {staff && (
          <Select value={ownerId} onChange={(e) => reset(setOwnerId)(e.target.value)}>
            <option value="">{t("All managers")}</option>
            <option value="none">{t("No manager")}</option>
            {team.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <ErrorText error={leads.error ?? exportFile.error} />
      {leads.data && leads.data.leads.length === 0 ? (
        <Empty>{t("No leads yet.")}</Empty>
      ) : (
        <Table
          head={[t("Name"), t("Phone"), t("Stage"), t("Source"), t("Manager"), t("Last contact"), t("Added")]}
        >
          {leads.data?.leads.map((l) => (
            <tr key={l.id}>
              <Td>
                <a className="font-medium text-primary hover:underline" href={href(leadLink(l))}>
                  {l.name}
                </a>
                {l.company && <div className="text-xs text-muted-foreground">{l.company}</div>}
              </Td>
              <Td className="whitespace-nowrap">{l.phone}</Td>
              <Td>
                <StageBadge name={l.stageName} color={l.stageColor} />
              </Td>
              <Td>{l.source ?? "—"}</Td>
              <Td>{l.ownerName ?? "—"}</Td>
              <Td className="whitespace-nowrap">{date(l.lastContactAt)}</Td>
              <Td className="whitespace-nowrap">{date(l.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      )}
      <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
        <span className="tabular">
          {t("{from}–{to} of {total}", {
            from: total ? offset + 1 : 0,
            to: Math.min(offset + PAGE, total),
            total,
          })}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            {t("Previous")}
          </Button>
          <Button
            variant="outline"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            {t("Next")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

const BLANK = { name: "", phone: "", source: "", company: "", note: "" };

function AddLead() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(BLANK);
  const [notice, setNotice] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.crmAddLead({
        name: form.name,
        phone: form.phone,
        source: form.source || undefined,
        company: form.company || undefined,
        note: form.note || undefined,
      }),
    onSuccess: (saved) => {
      setNotice(
        saved.created ? t("Lead added.") : t("A lead with this phone already existed: it was updated."),
      );
      setForm(BLANK);
      void queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
      void queryClient.invalidateQueries({ queryKey: ["crm-funnel"] });
      void queryClient.invalidateQueries({ queryKey: ["crm-sources"] });
    },
  });
  const field = (key: keyof typeof BLANK) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
  });
  return (
    <form
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        setNotice(null);
        add.mutate();
      }}
    >
      <Input placeholder={t("Name")} required {...field("name")} />
      <Input placeholder={t("Phone")} required inputMode="tel" {...field("phone")} />
      <Input placeholder={t("Source")} {...field("source")} />
      <Input placeholder={t("Company")} {...field("company")} />
      <Button disabled={add.isPending}>{t("Add")}</Button>
      <Input className="sm:col-span-2 lg:col-span-5" placeholder={t("Note")} {...field("note")} />
      <div className="sm:col-span-2 lg:col-span-5">
        <ErrorText error={add.error} />
        {notice && <div className="text-sm text-success">{notice}</div>}
      </div>
    </form>
  );
}

/** The CRM's Leads page: the list, a quick add form and the imports. */
export function LeadsPage({ me }: { me: AdminView }) {
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant={adding ? "primary" : "outline"} onClick={() => setAdding(!adding)}>
          {t("New lead")}
        </Button>
        <Button variant={importing ? "primary" : "outline"} onClick={() => setImporting(!importing)}>
          {t("Import from Excel or Google Sheets")}
        </Button>
      </div>
      {adding && (
        <Section title={t("New lead")}>
          <AddLead />
        </Section>
      )}
      {importing && (
        <Section title={t("Import leads")}>
          <ImportPanel />
        </Section>
      )}
      <LeadsTable me={me} />
    </div>
  );
}
