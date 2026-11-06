/**
 * Import of leads from a sheet (docs/crm.md §6): the first row is the header; the columns are matched to the CRM's fields by
 * their names (in Uzbek, Russian or English), the ones that match nothing are left out; a broken row (a bad phone number) is
 * written down with its number and the reason and does not stop the rest. A phone that is already a lead updates that lead.
 */
import type { CrmImportError, CrmImportJobView } from "@platform/shared";
import { desc, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { admins, crmImportJobs, crmLeads, crmNotes, crmStageHistory } from "../db/schema.js";
import { type Crm, type CrmActor, seesAll } from "./service.js";
import { firstPhone } from "./phone.js";

type Field = "name" | "phone" | "source" | "company" | "note" | "stage";

/**
 * What a column's title may say, in Uzbek (Latin and Cyrillic), Russian and English. A title matches when one of its words is one of
 * these (a short one must be the whole word, so "Telegram" is not "tel"), or starts with one of the longer ones ("telefon raqami",
 * "Номер телефона"). A title that could be two fields is the first of this list: "Mijoz telefoni" is a phone, "Company name" a company.
 */
const KEYWORDS: [Field, string[]][] = [
  [
    "phone",
    [
      "tel",
      "тел",
      "phone",
      "telefon",
      "mobil",
      "mobile",
      "cell",
      "raqam",
      "nomer",
      "номер",
      "телефон",
      "мобил",
      "рақам",
      "раками",
    ],
  ],
  ["source", ["manba", "source", "channel", "kanal", "канал", "источник", "манба"]],
  [
    "company",
    [
      "kompaniya",
      "company",
      "firma",
      "tashkilot",
      "korxona",
      "organization",
      "organisation",
      "компания",
      "организация",
      "фирма",
      "ташкилот",
      "корхона",
    ],
  ],
  [
    "note",
    [
      "izoh",
      "note",
      "notes",
      "comment",
      "comments",
      "komment",
      "eslatma",
      "изох",
      "эслатма",
      "примечание",
      "комментарий",
      "заметка",
      "заметки",
    ],
  ],
  ["stage", ["bosqich", "stage", "status", "holat", "статус", "этап", "стадия", "босқич", "холат"]],
  [
    "name",
    [
      "ism",
      "ismi",
      "исм",
      "name",
      "fio",
      "fish",
      "full",
      "client",
      "customer",
      "mijoz",
      "contact",
      "kontakt",
      "kim",
      "ким",
      "мижоз",
      "имя",
      "фио",
      "клиент",
      "контакт",
      "фамилия",
      "familiya",
    ],
  ],
];

const normalizeHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function fieldOf(title: string): Field | null {
  const words = normalizeHeader(title).split(" ").filter(Boolean);
  // "Ф.И.О." and "F.I.O." are three one-letter words: put together they are the title "фио".
  const joined = words.join("");
  for (const [field, stems] of KEYWORDS)
    if (
      stems.includes(joined) ||
      words.some((w) => stems.some((stem) => (stem.length <= 3 ? w === stem : w.startsWith(stem))))
    )
      return field;
  return null;
}

export interface Columns {
  fields: Map<Field, number>;
  mapped: { column: string; field: string }[];
  ignored: string[];
}

/**
 * Which sheet column feeds which field: the first column that matches a field's title wins. A column with no title but with data in
 * it (the notes someone wrote beside a list) becomes the notes when no column is titled so. `body` is the rows under the header.
 */
export function mapColumns(header: string[], body: string[][] = []): Columns {
  const fields = new Map<Field, number>();
  const mapped: { column: string; field: string }[] = [];
  const ignored: string[] = [];
  header.forEach((raw, index) => {
    const column = raw.trim();
    if (!column) return;
    const field = fieldOf(column);
    if (field && !fields.has(field)) {
      fields.set(field, index);
      mapped.push({ column, field });
    } else ignored.push(column);
  });
  if (!fields.has("note")) {
    const width = Math.max(header.length, ...body.map((r) => r.length));
    let untitled = -1;
    for (let i = 0; i < width && untitled < 0; i++)
      if (!(header[i] ?? "").trim() && body.some((r) => (r[i] ?? "").trim() !== "")) untitled = i;
    if (untitled >= 0) {
      fields.set("note", untitled);
      mapped.push({ column: "—", field: "note" });
    }
  }
  return { fields, mapped, ignored };
}

/**
 * The header is the first row (of the first 30) with a phone column: lists often have a title or an empty row above it. When none
 * has, the first row with anything in it is reported (for the message). `index` is the row's place in `rows`.
 */
export function findHeader(rows: string[][]): { index: number; columns: Columns } {
  const limit = Math.min(rows.length, 30);
  let firstFilled = -1;
  for (let i = 0; i < limit; i++) {
    const row = rows[i] ?? [];
    if (row.every((c) => !c.trim())) continue;
    if (firstFilled < 0) firstFilled = i;
    const columns = mapColumns(row, rows.slice(i + 1));
    if (columns.fields.has("phone")) return { index: i, columns };
  }
  const index = Math.max(firstFilled, 0);
  return { index, columns: mapColumns(rows[index] ?? [], rows.slice(index + 1)) };
}

const MAX_ERRORS = 200;

interface Prepared {
  row: number;
  name: string;
  phone: { display: string; key: string };
  source: string | null;
  company: string | null;
  notes: string[];
  stageName: string | null;
}

type JobRow = typeof crmImportJobs.$inferSelect;

export function jobView(job: JobRow, createdByName: string | null): CrmImportJobView {
  const columns = job.columns as { mapped?: { column: string; field: string }[]; ignored?: string[] };
  return {
    id: job.id,
    source: job.source,
    fileName: job.fileName,
    status: job.status,
    rowsTotal: job.rowsTotal,
    rowsCreated: job.rowsCreated,
    rowsUpdated: job.rowsUpdated,
    rowsFailed: job.rowsFailed,
    errors: job.errors as CrmImportError[],
    mapped: columns.mapped ?? [],
    ignored: columns.ignored ?? [],
    failure: job.failure,
    createdByName,
    createdAt: job.createdAt.toISOString(),
  };
}

export class CrmImport {
  constructor(
    private readonly db: Db,
    private readonly crm: Crm,
  ) {}

  async jobs(actor: CrmActor, limit = 20): Promise<CrmImportJobView[]> {
    const rows = await this.db
      .select({ job: crmImportJobs, name: admins.name })
      .from(crmImportJobs)
      .leftJoin(admins, eq(admins.id, crmImportJobs.createdBy))
      .where(seesAll(actor) ? undefined : eq(crmImportJobs.createdBy, actor.id))
      .orderBy(desc(crmImportJobs.createdAt))
      .limit(limit);
    return rows.map((r) => jobView(r.job, r.name));
  }

  /** Imports the rows (row 0 is the header). Always answers with the finished job: a bad file is a failed job, not an error. */
  async run(
    actor: CrmActor,
    source: "excel" | "google_sheet",
    fileName: string,
    rows: string[][],
  ): Promise<CrmImportJobView> {
    const [job] = await this.db
      .insert(crmImportJobs)
      .values({ source, fileName, createdBy: actor.id })
      .returning();
    if (!job) throw new Error("The import job was not saved");
    const me = await this.db.query.admins.findFirst({ where: eq(admins.id, actor.id) });
    const finish = async (set: Partial<typeof crmImportJobs.$inferInsert>) => {
      const [done] = await this.db
        .update(crmImportJobs)
        .set(set)
        .where(eq(crmImportJobs.id, job.id))
        .returning();
      return jobView(done ?? job, me?.name ?? null);
    };

    try {
      const { index: headerRow, columns: found } = findHeader(rows);
      const { fields, mapped, ignored } = found;
      const columns = { mapped, ignored };
      if (!fields.has("phone")) {
        const seen = (rows[headerRow] ?? []).map((c) => c.trim()).filter(Boolean);
        return await finish({
          status: "failed",
          columns,
          failure: `No column with phone numbers was found: name it Telefon, Phone or Телефон. The columns seen: ${seen.join(", ") || "none"}`,
        });
      }

      const stages = await this.crm.stageIdsByName();
      const first = await this.crm.firstStage();
      const errors: CrmImportError[] = [];
      let failed = 0;
      let total = 0;
      const prepared = new Map<string, Prepared>();
      let updatedInFile = 0;
      const cell = (row: string[], f: Field) => {
        const index = fields.get(f);
        return index === undefined ? "" : (row[index] ?? "").trim();
      };
      const fail = (row: number, reason: string) => {
        failed += 1;
        if (errors.length < MAX_ERRORS) errors.push({ row, reason });
      };
      const used = [...fields.values()];
      for (let i = headerRow + 1; i < rows.length; i++) {
        const row = rows[i] ?? [];
        // A row with nothing in the columns that are used is not a row (a list numbered far below its last entry).
        if (used.every((index) => !(row[index] ?? "").trim())) continue;
        total += 1;
        const rawPhone = cell(row, "phone");
        if (!rawPhone) {
          fail(i + 1, "The phone number is empty");
          continue;
        }
        const phone = firstPhone(rawPhone);
        if (!phone) {
          fail(i + 1, `The phone number is not valid: ${rawPhone.slice(0, 40)}`);
          continue;
        }
        // A stage that is not one of the funnel's is not an error: such a column is often a status of someone else's.
        const stageText = cell(row, "stage");
        const stageName = stages.has(stageText.toLowerCase()) ? stageText : "";
        // The same number twice in one file: the later row adds to the earlier one (what it leaves empty stays).
        const before = prepared.get(phone.key);
        if (before) updatedInFile += 1;
        const note = cell(row, "note").slice(0, 2000);
        prepared.set(phone.key, {
          row: i + 1,
          name: cell(row, "name").slice(0, 120) || before?.name || phone.display,
          phone,
          source: cell(row, "source").slice(0, 60) || before?.source || null,
          company: cell(row, "company").slice(0, 120) || before?.company || null,
          notes: [...(before?.notes ?? []), ...(note ? [note] : [])],
          stageName: stageName || before?.stageName || null,
        });
      }

      const existing = await this.crm.leadsByPhoneKeys([...prepared.keys()]);
      let created = 0;
      let updated = updatedInFile;
      const fresh: Prepared[] = [];
      for (const p of prepared.values()) {
        const lead = existing.get(p.phone.key);
        if (!lead) {
          fresh.push(p);
          continue;
        }
        if (!seesAll(actor) && lead.ownerId !== null && lead.ownerId !== actor.id) {
          fail(p.row, "This phone number is with another manager");
          continue;
        }
        await this.db
          .update(crmLeads)
          .set({
            name: p.name === p.phone.display ? lead.name : p.name,
            source: p.source ?? lead.source,
            company: p.company ?? lead.company,
            ownerId: lead.ownerId ?? (seesAll(actor) ? null : actor.id),
            updatedAt: new Date(),
          })
          .where(eq(crmLeads.id, lead.id));
        if (p.notes.length)
          await this.db
            .insert(crmNotes)
            .values(p.notes.map((text) => ({ leadId: lead.id, authorId: actor.id, text })));
        updated += 1;
      }
      for (let i = 0; i < fresh.length; i += 500) {
        const part = fresh.slice(i, i + 500);
        // Staff's new leads go to the sales managers in turn; a manager's own import stays with the manager.
        const owners = seesAll(actor) ? await this.crm.nextOwners(part.length) : [];
        const inserted = await this.db
          .insert(crmLeads)
          .values(
            part.map((p, n) => ({
              pipelineId: first.pipelineId,
              stageId: (p.stageName ? stages.get(p.stageName.toLowerCase())?.id : undefined) ?? first.id,
              name: p.name,
              phone: p.phone.display,
              phoneKey: p.phone.key,
              source: p.source,
              company: p.company,
              ownerId: seesAll(actor) ? (owners[n] ?? null) : actor.id,
              createdBy: actor.id,
            })),
          )
          .onConflictDoNothing({ target: crmLeads.phoneKey })
          .returning({ id: crmLeads.id, phoneKey: crmLeads.phoneKey, stageId: crmLeads.stageId });
        created += inserted.length;
        const byKey = new Map(part.map((p) => [p.phone.key, p]));
        if (inserted.length)
          await this.db
            .insert(crmStageHistory)
            .values(inserted.map((l) => ({ leadId: l.id, toStageId: l.stageId, byAdminId: actor.id })));
        const notes = inserted.flatMap((l) =>
          (byKey.get(l.phoneKey)?.notes ?? []).map((text) => ({ leadId: l.id, authorId: actor.id, text })),
        );
        if (notes.length) await this.db.insert(crmNotes).values(notes);
        for (const p of part)
          if (!inserted.some((l) => l.phoneKey === p.phone.key))
            fail(p.row, "The lead was added by someone else a moment ago");
      }
      return await finish({
        status: "done",
        columns,
        rowsTotal: total,
        rowsCreated: created,
        rowsUpdated: updated,
        rowsFailed: failed,
        errors,
      });
    } catch (error) {
      return finish({
        status: "failed",
        failure: error instanceof Error ? error.message.slice(0, 300) : "The import failed",
      });
    }
  }
}
