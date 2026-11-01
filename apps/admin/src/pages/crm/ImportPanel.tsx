import type { CrmImportJobView } from "@platform/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { Badge, Button, ErrorText, Input, Table, Td } from "@/components/ui";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

/** The file a person may upload: about 5 MB (it travels inside JSON as base64). */
const MAX_FILE = 5 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** What one import did: the counts, the columns that were used and left out, and the rows that failed with the reason. */
export function ImportResult({ job }: { job: CrmImportJobView }) {
  return (
    <div className="space-y-2 rounded-xl border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={job.status === "done" ? "success" : "danger"}>
          {job.status === "done" ? t("Imported") : t("Failed")}
        </Badge>
        <span className="font-medium">{job.fileName}</span>
        <span className="text-muted-foreground">{dateTime(job.createdAt)}</span>
      </div>
      {job.failure && <div className="text-destructive">{job.failure}</div>}
      {job.status === "done" && (
        <div className="tabular flex flex-wrap gap-x-5 gap-y-1">
          <span>{t("Rows: {n}", { n: job.rowsTotal })}</span>
          <span>{t("New: {n}", { n: job.rowsCreated })}</span>
          <span>{t("Updated: {n}", { n: job.rowsUpdated })}</span>
          <span className={job.rowsFailed ? "font-semibold text-destructive" : ""}>
            {t("Failed rows: {n}", { n: job.rowsFailed })}
          </span>
        </div>
      )}
      {job.mapped.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {t("Columns used")}: {job.mapped.map((m) => `${m.column} → ${m.field}`).join(", ")}
          {job.ignored.length > 0 && (
            <>
              {" · "}
              {t("Left out")}: {job.ignored.join(", ")}
            </>
          )}
        </div>
      )}
      {job.errors.length > 0 && (
        <Table head={[t("Row"), t("Why it failed")]}>
          {job.errors.map((e) => (
            <tr key={`${e.row}-${e.reason}`}>
              <Td className="w-20">{e.row}</Td>
              <Td>{e.reason}</Td>
            </tr>
          ))}
        </Table>
      )}
      {job.rowsFailed > job.errors.length && (
        <div className="text-xs text-muted-foreground">
          {t("Only the first {n} failed rows are listed.", { n: job.errors.length })}
        </div>
      )}
    </div>
  );
}

/** Import from an .xlsx file or from a Google Sheet's link, with the history of imports. */
export function ImportPanel() {
  const queryClient = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [last, setLast] = useState<CrmImportJobView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const google = useQuery({ queryKey: ["crm-google"], queryFn: api.crmGoogle });
  const jobs = useQuery({ queryKey: ["crm-import-jobs"], queryFn: api.crmImportJobs });
  const done = (job: CrmImportJobView) => {
    setLast(job);
    setProblem(null);
    void queryClient.invalidateQueries({ queryKey: ["crm-import-jobs"] });
    void queryClient.invalidateQueries({ queryKey: ["crm-leads"] });
    void queryClient.invalidateQueries({ queryKey: ["crm-funnel"] });
  };
  const upload = useMutation({
    mutationFn: async (f: File) => {
      if (f.size > MAX_FILE) throw new Error(t("The file is over 5 MB"));
      return api.crmImportFile({
        fileName: f.name,
        dataBase64: toBase64(new Uint8Array(await f.arrayBuffer())),
      });
    },
    onSuccess: done,
  });
  const sheet = useMutation({ mutationFn: () => api.crmImportSheet(url.trim()), onSuccess: done });
  const busy = upload.isPending || sheet.isPending;
  const previous = (jobs.data ?? []).filter((j) => j.id !== last?.id);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t(
          "The first row is the header. The columns are matched to the fields by their names (Ism, Telefon, Manba, Kompaniya, Izoh…); the ones that match nothing are left out. A lead whose phone is already here is updated.",
        )}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="text-sm font-semibold">{t("Excel file")}</div>
          <input
            ref={file}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = "";
            }}
          />
          <Button variant="outline" disabled={busy} onClick={() => file.current?.click()}>
            {upload.isPending ? t("Importing…") : t("Choose an .xlsx file")}
          </Button>
          <ErrorText error={upload.error} />
        </div>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) sheet.mutate();
          }}
        >
          <div className="text-sm font-semibold">{t("Google Sheets")}</div>
          {google.data?.enabled ? (
            <>
              <div className="flex gap-2">
                <Input
                  className="min-w-0 flex-1"
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <Button disabled={busy || !url.trim()}>
                  {sheet.isPending ? t("Importing…") : t("Import")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Share the sheet (read only) with {email}, then paste its link. It is read once, not kept in sync.",
                  {
                    email: google.data.serviceEmail ?? "",
                  },
                )}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("Google Sheets is not set up on this server (no service account).")}
            </p>
          )}
          <ErrorText error={sheet.error} />
        </form>
      </div>
      <ErrorText error={problem} />
      {last && <ImportResult job={last} />}
      {previous.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">{t("Earlier imports")}</summary>
          <div className="mt-2 space-y-2">
            {previous.slice(0, 10).map((j) => (
              <ImportResult key={j.id} job={j} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
