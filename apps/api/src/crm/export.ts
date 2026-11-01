/** The CRM's Excel exports: the leads as filtered, and the reports (every table of the page, one sheet each). */
import type { CrmLeadRow, CrmReport } from "@platform/shared";

import { type Sheet, writeXlsx } from "./xlsx.js";

export type Lang = "uz" | "ru" | "en";
export const langOf = (v: unknown): Lang => (v === "ru" || v === "en" ? v : "uz");

const L = {
  uz: {
    leads: "Lead'lar",
    name: "Ism",
    phone: "Telefon",
    source: "Manba",
    company: "Kompaniya",
    stage: "Bosqich",
    manager: "Menejer",
    last: "Oxirgi aloqa",
    created: "Yaratilgan",
    funnel: "Voronka",
    step: "Bosqich",
    reached: "Yetib keldi",
    prev: "Oldingisidan %",
    first: "Birinchisidan %",
    time: "Bosqichda vaqt",
    hours: "O'rtacha soat",
    visits: "O'tishlar",
    bySource: "Manba bo'yicha",
    leadsN: "Lead'lar",
    won: "Yutildi",
    conv: "Konversiya %",
    byManager: "Menejer bo'yicha",
    lost: "Yo'qotildi",
    rate: "Yutish %",
    none: "—",
    total: "Jami",
    lostStages: "Yo'qotilganlar",
  },
  ru: {
    leads: "Лиды",
    name: "Имя",
    phone: "Телефон",
    source: "Источник",
    company: "Компания",
    stage: "Этап",
    manager: "Менеджер",
    last: "Последний контакт",
    created: "Создан",
    funnel: "Воронка",
    step: "Этап",
    reached: "Дошли",
    prev: "От предыдущего %",
    first: "От первого %",
    time: "Время на этапе",
    hours: "Среднее, ч",
    visits: "Переходов",
    bySource: "По источникам",
    leadsN: "Лиды",
    won: "Выиграно",
    conv: "Конверсия %",
    byManager: "По менеджерам",
    lost: "Потеряно",
    rate: "Выигрыш %",
    none: "—",
    total: "Всего",
    lostStages: "Потерянные",
  },
  en: {
    leads: "Leads",
    name: "Name",
    phone: "Phone",
    source: "Source",
    company: "Company",
    stage: "Stage",
    manager: "Manager",
    last: "Last contact",
    created: "Created",
    funnel: "Funnel",
    step: "Stage",
    reached: "Reached",
    prev: "Of previous %",
    first: "Of first %",
    time: "Time in stage",
    hours: "Average, h",
    visits: "Moves",
    bySource: "By source",
    leadsN: "Leads",
    won: "Won",
    conv: "Conversion %",
    byManager: "By manager",
    lost: "Lost",
    rate: "Win rate %",
    none: "—",
    total: "Total",
    lostStages: "Lost",
  },
} as const;

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export function leadsWorkbook(lang: Lang, leads: CrmLeadRow[]): Uint8Array {
  const l = L[lang];
  const rows: Sheet["rows"] = [
    [l.name, l.phone, l.source, l.company, l.stage, l.manager, l.last, l.created],
    ...leads.map((x) => [
      x.name,
      x.phone,
      x.source,
      x.company,
      x.stageName,
      x.ownerName,
      day(x.lastContactAt),
      day(x.createdAt),
    ]),
  ];
  return writeXlsx([{ name: l.leads, rows }]);
}

export function reportWorkbook(lang: Lang, r: CrmReport): Uint8Array {
  const l = L[lang];
  return writeXlsx([
    {
      name: l.funnel,
      rows: [
        [l.step, l.reached, l.prev, l.first],
        ...r.funnel.map((s) => [s.name, s.reached, s.fromPrevPct, s.fromFirstPct]),
        [l.total, r.totalLeads, null, null],
        [l.won, r.won, r.conversionPct, null],
        ...r.lostStages.map((s) => [`${l.lostStages}: ${s.name}`, s.leads, null, null]),
      ],
    },
    {
      name: l.time,
      rows: [[l.step, l.hours, l.visits], ...r.timeInStage.map((s) => [s.name, s.avgHours, s.leads])],
    },
    {
      name: l.bySource,
      rows: [
        [l.source, l.leadsN, l.won, l.conv],
        ...r.bySource.map((s) => [s.source || l.none, s.leads, s.won, s.conversionPct]),
      ],
    },
    {
      name: l.byManager,
      rows: [
        [l.manager, l.leadsN, l.won, l.lost, l.conv, l.rate],
        ...r.byManager.map((m) => [m.name || l.none, m.leads, m.won, m.lost, m.conversionPct, m.winRatePct]),
      ],
    },
  ]);
}
