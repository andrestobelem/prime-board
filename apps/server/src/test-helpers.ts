// Helper para tests: app completa sobre una DB en memoria con el seed corrido.
import { Database } from "bun:sqlite";
import { migrate } from "./db/database.ts";
import { bootstrap } from "./db/seed.ts";
import { createApp } from "./server.ts";
import { resolveBootstrapIdentity, type BootstrapIdentityInput } from "./db/bootstrap-config.ts";
import type { AuthMode, Config } from "./config.ts";
import type { WebhookDispatcher } from "./webhooks/dispatcher.ts";

export interface TestApp {
  db: Database;
  url: string;
  apiKey: string;
  events: WebhookDispatcher;
  stop: () => void;
}

export function createTestApp(
  repoRoot?: string,
  authMode: AuthMode = "api-key",
  bootstrapInput: BootstrapIdentityInput = {},
): TestApp {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  const bootstrapIdentity = resolveBootstrapIdentity(bootstrapInput);
  const seed = bootstrap(db, bootstrapIdentity);
  const config: Config = {
    port: 0,
    host: "127.0.0.1",
    authMode,
    dbPath: ":memory:",
    dev: true,
    webDist: "/nonexistent",
    repoRoot: repoRoot ?? null,
    bootstrap: bootstrapIdentity,
  };
  // Reintentos casi inmediatos para que los tests de webhooks sean rápidos.
  const { server, events } = createApp({ db, config, webhookOptions: { retryDelays: [5, 5, 5] } });
  return {
    db,
    url: `http://localhost:${server.port}`,
    apiKey: seed.adminApiKey!,
    events,
    stop: () => {
      server.stop(true);
      db.close();
    },
  };
}

/** Ejecuta una operación GraphQL contra la app de test. */
export async function gql(
  app: TestApp,
  query: string,
  variables: Record<string, unknown> = {},
  apiKey: string | null = app.apiKey,
  workspaceSelector: string | null = null,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (workspaceSelector) headers["x-workspace-id"] = workspaceSelector;
  const response = await fetch(`${app.url}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
}

/**
 * Workspace aislado para pruebas cross-workspace.
 *
 * No se conecta a `createApp`: representa el origen de IDs ajenos en otra DB en
 * memoria. La app bajo prueba conserva exactamente un Workspace operativo y
 * solo recibe referencias (IDs) de este fixture. Esto evita sembrar una segunda
 * fila en la DB singleton mientras permite probar entidades y relaciones reales.
 */
export interface DetachedWorkspaceFixture {
  db: Database;
  workspaceId: string;
  actorId: string;
  teamId: string;
  issueId: string;
  issueIdentifier: string;
  relatedIssueId: string;
  relatedIssueIdentifier: string;
  projectId: string;
  relationId: string;
  webhookId: string;
  close: () => void;
}

export function createDetachedWorkspaceFixture(): DetachedWorkspaceFixture {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  bootstrap(db);

  const workspace = db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
  const actor = db.query("SELECT id FROM actors WHERE name = 'admin' LIMIT 1").get() as {
    id: string;
  };
  const team = db.query("SELECT id, key FROM teams WHERE key = 'PB'").get() as {
    id: string;
    key: string;
  };
  const state = db
    .query("SELECT id FROM workflow_states WHERE team_id = ?1 ORDER BY position LIMIT 1")
    .get(team.id) as { id: string };
  const createdAt = "2026-08-18T00:00:00.000Z";
  const issueId = "foreign-issue-source";
  const relatedIssueId = "foreign-issue-related";
  const projectId = "foreign-project";
  const relationId = "foreign-relation";
  const webhookId = "foreign-webhook";

  db.transaction(() => {
    db.query(
      `INSERT INTO projects
       (id, name, description, state, lead_id, target_date, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'started', ?4, ?5, ?6, ?6)`,
    ).run(
      projectId,
      "Foreign project",
      "Only exists in the detached fixture",
      actor.id,
      "2026-12-31",
      createdAt,
    );
    db.query("INSERT INTO project_teams (project_id, team_id) VALUES (?1, ?2)").run(
      projectId,
      team.id,
    );
    const insertIssue = db.query(
      `INSERT INTO issues
       (id, team_id, number, title, description, state_id, priority, assignee_id,
        parent_id, project_id, milestone_id, cycle_id, creator_id, sort_order,
        created_at, updated_at, archived_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, NULL, ?7, NULL, NULL, ?8, 0, ?9, ?9, NULL)`,
    );
    insertIssue.run(
      issueId,
      team.id,
      900,
      "Foreign source issue",
      "Detached source",
      state.id,
      projectId,
      actor.id,
      createdAt,
    );
    insertIssue.run(
      relatedIssueId,
      team.id,
      901,
      "Foreign related issue",
      "Detached target",
      state.id,
      projectId,
      actor.id,
      createdAt,
    );
    db.query(
      `INSERT INTO issue_relations (id, issue_id, related_id, type, created_at)
       VALUES (?1, ?2, ?3, 'related', ?4)`,
    ).run(relationId, issueId, relatedIssueId, createdAt);
    db.query(
      `INSERT INTO webhooks (id, url, secret, events, enabled, created_at, owner_id)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)`,
    ).run(
      webhookId,
      "https://foreign.example/webhook",
      "foreign-secret",
      '["issue.created"]',
      createdAt,
      actor.id,
    );
  })();

  return {
    db,
    workspaceId: workspace.id,
    actorId: actor.id,
    teamId: team.id,
    issueId,
    issueIdentifier: `${team.key}-900`,
    relatedIssueId,
    relatedIssueIdentifier: `${team.key}-901`,
    projectId,
    relationId,
    webhookId,
    close: () => db.close(),
  };
}
