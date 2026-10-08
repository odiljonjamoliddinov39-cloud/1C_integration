import {
  type AdminView,
  QueryTemplateInput,
  type QueryTemplateView,
  type TemplateColumn,
  type TemplateParam,
} from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge, Button, Card, Empty, ErrorText, Input, Section, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";

const FORMATS = ["text", "money", "number", "date"];
const PARAM_TYPES = ["date", "month_start", "month_end", "text", "number"];

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
          <h1 className="text-xl font-semibold">Query templates</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            A question the app recognizes is answered by a fixed 1C query, with no AI and no cost. Templates
            are learned automatically from the questions your customers ask (see below), and you can also
            write them by hand. The matcher compares words, answers only when the question is no longer than
            the phrase plus its parameters, and every answer has an &quot;Ask AI anyway&quot; button. Look
            over what was learned, and turn off a template that looks wrong.
          </p>
        </div>
        {owner && (
          <Button className="ml-auto" onClick={() => setEditing("new")}>
            New template
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
          <Empty>No templates yet. Every question goes to the model.</Empty>
        ) : (
          <Table
            head={["Code", "Title", "Phrases", "For", "Used to learn", "Version", "State", "Changed", ""]}
          >
            {templates.data?.map((t) => (
              <tr key={t.id}>
                <Td className="font-mono text-xs">{t.code}</Td>
                <Td>{t.title}</Td>
                <Td className="max-w-xs truncate">{t.intents.join(" · ")}</Td>
                <Td>
                  {t.source === "learned" ? (
                    <span title="Learned from this company's own questions">
                      {t.accountName} · {t.company}
                    </span>
                  ) : (
                    "Everyone"
                  )}
                </Td>
                <Td>{t.source === "learned" ? t.hits : "—"}</Td>
                <Td>{t.version}</Td>
                <Td>
                  {t.enabled ? (
                    <Badge tone="success">On</Badge>
                  ) : t.rejected > 0 ? (
                    <Badge tone="warning">Off: rejected by a user</Badge>
                  ) : (
                    <Badge>Off</Badge>
                  )}
                </Td>
                <Td>{relative(t.updatedAt)}</Td>
                <Td className="space-x-2 text-right">
                  {owner && (
                    <>
                      <Button variant="outline" onClick={() => setEditing(t)}>
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete the template ${t.code}?`)) remove.mutate(t.id);
                        }}
                      >
                        Delete
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
            <h2 className="text-sm font-semibold">What the engine is learning</h2>
            <p className="text-xs text-muted-foreground">
              Every finished question leaves a trace (the steps, no data). Questions answered by the same
              query form a group; once a group has been seen as many times as the AI limits page says, Claude
              decides whether it is one reusable question and writes the template. A card confirmed by the
              user whose documents were exactly the query&apos;s rows becomes an action template: it still
              asks for confirmation. A user pressing &quot;Ask AI anyway&quot; turns a learned template off.
            </p>
          </div>
          {owner && (
            <Button
              className="ml-auto shrink-0"
              variant="outline"
              disabled={analyze.isPending}
              onClick={() => analyze.mutate()}
            >
              Analyze now
            </Button>
          )}
        </div>
        {analyze.data && (
          <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
            Decided {analyze.data.decided} group(s), made {analyze.data.made} template(s).
          </p>
        )}
        <ErrorText error={groups.error ?? analyze.error} />
        {groups.data?.length === 0 ? (
          <Empty>Nothing yet. It starts with the next questions your customers ask.</Empty>
        ) : (
          <Table
            head={["Customer", "Company", "Latest question", "Does", "Seen", "State", "Claude's reason"]}
          >
            {groups.data?.map((g, i) => (
              <tr key={i}>
                <Td>{g.accountName}</Td>
                <Td>{g.company}</Td>
                <Td className="max-w-xs truncate" title={g.question}>
                  {g.question}
                </Td>
                <Td>{g.action ? "Prepares a card" : "Answers"}</Td>
                <Td>{g.hits}</Td>
                <Td>
                  {g.status === "accepted" ? (
                    <Badge tone="success">Template made</Badge>
                  ) : g.status === "rejected" ? (
                    <Badge tone="warning">Not reusable</Badge>
                  ) : (
                    <Badge>Waiting</Badge>
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
      title={template ? `Edit ${template.code}` : "New template"}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
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
            <div>Code (a–z, 0–9, _)</div>
            <Input value={code} disabled={template !== null} onChange={(e) => setCode(e.target.value)} />
          </label>
          <label className="min-w-64 flex-1 space-y-1">
            <div>Title</div>
            <Input className="w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
        <label className="block space-y-1">
          <div>Phrases that ask it, one per line, in any language</div>
          <textarea
            className="min-h-20 w-full rounded-lg border border-border bg-card p-2 text-sm"
            value={intents}
            onChange={(e) => setIntents(e.target.value)}
            placeholder={"остаток денег в кассе\nkassadagi qoldiq"}
          />
        </label>
        <label className="block space-y-1">
          <div>1C query (it only reads; its columns are the result columns, in order)</div>
          <textarea
            className="min-h-32 w-full rounded-lg border border-border bg-card p-2 font-mono text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block space-y-1">
            <div>
              &amp;Parameters, one per line as name:type ({PARAM_TYPES.join(", ")}). month_end is the
              month&apos;s last day: use КОНЕЦПЕРИОДА(&amp;Name, ДЕНЬ) in the query.
            </div>
            <textarea
              className="min-h-20 w-full rounded-lg border border-border bg-card p-2 font-mono text-xs"
              value={params}
              onChange={(e) => setParams(e.target.value)}
              placeholder="ДатаОстатка:date"
            />
          </label>
          <label className="block space-y-1">
            <div>Result columns, one per line as label|format ({FORMATS.join(", ")})</div>
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
            Totals row
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            On
          </label>
          <Button disabled={!parsed.success || save.isPending}>Save</Button>
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
