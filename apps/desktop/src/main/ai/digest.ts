/**
 * The metadata digest: a compact description of a company's 1C (which documents, directories and
 * registers exist, and the fields of the ones accountants use most), built once per configuration
 * version and stored on the server. The model reads it before every question, so it does not ask
 * 1C what exists (each such answer would be sent again on every later step).
 *
 * Only names are read, never accounting data. A base without the standard metadata-identifier
 * directory gets no digest and works as before.
 */
import { MetadataObject, type QueryResult } from "@platform/shared";
import { z } from "zod";

import type { ConnectorRunner } from "../connector.js";
import type { ConnectionInput } from "../../shared/ipc.js";

/** The kinds of objects listed by name, in the order the model reads them. */
const KINDS: { prefix: string; title: string }[] = [
  { prefix: "Документ", title: "Documents" },
  { prefix: "Справочник", title: "Catalogs" },
  { prefix: "РегистрБухгалтерии", title: "Accounting registers" },
  { prefix: "РегистрНакопления", title: "Accumulation registers" },
  { prefix: "РегистрСведений", title: "Information registers" },
  { prefix: "ПланСчетов", title: "Charts of accounts" },
];

/** Objects whose fields are listed: the ones the assistant's work (entries, invoices, statements) touches. */
const CORE = [
  "Документ.РеализацияТоваровУслуг",
  "Документ.ПоступлениеТоваровУслуг",
  "Документ.СчетФактураВыданный",
  "Документ.СчетФактураПолученный",
  "Документ.ПоступлениеНаРасчетныйСчет",
  "Документ.СписаниеСРасчетногоСчета",
  "Документ.ПриходныйКассовыйОрдер",
  "Документ.РасходныйКассовыйОрдер",
  "Документ.АктСверкиВзаиморасчетов",
  "Документ.ОперацияБух",
  "Справочник.Контрагенты",
  "Справочник.Номенклатура",
  "Справочник.ДоговорыКонтрагентов",
  "Справочник.БанковскиеСчета",
  "Справочник.Организации",
  "РегистрБухгалтерии.Хозрасчетный",
];

/** The digest goes into every request: past this size the longest lists are cut. */
const MAX_CHARS = 40_000;

export interface Digest {
  configName: string;
  configVersion: string;
  digest: string;
  tokenCount: number;
}

const Rows = z.object({ rows: z.array(z.array(z.unknown())) });

async function names(
  connector: ConnectorRunner,
  connection: ConnectionInput,
  prefix: string,
): Promise<string[] | null> {
  const result = await connector.tool(connection, "run_query", {
    query:
      "ВЫБРАТЬ ПолноеИмя КАК Имя ИЗ Справочник.ИдентификаторыОбъектовМетаданных " +
      `ГДЕ НЕ ПометкаУдаления И ПолноеИмя ПОДОБНО "${prefix}.%" И НЕ ПолноеИмя ПОДОБНО "${prefix}.%.%" ` +
      "УПОРЯДОЧИТЬ ПО ПолноеИмя",
    limit: 1000,
  });
  if (!result.ok) return null;
  const parsed = Rows.safeParse(result.data as QueryResult);
  if (!parsed.success) return null;
  return parsed.data.rows.flatMap((row) =>
    typeof row[0] === "string" ? [row[0].slice(prefix.length + 1)] : [],
  );
}

/** "Дата, Номер, Контрагент; Товары[Номенклатура, Количество]" */
function fieldsOf(object: MetadataObject): string {
  const attributes = object.attributes.map((a) => a.name).join(", ");
  const sections = object.tabularSections
    .map((s) => `${s.name}[${s.attributes.map((a) => a.name).join(", ")}]`)
    .join("; ");
  return [attributes, sections].filter(Boolean).join("; ");
}

/** The digest of a company's base, or null when it cannot be built (no extension, no identifiers directory). */
export async function buildDigest(
  connector: ConnectorRunner,
  connection: ConnectionInput,
): Promise<Digest | null> {
  const check = await connector.check(connection);
  if (!check.status.ok) return null;
  const { name: configName, version: configVersion } = check.status.ping.configuration;

  const lists: { title: string; prefix: string; names: string[] }[] = [];
  for (const kind of KINDS) {
    const found = await names(connector, connection, kind.prefix);
    if (found === null) return null;
    if (found.length > 0) lists.push({ ...kind, names: found });
  }
  if (lists.length === 0) return null;

  const existing = new Set(lists.flatMap((l) => l.names.map((n) => `${l.prefix}.${n}`)));
  const core = CORE.filter((name) => existing.has(name));
  const described =
    core.length > 0 ? await connector.tool(connection, "describe_objects", { objects: core }) : null;
  const objects = described?.ok ? z.array(MetadataObject).safeParse(described.data) : null;

  const header = `Configuration: ${configName} ${configVersion}.`;
  const fields = objects?.success
    ? [
        "Fields of the main objects (tabular sections in brackets):",
        ...objects.data.map((o) => `${o.fullName}: ${fieldsOf(o)}`),
      ].join("\n")
    : "";
  const listText = (limit: number) =>
    lists
      .map((l) => {
        const shown = l.names.slice(0, limit);
        const more = l.names.length - shown.length;
        return `${l.title} (${l.names.length}): ${shown.join(", ")}${more > 0 ? `, … and ${more} more (search Справочник.ИдентификаторыОбъектовМетаданных)` : ""}`;
      })
      .join("\n");

  // The lists first shrink to fit; the fields of the main objects always stay.
  let digest = "";
  for (const limit of [Number.POSITIVE_INFINITY, 400, 200, 100, 40]) {
    digest = [header, listText(limit), fields].filter(Boolean).join("\n");
    if (digest.length <= MAX_CHARS) break;
  }
  return { configName, configVersion, digest, tokenCount: Math.ceil(digest.length / 2.5) };
}
