// Punto de entrada del servidor de prime-board.
// Config por variables de entorno con prefijo PRIME_BOARD_ (ver docs/specs/mvp.md §2).
import { createServer } from "./server.ts";

const port = Number(process.env.PRIME_BOARD_PORT ?? 3333);
const server = createServer(port);
console.log(`prime-board server listening on http://localhost:${server.port}`);
