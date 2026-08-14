// Fábrica del servidor HTTP, separada del entrypoint para poder testearla.
// Por ahora expone un hello-world; el endpoint /graphql llega en AT-132.
import { APP_NAME, APP_VERSION } from "@prime-board/schema";

export function createServer(port = 0) {
  return Bun.serve({
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        return Response.json({
          name: APP_NAME,
          version: APP_VERSION,
          message: "hello from prime-board",
        });
      }
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
}
