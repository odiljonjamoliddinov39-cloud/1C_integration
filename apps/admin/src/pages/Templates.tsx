import {
  type AdminView,
  QueryTemplateInput,
  type QueryTemplateView,
  type TemplateColumn,
  type TemplateParam,
} from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "@/lib/i18n";

import { Badge, Button, Card, Empty, ErrorText, Input, Section, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";

const FORMATS = ["text", "money", "number", "date"];
const PARAM_TYPES = ["date", "month_start", "month_end", "text", "number", "counterparty"];

/** Known questions answered by a fixed 1C query, without the model. */
export function TemplatesPage({ me }: { me: AdminView }) {
  const templates = useQuery({ queryKey: ["query-templates"], queryFn: api.queryTemplates });
  const groups = useQuery({ queryKey: ["template-groups"], queryFn: api.templateGroups });
  const analyze = useMutation({
    mutationFn: api.runEngine,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["template-groups"] });
      await queryClient.invalidateQueries({ queryKey: ["query-templates"] });
    },
  });
  const [editing, setEditing] = useState<QueryTemplateView | "new" | null>(null);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteQueryTemplate(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["query-templates"] }),
  });
  const owner = me.role === "owner";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("Query templates")}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {t(
              'A question the app recognizes is answered by a fixed 1C query, with no AI and no cost. Templates are learned automatically from the questions your customers ask (see below), and you can also write them by hand. The matcher compares words, answers only when the question is no longer than the phrase plus its parameters, and every answer has an "Ask AI anyway" button. Look over what was learned, and turn off a template that looks wrong.',
            )}
          </p>
        </div>
        {owner && (
          <Button className="ml-auto" onClick={() => setEditing("new")}>
            {t("New template")}
          </Button>
        )}
      </div>
      <ErrorText error={templates.error ?? remove.error} />
      {editing && (
        <TemplateForm
          key={editing === "new" ? "new" : editing.id + editing.version}
          template={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <Card>
        {templates.data?.length === 0 ? (
          <Empty>{t("No templates yet. Every question goes to the model.")}</Empty>
        ) : (
          <Table
            head={[
              t("Code"),
              t("Title"),
              t("Phrases"),
              t("For"),
              t("Used to learn"),
              t("Version"),
              t("State"),
              t("Changed"),
              "",
            ]}
          >
            {templates.data?.map((row) => (
              <tr key={row.id}>
                <Td className="font-mono text-xs">{row.code}</Td>
                <Td>{row.title}</Td>
                <Td className="max-w-xs truncate">{row.intents.join(" · ")}</Td>
                <Td>
                  {row.source === "learned" ? (
                    <span title={t("Learned from this company's own questions")}>
                      {row.accountName} · {row.company}
                    </span>
                  ) : (
                    t("Everyone")
                  )}
                </Td>
                <Td>{row.source === "learned" ? row.hits : "—"}</Td>
                <Td>{row.version}</Td>
                <Td>
                  {row.enabled ? (
                    <Badge tone="success">{t("On")}</Badge>
                  ) : row.rejected > 0 ? (
                    <Badge tone="warning">{t("Off: rejected by a user")}</Badge>
                  ) : (
                    <Badge>{t("Off")}</Badge>
                  )}
                </Td>
                <Td>{relative(row.updatedAt)}</Td>
                <Td className="space-x-2 text-right">
                  {owner && (
                    <>
                      <Button variant="outline" onClick={() => setEditing(row)}>
                        {t("Edit")}
                      </Button>
                      <Button
                        variant="danger"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(t("Delete the template {code}?", { code: row.code })))
                            remove.mutate(row.id);
                        }}
                      >
                        {t("Delete")}
                      </Button>
                    </>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card>
        <div className="flex items-start gap-3 border-b border-border px-4 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">{t("What the engine is learning")}</h2>
            <p className="text-xs text-muted-foreground">
              {t(
                'Every finished question leaves a trace (the steps, no data). Questions answered by the same query form a group; once a group has been seen as many times as the AI limits page says, Claude decides whether it is one reusable question and writes the template. A card confirmed by the user whose documents were exactly the query\'s rows becomes an action template: it still asks for confirmation. A user pressing "Ask AI anyway" turns a learned template off.',
              )}
            </p>
          </div>
          {owner && (
            <Button
              className="ml-auto shrink-0"
              variant="outline"
              disabled={analyze.isPending}
              onClick={() => analyze.mutate()}
            >
              {t("Analyze now")}
            </Button>
          )}
        </div>
        {analyze.data && (
          <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
            {t("Decided {decided} group(s), made {made} template(s).", {
              decided: analyze.data.decided,
              made: analyze.data.made,
            })}
          </p>
        )}
        <ErrorText error={groups.error ?? analyze.error} />
        {groups.data?.length === 0 ? (
          <Empty>{t("Nothing yet. It starts with the next questions your customers ask.")}</Empty>
        ) : (
          <Table
            head={[
              t("Customer"),
              t("Company"),
              t("Latest question"),
              t("Does"),
              t("Seen"),
              t("State"),
              t("Claude's reason"),
            ]}
          >
            {groups.data?.map((g, i) => (
              <tr key={i}>
                <Td>{g.accountName}</Td>
                <Td>{g.company}</Td>
                <Td className="max-w-xs truncate" title={g.question}>
                  {g.question}
                </Td>
                <Td>{g.action ? t("Prepares a card") : t("Answers")}</Td>
                <Td>{g.hits}</Td>
                <Td>
                  {g.status === "accepted" ? (
                    <Badge tone="success">{t("Template made")}</Badge>
                  ) : g.status === "rejected" ? (
                    <Badge tone="warning">{t("Not reusable")}</Badge>
                  ) : (
                    <Badge>{t("Waiting")}</Badge>
                  )}
                </Td>
                <Td className="max-w-xs truncate" title={g.reason}>
                  {g.reason}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/** "Name:type" per line, e.g. "ДатаОстатка:date". */
const paramsText = (params: TemplateParam[]) => params.map((p) => `${p.name}:${p.type}`).join("\n");
/** "Label|format" per line, e.g. "Сумма|money". */
const columnsText = (columns: TemplateColumn[]) => columns.map((c) => `${c.label}|${c.format}`).join("\n");
const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function TemplateForm({ template, onClose }: { template: QueryTemplateView | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState(template?.code ?? "");
  const [title, setTitle] = useState(template?.title ?? "");
  const [intents, setIntents] = useState((template?.intents ?? []).join("\n"));
  const [query, setQuery] = useState(template?.query ?? "");
  const [params, setParams] = useState(paramsText(template?.params ?? []));
  const [columns, setColumns] = useState(columnsText(template?.columns ?? []));
  const [totals, setTotals] = useState(template?.totals ?? false);
  const [enabled, setEnabled] = useState(template?.enabled ?? true);

  const parsed = QueryTemplateInput.safeParse({
    code,
    title,
    intents: lines(intents),
    query,
    params: lines(params).map((line) => {
      const [name = "", type = ""] = line.split(":").map((s) => s.trim());
      return { name, type };
    }),
    columns: lines(columns).map((line) => {
      const [label = "", format = "text"] = line.split("|").map((s) => s.trim());
      return { label, format: format || "text" };
    }),
    totals,
    enabled,
  });
  const save = useMutation({
    mutationFn: (input: QueryTemplateInput) => api.saveQueryTemplate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["query-templates"] });
      onClose();
    },
  });
  return (
    <Section
      title={template ? t("Edit {code}", { code: template.code }) : t("New template")}
      actions={
        <Button variant="ghost" onClick={onClose}>
          {t("Close")}
        </Button>
      }
    >
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed.success) save.mutate(parsed.data);
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1">
            <div>{t("Code (a–z, 0–9, _)")}</div>
            <Input value={code} disabled={template !== null} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label className="min-w-64 flex-1 space-y-1">
            <div>{t("Title")}</div>
            <Input className="w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
        <label className="block space-y-1">
          <div>{t("Phrases that ask it, one per line, in any language")}</div>
          <textarea
            className="min-h-20 w-full rounded-lg border border-border bg-card p-2 text-sm"
            value={intents}
            onChange={(e) => setIntents(e.target.value)}
            placeholder={"остаток денег в кассе\nkassadagi qoldiq"}
          />
        </label>
        <label className="block space-y-1">
          <div>{t("1C query (it only reads; its columns are the result columns, in order)")}</div>
          <textarea
            className="min-h-32 w-full rounded-lg border border-border bg-card p-2 font-mono text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block space-y-1">
            <div>
              {t(
                "&Parameters, one per line as name:type ({types}). month_end is the month's last day: use КОНЕЦПЕРИОДА(&Name, ДЕНЬ) in the query.",
                { types: PARAM_TYPES.join(", ") },
              )}
            </div>
            <textarea
              className="min-h-20 w-full rounded-lg border border-border bg-card p-2 font-mono text-xs"
              value={params}
              onChange={(e) => setParams(e.target.value)}
              placeholder={t("ДатаОстатка:date")}
            />
          </label>
          <label className="block space-y-1">
            <div>
              {t("Result columns, one per line as label|format ({formats})", { formats: FORMATS.join(", ") })}
            </div>
            <textarea
              className="min-h-20 w-full rounded-lg border border-border bg-card p-2 font-mono text-xs"
              value={columns}
              onChange={(e) => setColumns(e.target.value)}
              placeholder={"Счёт|text\nСумма|money"}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={totals} onChange={(e) => setTotals(e.target.checked)} />
            {t("Totals row")}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t("On")}
          </label>
          <Button disabled={!parsed.success || save.isPending}>{t("Save")}</Button>
          {!parsed.success && (
            <span className="text-destructive">
              {parsed.error.issues[0]?.path.join(".")}: {parsed.error.issues[0]?.message}
            </span>
          )}
        </div>
      </form>
      <ErrorText error={save.error} />
    </Section>
  );
}
