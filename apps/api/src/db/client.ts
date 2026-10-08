import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => undefined });
  return { db: drizzle(sql, { schema }), sql };
}

/** apps/api/drizzle, seen from src/db/ (tsx, tests) or from dist/ (the bundled server). */
function migrationsFolder(): string {
  const candidates = ["../../drizzle", "../drizzle"].map((p) => fileURLToPath(new URL(p, import.meta.url)));
  const found = candidates.find((dir) => existsSync(`${dir}/meta/_journal.json`));
  if (!found) throw new Error(`Migrations not found in ${candidates.join(" or ")}`);
  return found;
}

/** Applies drizzle/*.sql on start; already applied migrations are skipped. */
export async function runMigrations(db: Db, folder = migrationsFolder()) {
  await migrate(db, { migrationsFolder: folder });
}
