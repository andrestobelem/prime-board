// Helper para tests: app completa sobre una DB en memoria con el seed corrido.
import { Database } from "bun:sqlite";
import { migrate } from "./db/database.ts";
import { bootstrap } from "./db/seed.ts";
import { createApp } from "./server.ts";
import type { Config } from "./config.ts";

export interface TestApp {
  db: Database;
  server: ReturnType<typeof createApp>;
  url: string;
  apiKey: string;
  stop: () => void;
}

export function createTestApp(): TestApp {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  const seed = bootstrap(db);
  const config: Config = { port: 0, dbPath: ":memory:", dev: true };
  const server = createApp({ db, config });
  return {
    db,
    server,
    url: `http://localhost:${server.port}`,
    apiKey: seed.adminApiKey!,
    stop: () => {
      server.stop(true);
      db.close();
    },
  };
}

/** Ejecuta una operación GraphQL contra la app de test. */
export async function gql(
  app: TestApp,
  query: string,
  variables: Record<string, unknown> = {},
  apiKey: string | null = app.apiKey,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${app.url}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
}
