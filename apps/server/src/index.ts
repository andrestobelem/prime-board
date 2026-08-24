// Punto de entrada del servidor de prime-board.
// Config por variables de entorno con prefijo PRIME_BOARD_ (ver docs/specs/mvp.md §2).
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { bootstrap } from "./db/seed.ts";
import { migratePostgres } from "./db/postgres/migrator.ts";
import { bootstrapPostgres } from "./db/postgres/bootstrap.ts";
import { createPostgresPersistence } from "./db/postgres/persistence.ts";
import { createApp } from "./server.ts";
import { claimRuntimeOwnership } from "./runtime-ownership.ts";
import { storeBootstrapCredential } from "./auth/credentials.ts";

const config = loadConfig();
claimRuntimeOwnership(config.repoRoot ?? "", config.dbPath);

function serverUrl(port: number | undefined): string {
  const host =
    config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host;
  return `http://${host}:${port ?? config.port}`;
}

function reportBootstrap(created: boolean, adminApiKey?: string): void {
  if (!created) return;
  console.log("First run: workspace seeded.");
  if (config.authMode === "local") {
    console.log("Local auth mode is active; no API key is required.");
    return;
  }
  if (adminApiKey) {
    storeBootstrapCredential(config.repoRoot, config.dbPath, adminApiKey);
    console.log(
      "Admin API key stored outside the project under ~/.prime-board/credentials/ (mode 0600).",
    );
  }
}

if (config.persistenceBackend === "postgres") {
  if (!config.postgresUrl) {
    throw new Error("PRIME_BOARD_POSTGRES_URL is required when PRIME_BOARD_PERSISTENCE=postgres");
  }
  const sql = new Bun.SQL({ url: config.postgresUrl, max: 10, connectionTimeout: 5 });
  await migratePostgres(sql);
  const persistence = createPostgresPersistence(sql);
  const result = await bootstrapPostgres(persistence, config.bootstrap);
  reportBootstrap(result.created, result.adminApiKey);

  // Los dominios todavía no migrados conservan un SQLite efímero como seam de
  // compatibilidad; workspace/actors ya leen y escriben exclusivamente PG.
  const db = openDatabase(":memory:");
  const { server, events } = createApp({ db, config, persistence });
  const close = async () => {
    server.stop();
    await events.idle();
    db.close();
    await persistence.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  console.log(`prime-board server listening on ${serverUrl(server.port)}`);
  console.log(`GraphQL endpoint: ${serverUrl(server.port)}/graphql`);
  console.log("database: PostgreSQL");
} else {
  const db = openDatabase(config.dbPath);
  const result = bootstrap(db, config.bootstrap);
  reportBootstrap(result.created, result.adminApiKey);

  const { server } = createApp({ db, config });
  console.log(`prime-board server listening on ${serverUrl(server.port)}`);
  console.log(`GraphQL endpoint: ${serverUrl(server.port)}/graphql`);
  console.log(`database: ${config.dbPath}`);
}
