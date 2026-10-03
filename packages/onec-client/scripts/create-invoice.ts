/**
 * Phase 0 gate: write one unposted Счет-фактура полученный from a JSON file.
 *   pnpm --filter @platform/onec-client create-invoice -- --file ... --user ... fixtures/invoice-received.sample.json
 * Running it twice with the same externalId must return the same document with duplicate: true.
 */
import { readFileSync } from "node:fs";

import { connectFromArgs, run } from "./connect.js";

await run(async () => {
  const { client, positionals } = await connectFromArgs();
  const file = positionals[0];
  if (!file) throw new Error("Pass the invoice JSON file as the last argument");
  try {
    const result = await client.createInvoiceReceived(JSON.parse(readFileSync(file, "utf8")));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
});
