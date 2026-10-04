import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL);
await runMigrations(db);
// The Docker image puts the built admin dashboard next to the server (apps/api/Dockerfile).
const adminUiDir = process.env.ADMIN_UI_DIR ?? fileURLToPath(new URL("../admin", import.meta.url));
const app = await buildApp(db, config, { adminUiDir });

const close = async () => {
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

await app.listen({ port: config.PORT, host: config.HOST });
