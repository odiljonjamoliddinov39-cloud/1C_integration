import { fileURLToPath } from "node:url";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { seedTemplates } from "./ai/seed.js";
import { createDb, runMigrations } from "./db/client.js";
import { botApi } from "./remote/telegram.js";

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL);
await runMigrations(db);
// The everyday questions the engine answers with no model; an admin's own edits are kept.
await seedTemplates(db);
// The Docker image puts the built admin dashboard next to the server (apps/api/Dockerfile).
const adminUiDir = process.env.ADMIN_UI_DIR ?? fileURLToPath(new URL("../admin", import.meta.url));
const miniappDir = process.env.MINIAPP_DIR ?? fileURLToPath(new URL("../miniapp", import.meta.url));
const app = await buildApp(db, config, { adminUiDir, miniappDir });

const close = async () => {
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

await app.listen({ port: config.PORT, host: config.HOST });

// Telegram is told where to send the bot's messages (the same address the Mini App is served from).
if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_WEBHOOK_SECRET && config.MINIAPP_URL) {
  try {
    const webhook = `${new URL(config.MINIAPP_URL).origin}/telegram/webhook`;
    const telegram = botApi(config.TELEGRAM_BOT_TOKEN);
    await telegram.setWebhook?.(webhook, config.TELEGRAM_WEBHOOK_SECRET);
    await telegram.setMenuButton?.("Assistant", config.MINIAPP_URL);
    app.log.info({ webhook }, "Telegram webhook set");
  } catch (error) {
    app.log.error(error, "Telegram webhook could not be set");
  }
}
