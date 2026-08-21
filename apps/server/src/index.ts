// Punto de entrada del servidor de prime-board.
// Config por variables de entorno con prefijo PRIME_BOARD_ (ver docs/specs/mvp.md §2).
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { bootstrap } from "./db/seed.ts";
import { migratePostgres } from "./db/postgres/migrator.ts";
import { bootstrapPostgres } from "./db/postgres/bootstrap.ts";
import { createPostgresPersistence } from "./db/postgres/persistence.ts";
import { createApp } from "./server.ts";

const config = loadConfig();

function reportBootstrap(created: boolean, adminApiKey?: string): void {
  if (!created) return;
  console.log("First run: workspace seeded.");
  if (config.authMode === "local") {
    console.log("Local auth mode is active; no API key is required.");
    return;
  }
  if (adminApiKey) {
    // La key se muestra una única vez: solo se persiste su hash.
    console.log(`Admin API key (save it now, it will not be shown again): ${adminApiKey}`);
  }
}

if (config.persistenceBackend === "postgres") {
  if (!config.postgresUrl) {
    throw new Error("PRIME_BOARD_POSTGRES_URL is required when PRIME_BOARD_PERSISTENCE=postgres");
  }
  const sql = new Bun.SQL({ url: config.postgresUrl, max: 10, connectionTimeout: 5 });
  await migratePostgres(sql);
  const persistence = createPostgresPersistence(sql);
  const result = await bootstrapPostgres(persistence);
  reportBootstrap(result.created, result.adminApiKey);

  // Los dominios todavía no migrados conservan un SQLite efímero como seam de
  // compatibilidad; workspace/actors ya leen y escriben exclusivamente PG.
  const db = openDatabase(":memory:");
  const { server } = createApp({ db, config, persistence });
  const close = async () => {
    server.stop();
    db.close();
    await persistence.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  console.log(`prime-board server listening on http://localhost:${server.port}`);
  console.log(`GraphQL endpoint: http://localhost:${server.port}/graphql`);
  console.log("database: PostgreSQL");
} else {
  const db = openDatabase(config.dbPath);
  const result = bootstrap(db);
  reportBootstrap(result.created, result.adminApiKey);

  const { server } = createApp({ db, config });
  console.log(`prime-board server listening on http://localhost:${server.port}`);
  console.log(`GraphQL endpoint: http://localhost:${server.port}/graphql`);
  console.log(`database: ${config.dbPath}`);
}
