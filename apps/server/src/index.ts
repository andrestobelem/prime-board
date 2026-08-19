// Punto de entrada del servidor de prime-board.
// Config por variables de entorno con prefijo PRIME_BOARD_ (ver docs/specs/mvp.md §2).
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { bootstrap } from "./db/seed.ts";
import { createApp } from "./server.ts";

const config = loadConfig();
if (config.persistenceBackend !== "sqlite") {
  throw new Error("Configured persistence backend is not available yet");
}
const db = openDatabase(config.dbPath);

const result = bootstrap(db);
if (result.created && result.adminApiKey) {
  // La key se muestra una única vez: solo se persiste su hash.
  console.log("First run: workspace seeded.");
  console.log(`Admin API key (save it now, it will not be shown again): ${result.adminApiKey}`);
}

const { server } = createApp({ db, config });
console.log(`prime-board server listening on http://localhost:${server.port}`);
console.log(`GraphQL endpoint: http://localhost:${server.port}/graphql`);
console.log(`database: ${config.dbPath}`);
