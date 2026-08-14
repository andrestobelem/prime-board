// Punto de entrada del servidor de prime-board.
// Config por variables de entorno con prefijo PRIME_BOARD_ (ver docs/specs/mvp.md §2).
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { bootstrap } from "./db/seed.ts";
import { createServer } from "./server.ts";

const config = loadConfig();
const db = openDatabase(config.dbPath);

const result = bootstrap(db);
if (result.created && result.adminApiKey) {
  // La key se muestra una única vez: solo se persiste su hash.
  console.log("First run: workspace seeded.");
  console.log(`Admin API key (save it now, it will not be shown again): ${result.adminApiKey}`);
}

const server = createServer(config.port);
console.log(`prime-board server listening on http://localhost:${server.port}`);
console.log(`database: ${config.dbPath}`);
