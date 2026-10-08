/**
 * Shared argument handling for the phase-0 scripts. The password comes from ONEC_PASSWORD (or an
 * interactive prompt), never from the command line, so it does not end up in shell history.
 *
 *   --file "D:\Bases\TEST_CRYSTAL"   or   --server host --ref base
 *   --user Admin
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { PlatformApiClient } from "../src/client.js";
import { ComTransport } from "../src/com-transport.js";
import type { InfobaseLocation } from "../src/connection-string.js";

export async function connectFromArgs(extra: Record<string, { type: "string" | "boolean" }> = {}) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: "string" },
      server: { type: "string" },
      ref: { type: "string" },
      user: { type: "string" },
      ...extra,
    },
  });
  let infobase: InfobaseLocation;
  if (typeof values.file === "string") infobase = { file: values.file };
  else if (typeof values.server === "string" && typeof values.ref === "string")
    infobase = { server: values.server, ref: values.ref };
  else {
    console.error(
      'Usage: --file "D:\\Bases\\NAME" | --server HOST --ref NAME  [--user USER]   (password: ONEC_PASSWORD)',
    );
    process.exit(2);
  }
  let password = process.env.ONEC_PASSWORD;
  if (password === undefined && values.user) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question("1C password: ");
    rl.close();
  }
  const started = Date.now();
  const transport = ComTransport.connect({ infobase, user: values.user as string | undefined, password });
  console.error(`connected in ${Date.now() - started} ms`);
  const options = values as Record<string, string | boolean | undefined>;
  return { client: new PlatformApiClient(transport), values: options, positionals };
}

export async function run(main: () => Promise<void>) {
  try {
    await main();
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: unknown };
    console.error(`✖ ${err.code ?? "ERROR"}: ${err.message ?? String(e)}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  }
}
