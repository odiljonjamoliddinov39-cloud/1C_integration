/**
 * Phase 0: read the real object and field names of БУ для Узбекистана 3.0 (TD §5 "Document mapping")
 * and save them next to the field map for review:
 *   pnpm --filter @platform/onec-client metadata -- --file ... --user ... [--out file.json]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { connectFromArgs, run } from "./connect.js";

const OBJECTS = [
  "Документ.СчетФактураПолученный",
  "Документ.СчетФактураВыданный",
  "Документ.ПоступлениеНаРасчетныйСчет",
  "Документ.СписаниеСРасчетногоСчета",
  "Справочник.Контрагенты",
  "Справочник.Номенклатура",
  "Справочник.ДоговорыКонтрагентов",
  "Справочник.Организации",
];

await run(async () => {
  const { client, values } = await connectFromArgs({ out: { type: "string" } });
  try {
    const ping = await client.ping();
    const objects = await client.getMetadata(OBJECTS);
    const out = resolve(
      (values.out as string | undefined) ??
        `../../onec/mapping/${ping.configuration.name}-${ping.configuration.version}.metadata.json`,
    );
    writeFileSync(out, JSON.stringify({ configuration: ping.configuration, objects }, null, 2) + "\n");
    const missing = OBJECTS.filter((name) => !objects.some((o) => o.fullName === name));
    console.log(`wrote ${objects.length} objects to ${out}`);
    if (missing.length) console.log(`not in this configuration: ${missing.join(", ")}`);
  } finally {
    await client.close();
  }
});
