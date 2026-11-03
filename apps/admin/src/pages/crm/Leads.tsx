import { type AdminView, type CrmLeadsQuery, MAX_BULK_ASSIGN } from "@platform/shared";
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
  // Leads picked for a bulk assignment (staff): by id, or "all in this list" by its filters.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [newOwner, setNewOwner] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
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
  const clearPicked = () => {
    setPicked(new Set());
    setAllMatching(false);
  };
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setOffset(0);
      clearPicked();
    };
  const total = leads.data?.total ?? 0;
  const queryClient = useQueryClient();
  const pageIds = leads.data?.leads.map((l) => l.id) ?? [];
  const pageAllPicked = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  const count = allMatching ? total : picked.size;
  const ownerName = newOwner === "none" ? "" : (team.data?.find((m) => m.id === newOwner)?.name ?? "");
  const assign = useMutation({
    mutationFn: async () => {
      const ownerId = newOwner === "none" ? null : newOwner;
      if (allMatching)
        return api.crmAssignLeads({
          ownerId,
          filter: Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)),
        });
      // One request takes at most MAX_BULK_ASSIGN ids: a bigger pick (ticked over many pages) goes in turns.
      const ids = [...picked];
      let matched = 0;
      let assigned = 0;
      for (let i = 0; i < ids.length; i += MAX_BULK_ASSIGN) {
        const part = await api.crmAssignLeads({ ownerId, ids: ids.slice(i, i + MAX_BULK_ASSIGN) });
        matched += part.matched;
        assigned += part.assigned;
      }
      return { matched, assigned };
    },
    onSuccess: (result) => {
      setNotice(
        t("{assigned} of {matched} leads changed hands.", {
          assigned: result.assigned,
          matched: result.matched,
        }),
      );
      clearPicked();
      void queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
      void queryClient.invalidateQueries({ queryKey: ["crm-funnel"] });
      // A lead's own page shows its manager too: do not show the old one from the cache.
      void queryClient.invalidateQueries({ queryKey: ["crm-lead"] });
    },
  });
  // No ticking while the rows are the old page's (a new search is loading), while an assignment is on its way (what is ticked is
  // what it takes), or when "all N in this list" is chosen (that is one choice: clear it to pick rows).
  const frozen = leads.isPlaceholderData || assign.isPending;
  const togglePage = () => {
    const next = new Set(picked);
    for (const id of pageIds) {
      if (pageAllPicked) next.delete(id);
      else next.add(id);
    }
    setPicked(next);
    setAllMatching(false);
  };
  const toggleOne = (id: string) => {
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    setPicked(next);
    setAllMatching(false);
  };
  const doAssign = () => {
    const question =
      newOwner === "none"
        ? t("Take {n} leads back from their managers?", { n: count })
        : t("Give {n} leads to {name}?", { n: count, name: ownerName });
    if (window.confirm(question)) assign.mutate();
  };
  const selecting = staff && !compact;

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
      {selecting && count > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
          <span className="font-medium">
            {allMatching
              ? t("All {total} leads in this list are selected", { total })
              : t("{n} selected", { n: count })}
          </span>
          {!allMatching && pageAllPicked && total > pageIds.length && (
            <button type="button" className="text-primary underline" onClick={() => setAllMatching(true)}>
              {t("Select all {total} leads in this list", { total })}
            </button>
          )}
          <button type="button" className="text-muted-foreground underline" onClick={clearPicked}>
            {t("Clear selection")}
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select value={newOwner} onChange={(e) => setNewOwner(e.target.value)}>
              <option value="">{t("Choose a manager")}</option>
              <option value="none">{t("No manager")}</option>
              {team.data?.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <Button disabled={!newOwner || assign.isPending} onClick={doAssign}>
              {t("Assign")}
            </Button>
          </div>
        </div>
      )}
      {notice && <div className="mb-2 text-sm text-success">{notice}</div>}
      <ErrorText error={leads.error ?? exportFile.error ?? assign.error} />
      {leads.data && leads.data.leads.length === 0 ? (
        <Empty>{t("No leads yet.")}</Empty>
      ) : (
        <Table
          head={[
            ...(selecting
              ? [
                  <input
                    key="pick"
                    type="checkbox"
                    aria-label={t("Select all leads on this page")}
                    checked={allMatching || pageAllPicked}
                    disabled={allMatching || frozen}
                    onChange={togglePage}
                  />,
                ]
              : []),
            t("Name"),
            t("Phone"),
            t("Stage"),
            t("Source"),
            t("Manager"),
            t("Last contact"),
            t("Added"),
          ]}
        >
          {leads.data?.leads.map((l) => (
            <tr key={l.id}>
              {selecting && (
                <Td>
                  <input
                    type="checkbox"
                    aria-label={t("Select lead")}
                    checked={allMatching || picked.has(l.id)}
                    disabled={allMatching || frozen}
                    onChange={() => toggleOne(l.id)}
                  />
                </Td>
              )}
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
