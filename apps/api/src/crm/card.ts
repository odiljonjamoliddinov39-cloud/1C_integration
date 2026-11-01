/**
 * The client card (docs/crm.md): the admin makes the sections and the fields in them (a name, a type, the choices of a select);
 * the managers fill the values in on each lead. The basic details of a lead (name, phone, company, source) are not here: they are
 * always on the card. Owner and support shape the card; anyone who may see a lead may fill its card.
 */
import {
  CARD_LIMITS,
  type CardFieldType,
  type CrmCardField,
  type CrmCardFieldInput,
  type CrmCardFieldUpdate,
  type CrmCardSection,
} from "@platform/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { crmCardFields, crmCardSections, crmLeadValues } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { normalizePhone } from "./phone.js";
import { type Crm, type CrmActor, seesAll } from "./service.js";

type FieldRow = typeof crmCardFields.$inferSelect;

const fieldView = (f: FieldRow): CrmCardField => ({
  id: f.id,
  sectionId: f.sectionId,
  label: f.label,
  type: f.type,
  options: (f.options as string[]) ?? [],
  position: f.position,
});

/** A value as it is stored, or null for "empty"; throws 400 for a value the field's type does not take. */
export function normalizeValue(
  field: Pick<CrmCardField, "label" | "type" | "options">,
  raw: string,
): string | null {
  const value = raw.trim();
  if (!value) return null;
  const bad = (why: string) => new HttpError(400, "BAD_VALUE", `${field.label}: ${why}`);
  switch (field.type as CardFieldType) {
    case "number": {
      const n = Number(value.replace(/\s/g, "").replace(",", "."));
      if (!Number.isFinite(n)) throw bad("a number is needed");
      return String(n);
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
        throw bad("a date (YYYY-MM-DD) is needed");
      return value;
    }
    case "phone": {
      const phone = normalizePhone(value);
      if (!phone) throw bad("this phone number is not valid");
      return phone.display;
    }
    case "email": {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw bad("this e-mail is not valid");
      return value;
    }
    case "select": {
      if (!field.options.includes(value)) throw bad("choose one of the options");
      return value;
    }
    case "checkbox":
      return value === "true"
        ? "true"
        : value === "false"
          ? "false"
          : (() => {
              throw bad("yes or no");
            })();
    default:
      return value;
  }
}

export class CrmCard {
  constructor(
    private readonly db: Db,
    private readonly crm: Crm,
  ) {}

  private requireStaff(actor: CrmActor): void {
    if (!seesAll(actor)) throw new HttpError(403, "FORBIDDEN", "Only the owner or support can do this");
  }

  /** The card: the sections in order, each with its fields in order. */
  async layout(): Promise<CrmCardSection[]> {
    const sections = await this.db.select().from(crmCardSections).orderBy(asc(crmCardSections.position));
    const fields = await this.db
      .select()
      .from(crmCardFields)
      .orderBy(asc(crmCardFields.position), asc(crmCardFields.createdAt));
    return sections.map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      fields: fields.filter((f) => f.sectionId === s.id).map(fieldView),
    }));
  }

  async addSection(actor: CrmActor, name: string): Promise<CrmCardSection[]> {
    this.requireStaff(actor);
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int`, max: sql<number | null>`max(${crmCardSections.position})` })
      .from(crmCardSections);
    if ((count?.n ?? 0) >= CARD_LIMITS.sections)
      throw new HttpError(409, "TOO_MANY_SECTIONS", `A card may have up to ${CARD_LIMITS.sections} sections`);
    const [created] = await this.db
      .insert(crmCardSections)
      .values({ name, position: (count?.max ?? -1) + 1 })
      .returning();
    await this.crm.audit(actor, "crm.card.section.add", `crm-card-section:${created?.id}`, { name });
    return this.layout();
  }

  async renameSection(actor: CrmActor, id: string, name: string): Promise<CrmCardSection[]> {
    this.requireStaff(actor);
    const [row] = await this.db
      .update(crmCardSections)
      .set({ name })
      .where(eq(crmCardSections.id, id))
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such section");
    await this.crm.audit(actor, "crm.card.section.rename", `crm-card-section:${id}`, { name });
    return this.layout();
  }

  /** Deleting a section deletes its fields and what the managers wrote in them. */
  async deleteSection(actor: CrmActor, id: string): Promise<CrmCardSection[]> {
    this.requireStaff(actor);
    const [row] = await this.db.delete(crmCardSections).where(eq(crmCardSections.id, id)).returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such section");
    await this.compactSections();
    await this.crm.audit(actor, "crm.card.section.delete", `crm-card-section:${id}`, { name: row.name });
    return this.layout();
  }

  private async compactSections(): Promise<void> {
    const rows = await this.db
      .select({ id: crmCardSections.id })
      .from(crmCardSections)
      .orderBy(asc(crmCardSections.position));
    for (const [position, r] of rows.entries())
      await this.db.update(crmCardSections).set({ position }).where(eq(crmCardSections.id, r.id));
  }

  async reorderSections(actor: CrmActor, ids: string[]): Promise<CrmCardSection[]> {
    this.requireStaff(actor);
    const current = await this.db.select({ id: crmCardSections.id }).from(crmCardSections);
    if (
      ids.length !== current.length ||
      new Set(ids).size !== ids.length ||
      !current.every((s) => ids.includes(s.id))
    )
      throw new HttpError(400, "BAD_ORDER", "The order must list every section once");
    await this.db.transaction(async (tx) => {
      for (const [position, id] of ids.entries())
        await tx.update(crmCardSections).set({ position }).where(eq(crmCardSections.id, id));
    });
    return this.layout();
  }

  private checkOptions(type: CardFieldType, options: string[] | undefined): string[] {
    const list = [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
    if (type === "select" && list.length === 0)
      throw new HttpError(400, "NO_OPTIONS", "A select needs at least one choice");
    return type === "select" ? list : [];
  }

  async addField(actor: CrmActor, input: CrmCardFieldInput): Promise<CrmCardSection[]> {
    this.requireStaff(actor);
    const section = await this.db.query.crmCardSections.findFirst({
      where: eq(crmCardSections.id, input.sectionId),
    });
    if (!section) throw new HttpError(404, "NOT_FOUND", "No such section");
    const options = this.checkOptions(input.type, input.options);
    const [all] = await this.db.select({ n: sql<number>`count(*)::int` }).from(crmCardFields);
    if ((all?.n ?? 0) >= CARD_LIMITS.fields)
      throw new HttpError(409, "TOO_MANY_FIELDS", `A card may have up to ${CARD_LIMITS.fields} fields`);
    const [last] = await this.db
      .select({ max: sql<number | null>`max(${crmCardFields.position})` })
      .from(crmCardFields)
      .where(eq(crmCardFields.sectionId, input.sectionId));
    const [created] = await this.db
      .insert(crmCardFields)
      .values({
        sectionId: input.sectionId,
        label: input.label,
        type: input.type,
        options,
        position: (last?.max ?? -1) + 1,
      })
      .returning();
    await this.crm.audit(actor, "crm.card.field.add", `crm-card-field:${created?.id}`, {
      label: input.label,
      type: input.type,
    });
    return this.layout();
  }

  async updateField(actor: CrmActor, id: string, input: CrmCardFieldUpdate): Promise<CrmCardSection[]> {
    this.requireStaff(actor);
    const field = await this.db.query.crmCardFields.findFirst({ where: eq(crmCardFields.id, id) });
    if (!field) throw new HttpError(404, "NOT_FOUND", "No such field");
    const set: Partial<typeof crmCardFields.$inferInsert> = {};
    if (input.label !== undefined) set.label = input.label;
    if (input.options !== undefined) set.options = this.checkOptions(field.type, input.options);
    if (input.sectionId !== undefined && input.sectionId !== field.sectionId) {
      const section = await this.db.query.crmCardSections.findFirst({
        where: eq(crmCardSections.id, input.sectionId),
      });
      if (!section) throw new HttpError(404, "NOT_FOUND", "No such section");
      const [last] = await this.db
        .select({ max: sql<number | null>`max(${crmCardFields.position})` })
        .from(crmCardFields)
        .where(eq(crmCardFields.sectionId, input.sectionId));
      set.sectionId = input.sectionId;
      set.position = (last?.max ?? -1) + 1;
    }
    if (Object.keys(set).length) await this.db.update(crmCardFields).set(set).where(eq(crmCardFields.id, id));
    await this.crm.audit(actor, "crm.card.field.update", `crm-card-field:${id}`, { ...input });
    return this.layout();
  }

  /** Deleting a field deletes what the managers wrote in it. */
  async deleteField(actor: CrmActor, id: string): Promise<CrmCardSection[]> {
    this.requireStaff(actor);
    const [row] = await this.db.delete(crmCardFields).where(eq(crmCardFields.id, id)).returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "No such field");
    await this.crm.audit(actor, "crm.card.field.delete", `crm-card-field:${id}`, { label: row.label });
    return this.layout();
  }

  /** The new order of the fields of one section: every field of it, once. */
  async reorderFields(actor: CrmActor, sectionId: string, ids: string[]): Promise<CrmCardSection[]> {
    this.requireStaff(actor);
    const current = await this.db
      .select({ id: crmCardFields.id })
      .from(crmCardFields)
      .where(eq(crmCardFields.sectionId, sectionId));
    if (
      ids.length !== current.length ||
      new Set(ids).size !== ids.length ||
      !current.every((f) => ids.includes(f.id))
    )
      throw new HttpError(400, "BAD_ORDER", "The order must list every field of the section once");
    await this.db.transaction(async (tx) => {
      for (const [position, fieldId] of ids.entries())
        await tx.update(crmCardFields).set({ position }).where(eq(crmCardFields.id, fieldId));
    });
    return this.layout();
  }

  // --- the values -----------------------------------------------------------------------------

  async values(leadId: string): Promise<Record<string, string>> {
    const rows = await this.db.select().from(crmLeadValues).where(eq(crmLeadValues.leadId, leadId));
    return Object.fromEntries(rows.map((r) => [r.fieldId, r.value]));
  }

  /**
   * Saves what was filled in: each value is checked against its field's type; an empty one clears the field; fields not mentioned
   * stay as they are. Nothing is saved if any value is wrong.
   */
  async saveValues(
    actor: CrmActor,
    leadId: string,
    input: Record<string, string>,
  ): Promise<Record<string, string>> {
    await this.crm.assertCanSee(actor, leadId);
    const ids = Object.keys(input);
    const fields = ids.length
      ? await this.db.select().from(crmCardFields).where(inArray(crmCardFields.id, ids))
      : [];
    const byId = new Map(fields.map((f) => [f.id, fieldView(f)]));
    const set: { fieldId: string; value: string }[] = [];
    const clear: string[] = [];
    for (const [fieldId, raw] of Object.entries(input)) {
      const field = byId.get(fieldId);
      if (!field)
        throw new HttpError(400, "NO_SUCH_FIELD", "This field is not on the card (it may have been deleted)");
      const value = normalizeValue(field, raw);
      if (value === null) clear.push(fieldId);
      else set.push({ fieldId, value });
    }
    const now = new Date();
    await this.db.transaction(async (tx) => {
      if (clear.length)
        await tx
          .delete(crmLeadValues)
          .where(and(eq(crmLeadValues.leadId, leadId), inArray(crmLeadValues.fieldId, clear)));
      if (set.length)
        await tx
          .insert(crmLeadValues)
          .values(
            set.map((s) => ({
              leadId,
              fieldId: s.fieldId,
              value: s.value,
              updatedBy: actor.id,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [crmLeadValues.leadId, crmLeadValues.fieldId],
            set: { value: sql`excluded.value`, updatedBy: actor.id, updatedAt: now },
          });
    });
    return this.values(leadId);
  }
}
