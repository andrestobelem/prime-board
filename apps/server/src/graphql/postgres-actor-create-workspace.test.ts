// PRB-667: actorCreate asigna el Actor solo al Workspace efectivo en PostgreSQL.
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { newId, now } from "../db/util.ts";
import { createApp } from "../server.ts";
import type { Config } from "../config.ts";

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

type GraphqlResponse<T> =
  | { kind: "data"; data: T }
  | { kind: "errors"; errors: GraphqlError[] }
  | { kind: "partial"; data: T | null; errors: GraphqlError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGraphqlError(value: unknown): value is GraphqlError {
  if (!isRecord(value) || typeof value.message !== "string") return false;
  if (value.extensions === undefined) return true;
  if (!isRecord(value.extensions)) return false;
  return value.extensions.code === undefined || typeof value.extensions.code === "string";
}

function parseGraphqlErrors(value: unknown): GraphqlError[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("GraphQL response errors must be a non-empty array");
  }
  const errors: GraphqlError[] = [];
  for (const error of value) {
    if (!isGraphqlError(error)) throw new Error("GraphQL response contains an invalid error");
    errors.push(error);
  }
  return errors;
}

function parseGraphqlResponse<T>(
  value: unknown,
  isData: (value: unknown) => value is T,
): GraphqlResponse<T> {
  if (!isRecord(value)) throw new Error("GraphQL response must be an object");
  const hasData = "data" in value;
  const hasErrors = "errors" in value;
  if (!hasData && !hasErrors) throw new Error("GraphQL response has no data or errors");

  if (hasErrors) {
    const errors = parseGraphqlErrors(value.errors);
    if (!hasData) return { kind: "errors", errors };
    if (value.data !== null && !isData(value.data)) {
      throw new Error("GraphQL response data has an unexpected shape");
    }
    return { kind: "partial", data: value.data, errors };
  }

  if (!isData(value.data)) throw new Error("GraphQL response data has an unexpected shape");
  return { kind: "data", data: value.data };
}

interface Actor {
  id: string;
  name: string;
  workspaceId: string;
}

interface ActorCreateData {
  actorCreate: {
    success: boolean;
    actor: Actor;
  };
}

interface ActorsData {
  actors: Actor[];
}

function isActor(value: unknown): value is Actor {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.workspaceId === "string"
  );
}

function isActorCreateData(value: unknown): value is ActorCreateData {
  if (!isRecord(value) || !isRecord(value.actorCreate)) return false;
  return typeof value.actorCreate.success === "boolean" && isActor(value.actorCreate.actor);
}

function isActorsData(value: unknown): value is ActorsData {
  return isRecord(value) && Array.isArray(value.actors) && value.actors.every(isActor);
}

function requireGraphqlData<T>(response: GraphqlResponse<T>): T {
  if (response.kind !== "data") {
    throw new Error("GraphQL response did not return complete data");
  }
  return response.data;
}

const postgresUrl = process.env.PRIME_BOARD_POSTGRES_URL;
const integration = postgresUrl ? it : it.skip;

describe("Alcance de Workspace de actorCreate en PostgreSQL", () => {
  integration(
    "crea el Actor solo en el Workspace efectivo y aísla la raíz de actores",
    async () => {
      if (!postgresUrl) throw new Error("PRIME_BOARD_POSTGRES_URL is required");
      const harness = await createPostgresHarness({
        url: postgresUrl,
        schemaPrefix: "prb667_actor_create",
        lockKey: `prb667-actor-create-${randomUUID()}`,
      });
      const persistence = createPostgresPersistence(harness.sql, {
        close: false,
      });
      const db = openDatabase(":memory:");
      let stop: (() => void) | undefined;
      try {
        const seeded = await bootstrapPostgres(persistence);
        const adminApiKey = seeded.adminApiKey;
        if (!adminApiKey) throw new Error("PostgreSQL bootstrap did not issue an API key");
        const config = {
          port: 0,
          host: "127.0.0.1",
          authMode: "api-key",
          dbPath: ":memory:",
          postgresUrl,
          persistenceBackend: "postgres",
          dev: false,
          webDist: "/tmp/prime-board-no-web",
          repoRoot: null,
          bootstrap: resolveBootstrapIdentity({}),
        } satisfies Config;
        const app = createApp({ db, config, persistence });
        stop = () => app.server.stop();

        const request = async <T>(
          query: string,
          isData: (value: unknown) => value is T,
          options: { token?: string; workspaceSelector?: string } = {},
        ): Promise<GraphqlResponse<T>> => {
          const headers: Record<string, string> = {
            "content-type": "application/json",
            authorization: `Bearer ${options.token ?? adminApiKey}`,
          };
          if (options.workspaceSelector) headers["x-workspace-id"] = options.workspaceSelector;
          const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
            method: "POST",
            headers,
            body: JSON.stringify({ query }),
          });
          const body: unknown = await response.json();
          return parseGraphqlResponse(body, isData);
        };

        const workspaceA = await persistence.one<{ id: string }>(
          "SELECT id FROM workspace ORDER BY created_at, id LIMIT 1",
        );
        const admin = await persistence.one<{ id: string }>(
          "SELECT id FROM actors WHERE name = 'admin'",
        );
        if (!workspaceA || !admin) throw new Error("PostgreSQL Actor fixture is incomplete");

        await persistence.execute("DROP INDEX workspace_singleton_idx");
        const workspaceBId = newId();
        const timestamp = now();
        await persistence.execute(
          `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
           VALUES ($1, 'PRB-667 Workspace B', 'prb667-b', $2, $2)`,
          [workspaceBId, timestamp],
        );
        await persistence.execute(
          `INSERT INTO workspace_memberships
           (id, workspace_id, actor_id, role, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'admin', 'active', $4, $4)`,
          [newId(), workspaceBId, admin.id, timestamp],
        );
        const adminKey = await persistence.one<{ id: string }>(
          "SELECT id FROM api_keys WHERE actor_id = $1 ORDER BY created_at, id LIMIT 1",
          [admin.id],
        );
        if (!adminKey) throw new Error("PostgreSQL Actor key fixture is incomplete");
        await persistence.execute(
          `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
           VALUES ($1, $2, 0, $3)`,
          [adminKey.id, workspaceBId, timestamp],
        );

        const createdResponse = await request<ActorCreateData>(
          `mutation {
             actorCreate(input: { name: "PRB-667 scoped actor", type: AGENT }) {
               success
               actor { id name workspaceId }
             }
           }`,
          isActorCreateData,
          { workspaceSelector: workspaceBId },
        );
        expect(createdResponse.kind).toBe("data");
        const created = requireGraphqlData(createdResponse);
        expect(created.actorCreate.success).toBe(true);
        const actor = created.actorCreate.actor;
        expect(actor).toMatchObject({ name: "PRB-667 scoped actor", workspaceId: workspaceBId });

        const memberships = await persistence.many<{
          workspace_id: string;
          role: string;
          status: string;
        }>(
          `SELECT workspace_id, role, status
           FROM workspace_memberships
           WHERE actor_id = $1
           ORDER BY workspace_id`,
          [actor.id],
        );
        expect(memberships).toEqual([
          { workspace_id: workspaceBId, role: "member", status: "active" },
        ]);

        const actorsAResponse = await request<ActorsData>(
          "{ actors { id name workspaceId } }",
          isActorsData,
          { workspaceSelector: workspaceA.id },
        );
        expect(actorsAResponse.kind).toBe("data");
        const actorsA = requireGraphqlData(actorsAResponse);
        expect(actorsA.actors.map((item) => item.id)).not.toContain(actor.id);

        const actorsBResponse = await request<ActorsData>(
          "{ actors { id name workspaceId } }",
          isActorsData,
          { workspaceSelector: workspaceBId },
        );
        expect(actorsBResponse.kind).toBe("data");
        const actorsB = requireGraphqlData(actorsBResponse);
        expect(actorsB.actors).toContainEqual(actor);
      } finally {
        stop?.();
        db.close();
        await persistence.close();
        await harness.close();
      }
    },
  );
});
