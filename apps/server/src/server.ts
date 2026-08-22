// Servidor HTTP: /graphql (GraphQL Yoga, GraphiQL en dev), /health y raíz.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema, createYoga } from "graphql-yoga";
import { APP_NAME, APP_VERSION, typeDefs } from "@prime-board/schema";
import { resolveAuth, resolveLocalAuth } from "./auth/viewer.ts";
import { resolveLocalPostgresAuth, resolvePostgresAuth } from "./auth/postgres-viewer.ts";
import type { Config } from "./config.ts";
import type { Context } from "./graphql/context.ts";
import { resolvers } from "./graphql/resolvers.ts";
import { createRepoSync } from "./export/repo-sync.ts";
import { trackedRepoSync } from "./graphql/repo-sync-dispatch.ts";
import { WebhookDispatcher, type DispatcherOptions } from "./webhooks/dispatcher.ts";
import { resolveWorkspaceContext } from "./domain/workspace-context.ts";
import { apiError } from "./graphql/errors.ts";
import { getPostgresWorkspace } from "./domain/postgres-actors.ts";
import type { Persistence } from "./db/persistence.ts";

export interface AppDeps {
  db: Database;
  config: Config;
  webhookOptions?: DispatcherOptions;
  /** Persistence for domains migrated incrementally to PostgreSQL. */
  persistence?: Persistence;
}

export function createApp({ db, config, webhookOptions, persistence }: AppDeps) {
  const events = new WebhookDispatcher(db, webhookOptions ?? { log: console.error });
  const repo = persistence ? null : createRepoSync(db, config.repoRoot);
  const yoga = createYoga({
    schema: createSchema<Context>({ typeDefs, resolvers }),
    graphqlEndpoint: "/graphql",
    graphiql: config.dev,
    landingPage: false,
    // En dev exponemos el error original; en prod se enmascara como corresponde.
    maskedErrors: !config.dev,
    // Un TrackedRepoSync fresco por request (AT-191): dos requests concurrentes
    // no se pisan el rastreo de "¿ya sincronizó?" — delega en el mismo `repo`
    // singleton, así que la escritura en sí sigue siendo una sola por mutation.
    context: async ({ request }): Promise<Context> => {
      const workspaceSelector = request.headers.get("x-workspace-id")?.trim() || null;
      const auth =
        config.authMode === "local"
          ? persistence
            ? await resolveLocalPostgresAuth(persistence)
            : resolveLocalAuth(db)
          : persistence
            ? await resolvePostgresAuth(
                persistence,
                request.headers.get("authorization"),
                workspaceSelector,
              )
            : resolveAuth(db, request.headers.get("authorization"), workspaceSelector);
      if (!auth && workspaceSelector) {
        throw apiError("UNAUTHORIZED", "A valid API key is required");
      }
      const workspace = persistence
        ? await getPostgresWorkspace(persistence, auth?.workspaceId)
        : resolveWorkspaceContext(db, auth?.workspaceId);
      if (!workspace) throw new Error("Workspace is not initialized");
      return {
        db,
        config,
        workspace: {
          workspaceId: persistence
            ? (workspace as { id: string }).id
            : (workspace as { workspaceId: string }).workspaceId,
        },
        viewer: auth?.actor ?? null,
        auth,
        events,
        repo: repo ? trackedRepoSync(repo) : null,
        persistence,
      };
    },
  });

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/graphql")) {
        return yoga.fetch(request);
      }
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      if (url.pathname === "/config") {
        return Response.json({ authMode: config.authMode });
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
