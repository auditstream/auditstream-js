import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDatabase } from "./db.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const database = createDatabase(databaseUrl, 5);
const app = createApp(database.db);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Hono + Drizzle example listening on http://127.0.0.1:${info.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await database.close();
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
