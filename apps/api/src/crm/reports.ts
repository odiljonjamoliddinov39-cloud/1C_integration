/**
 * The CRM's reports (docs/crm.md §9), all counted from the leads created in the period and their stage history: the funnel with
 * the conversion step by step, the time a lead stays in a stage, and the split by source and by manager. Lost stages are outside
 * the funnel. A manager's reports hold only their own leads.
 */
import type { CrmReport, CrmReportQuery } from "@platform/shared";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { admins, crmLeads, crmStageHistory, crmStages } from "../db/schema.js";
import type { Crm, CrmActor } from "./service.js";

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

/** A day in Tashkent (UTC+5), from its start or to its end. */
const dayStart = (day: string) => new Date(`${day}T00:00:00+05:00`);
const dayEnd = (day: string) => new Date(`${day}T23:59:59.999+05:00`);

export class CrmReports {
  constructor(
    private readonly db: Db,
    private readonly crm: Crm,
  ) {}

  async report(actor: CrmActor, query: CrmReportQuery, now = new Date()): Promise<CrmReport> {
    const pipeline = await this.crm.pipeline();
    const allStages = await this.db
      .select()
      .from(crmStages)
      .where(eq(crmStages.pipelineId, pipeline.id))
      .orderBy(asc(crmStages.position));
    const stageById = new Map(allStages.map((s) => [s.id, s]));

    const leads = await this.db
      .select({
        id: crmLeads.id,
        stageId: crmLeads.stageId,
        ownerId: crmLeads.ownerId,
        source: crmLeads.source,
      })
      .from(crmLeads)
      .where(
        and(
          this.crm.scope(actor),
          query.from ? gte(crmLeads.createdAt, dayStart(query.from)) : undefined,
          query.to ? lte(crmLeads.createdAt, dayEnd(query.to)) : undefined,
        ),
      );
    const ids = leads.map((l) => l.id);
    const history: { leadId: string; toStageId: string; at: Date }[] = [];
    for (let i = 0; i < ids.length; i += 2000) {
      const part = await this.db
        .select({
          leadId: crmStageHistory.leadId,
          toStageId: crmStageHistory.toStageId,
          at: crmStageHistory.at,
        })
        .from(crmStageHistory)
        .where(inArray(crmStageHistory.leadId, ids.slice(i, i + 2000)))
        .orderBy(asc(crmStageHistory.at));
      history.push(...part);
    }
    const byLead = new Map<string, { toStageId: string; at: Date }[]>();
    for (const h of history) {
      const list = byLead.get(h.leadId) ?? [];
      list.push(h);
      byLead.set(h.leadId, list);
    }

    // The funnel: a lead has "reached" a stage when it was there, or in a later open stage.
    const open = allStages.filter((s) => !s.isLost && !s.archived);
    const funnelPositions = open.map((s) => s.position);
    const reached = new Array<number>(open.length).fill(0);
    for (const lead of leads) {
      let furthest = -1;
      for (const h of byLead.get(lead.id) ?? []) {
        const stage = stageById.get(h.toStageId);
        if (stage && !stage.isLost) furthest = Math.max(furthest, stage.position);
      }
      const current = stageById.get(lead.stageId);
      if (current && !current.isLost) furthest = Math.max(furthest, current.position);
      funnelPositions.forEach((position, i) => {
        if (furthest >= position) reached[i] = (reached[i] ?? 0) + 1;
      });
    }
    const first = reached[0] ?? 0;
    const funnel = open.map((s, i) => ({
      stageId: s.id,
      name: s.name,
      color: s.color,
      reached: reached[i] ?? 0,
      fromPrevPct: i === 0 ? null : pct(reached[i] ?? 0, reached[i - 1] ?? 0),
      fromFirstPct: i === 0 ? null : pct(reached[i] ?? 0, first),
      isWon: s.isWon,
    }));

    const won = leads.filter((l) => stageById.get(l.stageId)?.isWon).length;
    const lost = leads.filter((l) => stageById.get(l.stageId)?.isLost).length;
    const lostStages = allStages
      .filter((s) => s.isLost && !s.archived)
      .map((s) => ({ stageId: s.id, name: s.name, leads: leads.filter((l) => l.stageId === s.id).length }));

    // The time in a stage: from the move in to the move out (or to now, for the stage a lead is in; a won or lost stage is an end).
    const spent = new Map<string, { total: number; visits: number }>();
    for (const list of byLead.values()) {
      list.forEach((h, i) => {
        const stage = stageById.get(h.toStageId);
        if (!stage) return;
        const next = list[i + 1];
        if (!next && (stage.isWon || stage.isLost)) return;
        const end = next ? next.at.getTime() : now.getTime();
        const entry = spent.get(stage.id) ?? { total: 0, visits: 0 };
        entry.total += Math.max(0, end - h.at.getTime());
        entry.visits += 1;
        spent.set(stage.id, entry);
      });
    }
    const timeInStage = open
      .filter((s) => !s.isWon)
      .map((s) => {
        const e = spent.get(s.id);
        return {
          stageId: s.id,
          name: s.name,
          avgHours: e && e.visits ? Math.round((e.total / e.visits / 3_600_000) * 10) / 10 : null,
          leads: e?.visits ?? 0,
        };
      });

    const sources = new Map<string, { leads: number; won: number }>();
    for (const l of leads) {
      const key = l.source ?? "";
      const e = sources.get(key) ?? { leads: 0, won: 0 };
      e.leads += 1;
      if (stageById.get(l.stageId)?.isWon) e.won += 1;
      sources.set(key, e);
    }
    const bySource = [...sources.entries()]
      .map(([source, e]) => ({ source, leads: e.leads, won: e.won, conversionPct: pct(e.won, e.leads) }))
      .sort((a, b) => b.leads - a.leads);

    const owners = new Map<string | null, { leads: number; won: number; lost: number }>();
    for (const l of leads) {
      const e = owners.get(l.ownerId) ?? { leads: 0, won: 0, lost: 0 };
      e.leads += 1;
      const stage = stageById.get(l.stageId);
      if (stage?.isWon) e.won += 1;
      if (stage?.isLost) e.lost += 1;
      owners.set(l.ownerId, e);
    }
    const names = new Map<string, string>();
    const ownerIds = [...owners.keys()].filter((k): k is string => k !== null);
    if (ownerIds.length)
      for (const a of await this.db
        .select({ id: admins.id, name: admins.name })
        .from(admins)
        .where(inArray(admins.id, ownerIds)))
        names.set(a.id, a.name);
    const byManager = [...owners.entries()]
      .map(([ownerId, e]) => ({
        ownerId,
        name: ownerId ? (names.get(ownerId) ?? "") : "",
        leads: e.leads,
        won: e.won,
        lost: e.lost,
        conversionPct: pct(e.won, e.leads),
        winRatePct: e.won + e.lost === 0 ? null : pct(e.won, e.won + e.lost),
      }))
      .sort((a, b) => b.leads - a.leads);

    return {
      period: { from: query.from ?? null, to: query.to ?? null },
      totalLeads: leads.length,
      conversionPct: pct(won, leads.length),
      won,
      lost,
      funnel,
      lostStages,
      timeInStage,
      bySource,
      byManager,
    };
  }
}
