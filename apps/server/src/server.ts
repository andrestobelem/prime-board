// Servidor HTTP: /graphql (GraphQL Yoga, GraphiQL en dev), /health y raíz.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema, createYoga } from "graphql-yoga";
import { APP_NAME, APP_VERSION, typeDefs } from "@prime-board/schema";
import { resolveViewer } from "./auth/viewer.ts";
import type { Config } from "./config.ts";
import type { Context } from "./graphql/context.ts";
import { resolvers } from "./graphql/resolvers.ts";
import { createRepoSync } from "./export/repo-sync.ts";
import { WebhookDispatcher, type DispatcherOptions } from "./webhooks/dispatcher.ts";

export interface AppDeps {
  db: Database;
  config: Config;
  webhookOptions?: DispatcherOptions;
}

export function createApp({ db, config, webhookOptions }: AppDeps) {
  const events = new WebhookDispatcher(db, webhookOptions ?? { log: console.error });
  const repo = createRepoSync(db, config.repoRoot);
  const yoga = createYoga({
    schema: createSchema<Context>({ typeDefs, resolvers }),
    graphqlEndpoint: "/graphql",
    graphiql: config.dev,
    landingPage: false,
    // En dev exponemos el error original; en prod se enmascara como corresponde.
    maskedErrors: !config.dev,
    context: ({ request }): Context => ({
      db,
      config,
      viewer: resolveViewer(db, request.headers.get("authorization")),
      events,
      repo,
    }),
  });

  const server = Bun.serve({
    port: config.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/graphql")) {
        return yoga.fetch(request);
      }
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      // UI estática buildeada (si existe). Los clientes de API (sin Accept html
      // o rutas desconocidas no-GET) siguen recibiendo JSON.
      // Cache (AT-186): el HTML se revalida siempre (si no, un deploy deja al
      // browser con una UI vieja); los assets hasheados de Vite son inmutables.
      const cacheHeaders = (path: string): Record<string, string> => ({
        "cache-control": path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      if (request.method === "GET") {
        const assetPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const asset = Bun.file(join(config.webDist, assetPath.replaceAll("..", "")));
        if (await asset.exists()) {
          return new Response(asset, { headers: cacheHeaders(assetPath) });
        }
        // Fallback SPA: cualquier ruta navegable devuelve index.html.
        if (request.headers.get("accept")?.includes("text/html")) {
          const index = Bun.file(join(config.webDist, "index.html"));
          if (await index.exists())
            return new Response(index, { headers: cacheHeaders("/index.html") });
        }
      }

      if (url.pathname === "/") {
        return Response.json({ name: APP_NAME, version: APP_VERSION, graphql: "/graphql" });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  return { server, events };
}
