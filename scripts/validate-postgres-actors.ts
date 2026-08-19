/**
 * Smoke GraphQL del dominio Workspace/Actors contra PostgreSQL.
 * Uso: PRIME_BOARD_POSTGRES_URL='postgres://...' bun run scripts/validate-postgres-actors.ts
 */
import { openDatabase } from "../apps/server/src/db/database.ts";
import { generateApiKey, hashApiKey } from "../apps/server/src/auth/keys.ts";
import { newId, now } from "../apps/server/src/db/util.ts";
import { bootstrapPostgres } from "../apps/server/src/db/postgres/bootstrap.ts";
import { migratePostgres } from "../apps/server/src/db/postgres/migrator.ts";
import { createPostgresPersistence } from "../apps/server/src/db/postgres/persistence.ts";
import { createApp } from "../apps/server/src/server.ts";
import type { Config } from "../apps/server/src/config.ts";

const url = process.env.PRIME_BOARD_POSTGRES_URL;
if (!url) {
  console.error("PRIME_BOARD_POSTGRES_URL is required");
  process.exit(2);
}

const sql = new Bun.SQL({ url, max: 10, connectionTimeout: 5 });
const db = openDatabase(":memory:");
let persistence: ReturnType<typeof createPostgresPersistence> | undefined;
let server: ReturnType<typeof createApp>["server"] | undefined;
const report: Record<string, unknown> = {};
const config: Config = {
  port: 0,
  dbPath: ":memory:",
  postgresUrl: url,
  persistenceBackend: "postgres",
  dev: false,
  webDist: "/tmp/prime-board-no-web",
  repoRoot: null,
};

async function graphql(
  base: string,
  query: string,
  variables?: Record<string, unknown>,
  token = adminKey,
) {
  const response = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as {
    data?: any;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
}

let adminKey = "";
try {
  await migratePostgres(sql);
  persistence = createPostgresPersistence(sql, { close: false });
  const seeded = await bootstrapPostgres(persistence);
  adminKey = seeded.adminApiKey ?? "";
  if (!adminKey) throw new Error("Validation requires a fresh PostgreSQL database");
  const app = createApp({ db, config, persistence });
  server = app.server;
  const base = `http://127.0.0.1:${server.port}`;

  const before = await graphql(
    base,
    `
      {
        workspace {
          id
          name
          urlKey
        }
        actors {
          id
          name
          status
        }
      }
    `,
  );
  const workspaceId = before.data?.workspace.id;
  const created = await graphql(
    base,
    `
      mutation ($input: ActorCreateInput!) {
        actorCreate(input: $input) {
          success
          actor {
            id
            name
            status
            type
          }
        }
      }
    `,
    { input: { name: "Postgres Agent", type: "AGENT" } },
  );
  const actorId = created.data?.actorCreate.actor.id;
  const member = await graphql(
    base,
    `
      mutation ($input: ActorCreateInput!) {
        actorCreate(input: $input) {
          success
          actor {
            id
            name
          }
        }
      }
    `,
    { input: { name: "Postgres Member", type: "HUMAN" } },
  );
  const memberId = member.data?.actorCreate.actor.id;
  const memberKey = generateApiKey();
  await persistence.execute(
    `INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [newId(), memberId, "member validation key", hashApiKey(memberKey), now()],
  );
  const memberViewer = await graphql(
    base,
    `
      {
        viewer {
          id
          status
        }
      }
    `,
    undefined,
    memberKey,
  );
  const memberDenied = await graphql(
    base,
    `
      mutation ($input: ActorCreateInput!) {
        actorCreate(input: $input) {
          success
          actor {
            id
          }
        }
      }
    `,
    { input: { name: "Denied Agent", type: "AGENT" } },
    memberKey,
  );
  const updated = await graphql(
    base,
    `
      mutation ($id: ID!, $input: ActorUpdateInput!) {
        actorUpdate(id: $id, input: $input) {
          success
          actor {
            id
            name
          }
        }
      }
    `,
    { id: actorId, input: { name: "Postgres Agent Updated" } },
  );
  const suspended = await graphql(
    base,
    `
      mutation ($id: ID!) {
        actorSuspend(id: $id) {
          success
          actor {
            id
            status
          }
        }
      }
    `,
    { id: actorId },
  );
  const reactivated = await graphql(
    base,
    `
      mutation ($id: ID!) {
        actorReactivate(id: $id) {
          success
          actor {
            id
            status
          }
        }
      }
    `,
    { id: actorId },
  );
  const workspace = await graphql(
    base,
    `
      mutation ($input: WorkspaceUpdateInput!) {
        workspaceUpdate(input: $input) {
          success
          workspace {
            id
            name
            urlKey
          }
        }
      }
    `,
    { input: { name: "Postgres Workspace" } },
  );
  const memberLeft = await graphql(
    base,
    `
      mutation {
        actorLeave {
          success
          actor {
            id
            status
          }
        }
      }
    `,
    undefined,
    memberKey,
  );
  const revoked = await graphql(
    base,
    `
      mutation ($id: ID!) {
        actorRevoke(id: $id) {
          success
          actor {
            id
            status
          }
        }
      }
    `,
    { id: actorId },
  );
  report.graphql =
    !before.errors &&
    !created.errors &&
    !updated.errors &&
    !suspended.errors &&
    !reactivated.errors &&
    !workspace.errors &&
    !revoked.errors;
  report.identity =
    workspace.data?.workspaceUpdate.workspace.id === workspaceId &&
    updated.data?.actorUpdate.actor.id === actorId &&
    revoked.data?.actorRevoke.actor.status === "LEFT";
  report.lifecycle =
    created.data?.actorCreate.actor.status === "ACTIVE" &&
    suspended.data?.actorSuspend.actor.status === "SUSPENDED" &&
    reactivated.data?.actorReactivate.actor.status === "ACTIVE";
  const finalWorkspace = await graphql(
    base,
    `
      {
        workspace {
          id
          name
        }
      }
    `,
  );
  report.updatedWorkspace =
    finalWorkspace.data?.workspace.id === workspaceId &&
    finalWorkspace.data?.workspace.name === "Postgres Workspace";
  report.authorization =
    memberViewer.data?.viewer.id === memberId &&
    memberDenied.errors?.[0]?.extensions?.code === "UNAUTHORIZED" &&
    memberLeft.data?.actorLeave.actor.id === memberId &&
    memberLeft.data?.actorLeave.actor.status === "LEFT";
  const passed = Object.values(report).every((value) => value === true);
  console.log(JSON.stringify({ passed, report }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  server?.stop();
  db.close();
  await persistence?.close();
  if (!persistence) await sql.close({ timeout: 5 });
}
