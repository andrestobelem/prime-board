// Servidor HTTP: /graphql (GraphQL Yoga, GraphiQL en dev), /health y raíz.
import type { Database } from "bun:sqlite";
import { createSchema, createYoga } from "graphql-yoga";
import { APP_NAME, APP_VERSION, typeDefs } from "@prime-board/schema";
import { resolveViewer } from "./auth/viewer.ts";
import type { Config } from "./config.ts";
import type { Context } from "./graphql/context.ts";
import { resolvers } from "./graphql/resolvers.ts";

export interface AppDeps {
  db: Database;
  config: Config;
}

export function createApp({ db, config }: AppDeps) {
  const yoga = createYoga({
    schema: createSchema<Context>({ typeDefs, resolvers }),
    graphqlEndpoint: "/graphql",
    graphiql: config.dev,
    landingPage: false,
    context: ({ request }): Context => ({
      db,
      config,
      viewer: resolveViewer(db, request.headers.get("authorization")),
    }),
  });

  return Bun.serve({
    port: config.port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/graphql")) {
        return yoga.fetch(request);
      }
      if (url.pathname === "/") {
        return Response.json({ name: APP_NAME, version: APP_VERSION, graphql: "/graphql" });
      }
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
}
