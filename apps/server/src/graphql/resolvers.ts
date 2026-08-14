// Resolvers raíz del esquema. Se ensamblan por dominio a medida que crece la API.
import { GraphQLScalarType, Kind } from "graphql";
import { mapActor } from "../domain/actors.ts";
import type { Context } from "./context.ts";
import { apiError, requireViewer } from "./errors.ts";

// Scalars passthrough: los timestamps viajan como strings ISO-8601 UTC.
const DateTime = new GraphQLScalarType({
  name: "DateTime",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? ast.value : null),
});

const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  serialize: (value) => value,
  parseValue: (value) => value,
});

export const resolvers = {
  DateTime,
  JSON: JSONScalar,
  ActorType: { HUMAN: "human", AGENT: "agent" },
  Query: {
    viewer: (_parent: unknown, _args: unknown, context: Context) =>
      mapActor(requireViewer(context)),
    workspace: (_parent: unknown, _args: unknown, context: Context) => {
      requireViewer(context);
      const row = context.db
        .query("SELECT id, name, url_key, created_at FROM workspace LIMIT 1")
        .get() as { id: string; name: string; url_key: string; created_at: string } | null;
      if (!row) throw apiError("NOT_FOUND", "Workspace is not initialized");
      return { id: row.id, name: row.name, urlKey: row.url_key, createdAt: row.created_at };
    },
  },
};
