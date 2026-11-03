/**
 * The CRM (docs/crm.md): the funnel, the leads and what happens to them. Two kinds of caller: staff (owner, support) see and
 * change everything; a manager sees only the leads they own. The funnel's stages are shaped by staff only.
 */
import type {
  AdminRole,
  CrmCallInput,
  CrmCallView,
  CrmHistoryView,
  CrmLeadDetail,
  CrmLeadInput,
  CrmLeadRow,
  CrmLeadSaved,
  CrmLeadUpdate,
  CrmLeadsQuery,
  CrmLeadsResponse,
  CrmManagerView,
  CrmNoteView,
  CrmPipelineView,
  CrmStageInput,
  CrmStageUpdate,
} from "@platform/shared";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  adminAudit,
  admins,
  crmCalls,
  crmLeadValues,
  crmLeads,
  crmNotes,
  crmPipelines,
  crmStageHistory,
  crmStages,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { normalizePhone } from "./phone.js";

export interface CrmActor {
  id: string;
  role: AdminRole;
}

/** Owner and support see everything; a manager only their own leads. */
export const seesAll = (actor: CrmActor) => actor.role !== "manager";

/** The source of a lead that signed up on the website. */
export const SIGNUP_SOURCE = "Sayt (ro'yxatdan o'tish)";

/** The funnel a new installation starts with; the admin reshapes it in the settings. */
export const DEFAULT_STAGES = [
  { name: "Yangi lead", color: "#3b82f6", isWon: false, isLost: false },
  { name: "Bog'lanildi", color: "#06b6d4", isWon: false, isLost: false },
  { name: "Qiziqish bildirdi", color: "#f59e0b", isWon: false, isLost: false },
  { name: "Kelishuv", color: "#8b5cf6", isWon: false, isLost: false },
  { name: "Mijoz bo'ldi", color: "#16a34a", isWon: true, isLost: false },
  { name: "Rad etildi", color: "#dc2626", isWon: false, isLost: true },
] as const;

type StageRow = typeof crmStages.$inferSelect;
type LeadRow = typeof crmLeads.$inferSelect;

type LeadListRow = Omit<CrmLeadRow, "lastContactAt" | "createdAt"> & {
  lastContactAt: Date | null;
  createdAt: Date;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class Crm {
  constructor(private readonly db: Db) {}

  // --- the funnel -----------------------------------------------------------------------------

  /** The one pipeline, made with the default stages the first time it is asked for. */
  async pipeline(): Promise<{ id: string; name: string }> {
    const found = await this.db.query.crmPipelines.findFirst({ orderBy: asc(crmPipelines.createdAt) });
    if (found) return found;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(740201)`);
      const again = await tx.query.crmPipelines.findFirst({ orderBy: asc(crmPipelines.createdAt) });
      if (again) return again;
      const [created] = await tx.insert(crmPipelines).values({ name: "Sotuv" }).returning();
      if (!created) throw new HttpError(500, "INTERNAL", "The funnel was not created");
      await tx
        .insert(crmStages)
        .values(DEFAULT_STAGES.map((s, position) => ({ ...s, pipelineId: created.id, position })));
      return created;
    });
  }

  private async stageRows(pipelineId: string, withArchived = false): Promise<StageRow[]> {
    return this.db
      .select()
      .from(crmStages)
      .where(
        and(eq(crmStages.pipelineId, pipelineId), withArchived ? undefined : eq(crmStages.archived, false)),
      )
      .orderBy(asc(crmStages.position));
  }

  /** The funnel with how many leads each stage holds now (of what the caller may see). */
  async funnel(actor: CrmActor): Promise<CrmPipelineView> {
    const pipeline = await this.pipeline();
    const stages = await this.stageRows(pipeline.id);
    const counts = await this.db
      .select({ stageId: crmLeads.stageId, n: sql<number>`count(*)::int` })
      .from(crmLeads)
      .where(this.scope(actor))
      .groupBy(crmLeads.stageId);
    const byStage = new Map(counts.map((c) => [c.stageId, c.n]));
    return {
      id: pipeline.id,
      name: pipeline.name,
      stages: stages.map((s) => ({
        id: s.id,
        name: s.name,
        position: s.position,
        color: s.color,
        isWon: s.isWon,
        isLost: s.isLost,
        leads: byStage.get(s.id) ?? 0,
      })),
    };
  }

  private requireStaff(actor: CrmActor): void {
    if (!seesAll(actor)) throw new HttpError(403, "FORBIDDEN", "Only the owner or support can do this");
  }

  async addStage(actor: CrmActor, input: CrmStageInput): Promise<CrmPipelineView> {
    this.requireStaff(actor);
    const pipeline = await this.pipeline();
    const [last] = await this.db
      .select({ max: sql<number | null>`max(${crmStages.position})` })
      .from(crmStages)
      .where(eq(crmStages.pipelineId, pipeline.id));
    const [created] = await this.db
      .insert(crmStages)
      .values({
        pipelineId: pipeline.id,
        name: input.name,
        color: input.color,
        isWon: input.isWon,
        isLost: input.isLost,
        position: (last?.max ?? -1) + 1,
      })
      .returning();
    await this.audit(actor, "crm.stage.add", `crm-stage:${created?.id}`, { name: input.name });
    return this.funnel(actor);
  }

  async updateStage(actor: CrmActor, id: string, input: CrmStageUpdate): Promise<CrmPipelineView> {
    this.requireStaff(actor);
    const stage = await this.db.query.crmStages.findFirst({ where: eq(crmStages.id, id) });
    if (!stage || stage.archived) throw new HttpError(404, "NOT_FOUND", "No such stage");
    const isWon = input.isWon ?? (input.isLost ? false : stage.isWon);
    const isLost = input.isLost ?? (input.isWon ? false : stage.isLost);
    await this.db
      .update(crmStages)
      .set({
        name: input.name ?? stage.name,
        color: input.color ?? stage.color,
        isWon,
        isLost,
      })
      .where(eq(crmStages.id, id));
    await this.audit(actor, "crm.stage.update", `crm-stage:${id}`, { ...input });
    return this.funnel(actor);
  }

  /** The new order: every stage of the funnel, once. */
  async reorderStages(actor: CrmActor, ids: string[]): Promise<CrmPipelineView> {
    this.requireStaff(actor);
    const pipeline = await this.pipeline();
    const current = await this.stageRows(pipeline.id);
    if (
      ids.length !== current.length ||
      !current.every((s) => ids.includes(s.id)) ||
      new Set(ids).size !== ids.length
    )
      throw new HttpError(400, "BAD_ORDER", "The order must list every stage once");
    await this.db.transaction(async (tx) => {
      for (const [position, stageId] of ids.entries())
        await tx.update(crmStages).set({ position }).where(eq(crmStages.id, stageId));
    });
    await this.audit(actor, "crm.stage.reorder", `crm-pipeline:${pipeline.id}`, {});
    return this.funnel(actor);
  }

  /**
   * Deletes a stage. Leads in it go to `moveTo` (required then). A stage that has history is kept, hidden: the conversions of
   * the past still need it. The funnel keeps at least one stage that is neither won nor lost.
   */
  async deleteStage(actor: CrmActor, id: string, moveTo?: string): Promise<CrmPipelineView> {
    this.requireStaff(actor);
    const pipeline = await this.pipeline();
    const stages = await this.stageRows(pipeline.id);
    const stage = stages.find((s) => s.id === id);
    if (!stage) throw new HttpError(404, "NOT_FOUND", "No such stage");
    if (!stages.some((s) => s.id !== id && !s.isWon && !s.isLost))
      throw new HttpError(409, "LAST_STAGE", "The funnel needs at least one open stage");
    const [inside] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(crmLeads)
      .where(eq(crmLeads.stageId, id));
    const target = moveTo ? stages.find((s) => s.id === moveTo && s.id !== id) : undefined;
    if ((inside?.n ?? 0) > 0 && !target)
      throw new HttpError(409, "STAGE_HAS_LEADS", "Choose the stage the leads of this stage move to");
    await this.db.transaction(async (tx) => {
      if (target) {
        const moved = await tx
          .update(crmLeads)
          .set({ stageId: target.id, updatedAt: new Date() })
          .where(eq(crmLeads.stageId, id))
          .returning({ id: crmLeads.id });
        if (moved.length)
          await tx.insert(crmStageHistory).values(
            moved.map((l) => ({
              leadId: l.id,
              fromStageId: id,
              toStageId: target.id,
              byAdminId: actor.id,
            })),
          );
      }
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(crmStageHistory)
        .where(or(eq(crmStageHistory.toStageId, id), eq(crmStageHistory.fromStageId, id)));
      if ((used?.n ?? 0) > 0) await tx.update(crmStages).set({ archived: true }).where(eq(crmStages.id, id));
      else await tx.delete(crmStages).where(eq(crmStages.id, id));
      // Close the gap in the order.
      const rest = stages.filter((s) => s.id !== id);
      for (const [position, s] of rest.entries())
        await tx.update(crmStages).set({ position }).where(eq(crmStages.id, s.id));
    });
    await this.audit(actor, "crm.stage.delete", `crm-stage:${id}`, { name: stage.name, moveTo: target?.id });
    return this.funnel(actor);
  }

  // --- leads ----------------------------------------------------------------------------------

  /** What the caller may see: everything for staff, the own leads for a manager. */
  scope(actor: CrmActor): SQL | undefined {
    return seesAll(actor) ? undefined : eq(crmLeads.ownerId, actor.id);
  }

  private leadSelect() {
    return {
      id: crmLeads.id,
      name: crmLeads.name,
      phone: crmLeads.phone,
      source: crmLeads.source,
      company: crmLeads.company,
      stageId: crmLeads.stageId,
      stageName: crmStages.name,
      stageColor: crmStages.color,
      ownerId: crmLeads.ownerId,
      ownerName: admins.name,
      lastContactAt: crmLeads.lastContactAt,
      createdAt: crmLeads.createdAt,
    };
  }

  private rowView(row: LeadListRow): CrmLeadRow {
    return { ...row, lastContactAt: iso(row.lastContactAt), createdAt: row.createdAt.toISOString() };
  }

  private filters(actor: CrmActor, query: Partial<CrmLeadsQuery>): SQL | undefined {
    const parts: (SQL | undefined)[] = [this.scope(actor)];
    if (query.stageId) parts.push(eq(crmLeads.stageId, query.stageId));
    if (query.source) parts.push(eq(crmLeads.source, query.source));
    if (query.ownerId === "none") parts.push(isNull(crmLeads.ownerId));
    else if (query.ownerId && seesAll(actor)) parts.push(eq(crmLeads.ownerId, query.ownerId));
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const digits = query.q.replace(/\D/g, "");
      parts.push(
        or(
          ilike(crmLeads.name, like),
          ilike(crmLeads.phone, like),
          ilike(crmLeads.company, like),
          digits.length >= 3 ? ilike(crmLeads.phoneKey, `%${digits}%`) : undefined,
        ),
      );
    }
    return and(...parts);
  }

  async listLeads(actor: CrmActor, query: Partial<CrmLeadsQuery>): Promise<CrmLeadsResponse> {
    const where = this.filters(actor, query);
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(crmLeads)
      .where(where);
    const rows = await this.db
      .select(this.leadSelect())
      .from(crmLeads)
      .innerJoin(crmStages, eq(crmStages.id, crmLeads.stageId))
      .leftJoin(admins, eq(admins.id, crmLeads.ownerId))
      .where(where)
      .orderBy(desc(crmLeads.createdAt), desc(crmLeads.id))
      .limit(query.limit ?? 100)
      .offset(query.offset ?? 0);
    return { total: count?.n ?? 0, leads: rows.map((r) => this.rowView(r)) };
  }

  /** The leads for an export: the same filters, no paging. */
  async exportLeads(actor: CrmActor, query: Partial<CrmLeadsQuery>): Promise<CrmLeadRow[]> {
    const rows = await this.db
      .select(this.leadSelect())
      .from(crmLeads)
      .innerJoin(crmStages, eq(crmStages.id, crmLeads.stageId))
      .leftJoin(admins, eq(admins.id, crmLeads.ownerId))
      .where(this.filters(actor, query))
      .orderBy(desc(crmLeads.createdAt), desc(crmLeads.id))
      .limit(50_000);
    return rows.map((r) => this.rowView(r));
  }

  private async leadRow(actor: CrmActor, id: string): Promise<CrmLeadRow> {
    const [row] = await this.db
      .select(this.leadSelect())
      .from(crmLeads)
      .innerJoin(crmStages, eq(crmStages.id, crmLeads.stageId))
      .leftJoin(admins, eq(admins.id, crmLeads.ownerId))
      .where(and(eq(crmLeads.id, id), this.scope(actor)));
    // A manager asking for another manager's lead gets the same answer as for a lead that does not exist.
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such lead");
    return this.rowView(row);
  }

  /** Throws 404 unless the caller may see this lead (another manager's lead looks as if it did not exist). */
  async assertCanSee(actor: CrmActor, id: string): Promise<void> {
    await this.leadRow(actor, id);
  }

  async lead(actor: CrmActor, id: string): Promise<CrmLeadDetail> {
    const lead = await this.leadRow(actor, id);
    const valueRows = await this.db.select().from(crmLeadValues).where(eq(crmLeadValues.leadId, id));
    const notes = await this.db
      .select({
        id: crmNotes.id,
        text: crmNotes.text,
        authorName: admins.name,
        createdAt: crmNotes.createdAt,
      })
      .from(crmNotes)
      .leftJoin(admins, eq(admins.id, crmNotes.authorId))
      .where(eq(crmNotes.leadId, id))
      .orderBy(desc(crmNotes.createdAt))
      .limit(200);
    const calls = await this.db
      .select({
        id: crmCalls.id,
        result: crmCalls.result,
        durationSec: crmCalls.durationSec,
        note: crmCalls.note,
        byName: admins.name,
        startedAt: crmCalls.startedAt,
      })
      .from(crmCalls)
      .leftJoin(admins, eq(admins.id, crmCalls.byAdminId))
      .where(eq(crmCalls.leadId, id))
      .orderBy(desc(crmCalls.startedAt))
      .limit(200);
    const history = await this.db.execute<{
      id: string;
      from_stage: string | null;
      to_stage: string;
      by_name: string | null;
      at: Date;
    }>(sql`
      select h.id, f.name as from_stage, t.name as to_stage, a.name as by_name, h.at
      from crm_stage_history h
      join crm_stages t on t.id = h.to_stage_id
      left join crm_stages f on f.id = h.from_stage_id
      left join admins a on a.id = h.by_admin_id
      where h.lead_id = ${id} order by h.at desc, h.id desc`);
    return {
      lead,
      values: Object.fromEntries(valueRows.map((r) => [r.fieldId, r.value])),
      notes: notes.map<CrmNoteView>((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
      calls: calls.map<CrmCallView>((c) => ({ ...c, startedAt: c.startedAt.toISOString() })),
      history: history.map<CrmHistoryView>((h) => ({
        id: h.id,
        fromStage: h.from_stage,
        toStage: h.to_stage,
        byName: h.by_name,
        at: new Date(h.at).toISOString(),
      })),
    };
  }

  /** Where a new lead starts: the stage asked for, else the funnel's first open stage. */
  private async startStage(stageId?: string): Promise<StageRow> {
    const pipeline = await this.pipeline();
    const stages = await this.stageRows(pipeline.id);
    const stage = stageId
      ? stages.find((s) => s.id === stageId)
      : (stages.find((s) => !s.isWon && !s.isLost) ?? stages[0]);
    if (!stage) throw new HttpError(400, "NO_STAGE", "No such stage");
    return stage;
  }

  /**
   * Adds a lead. A lead with the same phone is not added twice (docs/crm.md): the one that exists is updated with what is
   * given. A manager cannot touch another manager's lead this way: that is a conflict, not a silent overwrite.
   */
  async createLead(actor: CrmActor, input: CrmLeadInput): Promise<CrmLeadSaved> {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new HttpError(400, "BAD_PHONE", "This phone number is not valid");
    const existing = await this.db.query.crmLeads.findFirst({ where: eq(crmLeads.phoneKey, phone.key) });
    if (existing) {
      if (!seesAll(actor) && existing.ownerId !== null && existing.ownerId !== actor.id)
        throw new HttpError(409, "DUPLICATE_LEAD", "This phone number is already with another manager");
      await this.db
        .update(crmLeads)
        .set({
          name: input.name || existing.name,
          source: input.source || existing.source,
          company: input.company || existing.company,
          ownerId: existing.ownerId ?? (seesAll(actor) ? null : actor.id),
          updatedAt: new Date(),
        })
        .where(eq(crmLeads.id, existing.id));
      if (input.note)
        await this.db.insert(crmNotes).values({ leadId: existing.id, authorId: actor.id, text: input.note });
      return { lead: await this.leadRow(actor, existing.id), created: false };
    }
    const stage = await this.startStage(input.stageId);
    const [created] = await this.db
      .insert(crmLeads)
      .values({
        pipelineId: stage.pipelineId,
        stageId: stage.id,
        name: input.name,
        phone: phone.display,
        phoneKey: phone.key,
        source: input.source || null,
        company: input.company || null,
        ownerId: seesAll(actor) ? null : actor.id,
        createdBy: actor.id,
      })
      .onConflictDoNothing({ target: crmLeads.phoneKey })
      .returning();
    // Two people added the same number at the same moment: the second one is an update of the first.
    if (!created) return this.createLead(actor, input);
    await this.db
      .insert(crmStageHistory)
      .values({ leadId: created.id, toStageId: stage.id, byAdminId: actor.id });
    if (input.note)
      await this.db.insert(crmNotes).values({ leadId: created.id, authorId: actor.id, text: input.note });
    return { lead: await this.leadRow(actor, created.id), created: true };
  }

  /**
   * Someone signed up on the website with a phone: they are a new lead in the first open stage, with no manager yet. A phone that is
   * already a lead is not added twice; that lead gets a note about the sign-up (and the name and company if it had none).
   */
  async leadFromSignup(info: {
    name: string;
    accountName: string;
    email: string;
    phone: { display: string; key: string };
  }): Promise<void> {
    const note = `Saytda ro'yxatdan o'tdi. Pochta: ${info.email}. Firma: ${info.accountName}.`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.db.query.crmLeads.findFirst({
        where: eq(crmLeads.phoneKey, info.phone.key),
      });
      if (existing) {
        await this.db
          .update(crmLeads)
          .set({
            name: existing.name || info.name,
            company: existing.company || info.accountName,
            source: existing.source || SIGNUP_SOURCE,
            updatedAt: new Date(),
          })
          .where(eq(crmLeads.id, existing.id));
        await this.db.insert(crmNotes).values({ leadId: existing.id, authorId: null, text: note });
        return;
      }
      const stage = await this.startStage();
      const [created] = await this.db
        .insert(crmLeads)
        .values({
          pipelineId: stage.pipelineId,
          stageId: stage.id,
          name: info.name,
          phone: info.phone.display,
          phoneKey: info.phone.key,
          source: SIGNUP_SOURCE,
          company: info.accountName,
          ownerId: null,
          createdBy: null,
        })
        .onConflictDoNothing({ target: crmLeads.phoneKey })
        .returning();
      // The same number came in at the same moment from elsewhere: the second pass finds it and adds the note.
      if (!created) continue;
      await this.db
        .insert(crmStageHistory)
        .values({ leadId: created.id, toStageId: stage.id, byAdminId: null });
      await this.db.insert(crmNotes).values({ leadId: created.id, authorId: null, text: note });
      return;
    }
  }

  async updateLead(actor: CrmActor, id: string, input: CrmLeadUpdate): Promise<CrmLeadRow> {
    const current = await this.leadRow(actor, id);
    const set: Partial<typeof crmLeads.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name;
    if (input.source !== undefined) set.source = input.source || null;
    if (input.company !== undefined) set.company = input.company || null;
    if (input.phone !== undefined) {
      const phone = normalizePhone(input.phone);
      if (!phone) throw new HttpError(400, "BAD_PHONE", "This phone number is not valid");
      const taken = await this.db.query.crmLeads.findFirst({ where: eq(crmLeads.phoneKey, phone.key) });
      if (taken && taken.id !== id)
        throw new HttpError(409, "DUPLICATE_LEAD", "A lead with this phone number already exists");
      set.phone = phone.display;
      set.phoneKey = phone.key;
    }
    if (input.ownerId !== undefined) {
      this.requireStaff(actor);
      if (input.ownerId) {
        const owner = await this.db.query.admins.findFirst({ where: eq(admins.id, input.ownerId) });
        if (!owner || owner.disabled) throw new HttpError(400, "BAD_OWNER", "No such manager");
      }
      set.ownerId = input.ownerId;
    }
    await this.db.update(crmLeads).set(set).where(eq(crmLeads.id, current.id));
    if (input.ownerId !== undefined)
      await this.audit(actor, "crm.lead.assign", `crm-lead:${id}`, { ownerId: input.ownerId });
    return this.leadRow(actor, id);
  }

  /** Moves a lead to another stage; the move is written to the history, which the conversion is counted from. */
  async moveLead(actor: CrmActor, id: string, stageId: string, now = new Date()): Promise<CrmLeadRow> {
    const current = await this.leadRow(actor, id);
    const stage = await this.startStage(stageId);
    if (current.stageId === stage.id) return current;
    await this.db.transaction(async (tx) => {
      await tx.update(crmLeads).set({ stageId: stage.id, updatedAt: now }).where(eq(crmLeads.id, id));
      await tx.insert(crmStageHistory).values({
        leadId: id,
        fromStageId: current.stageId,
        toStageId: stage.id,
        byAdminId: actor.id,
        at: now,
      });
    });
    return this.leadRow(actor, id);
  }

  async addNote(actor: CrmActor, id: string, text: string): Promise<CrmNoteView> {
    await this.leadRow(actor, id);
    const [note] = await this.db
      .insert(crmNotes)
      .values({ leadId: id, authorId: actor.id, text })
      .returning();
    if (!note) throw new HttpError(500, "INTERNAL", "The note was not saved");
    const me = await this.db.query.admins.findFirst({ where: eq(admins.id, actor.id) });
    return {
      id: note.id,
      text: note.text,
      authorName: me?.name ?? null,
      createdAt: note.createdAt.toISOString(),
    };
  }

  /** A call attempt is a contact: it moves the lead's "last contact" date, whatever came of it. */
  async addCall(actor: CrmActor, id: string, input: CrmCallInput, now = new Date()): Promise<CrmCallView> {
    await this.leadRow(actor, id);
    const [call] = await this.db
      .insert(crmCalls)
      .values({
        leadId: id,
        byAdminId: actor.id,
        result: input.result,
        durationSec: input.durationSec ?? null,
        note: input.note || null,
        startedAt: now,
      })
      .returning();
    if (!call) throw new HttpError(500, "INTERNAL", "The call was not saved");
    await this.db.update(crmLeads).set({ lastContactAt: now, updatedAt: now }).where(eq(crmLeads.id, id));
    const me = await this.db.query.admins.findFirst({ where: eq(admins.id, actor.id) });
    return {
      id: call.id,
      result: call.result,
      durationSec: call.durationSec,
      note: call.note,
      byName: me?.name ?? null,
      startedAt: call.startedAt.toISOString(),
    };
  }

  /** The people leads can be given to: every active admin (a manager sees only themselves). */
  async team(actor: CrmActor): Promise<CrmManagerView[]> {
    const rows = await this.db
      .select({ id: admins.id, name: admins.name, email: admins.email })
      .from(admins)
      .where(and(eq(admins.disabled, false), seesAll(actor) ? undefined : eq(admins.id, actor.id)))
      .orderBy(asc(admins.name));
    return rows;
  }

  async sources(actor: CrmActor): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ source: crmLeads.source })
      .from(crmLeads)
      .where(and(this.scope(actor), sql`${crmLeads.source} is not null`))
      .orderBy(asc(crmLeads.source))
      .limit(100);
    return rows.map((r) => r.source ?? "").filter(Boolean);
  }

  async audit(actor: CrmActor, action: string, target: string, payload: Record<string, unknown> = {}) {
    await this.db.insert(adminAudit).values({ adminId: actor.id, action, target, payload });
  }

  /** The leads' stage ids that exist (used by the import to read a "stage" column). */
  async stageIdsByName(): Promise<Map<string, StageRow>> {
    const pipeline = await this.pipeline();
    const stages = await this.stageRows(pipeline.id);
    return new Map(stages.map((s) => [s.name.trim().toLowerCase(), s]));
  }

  async firstStage(): Promise<StageRow> {
    return this.startStage();
  }

  async leadsByPhoneKeys(keys: string[]): Promise<Map<string, LeadRow>> {
    const found = new Map<string, LeadRow>();
    for (let i = 0; i < keys.length; i += 1000) {
      const part = keys.slice(i, i + 1000);
      const rows = await this.db.select().from(crmLeads).where(inArray(crmLeads.phoneKey, part));
      for (const r of rows) found.set(r.phoneKey, r);
    }
    return found;
  }
}
