// PRB-476: el dispatcher de Webhooks no cruza el Workspace del evento.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { WebhookDispatcher } from "../webhooks/dispatcher.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let workspaceAKey: string;
let workspaceAId: string;
let teamAId: string;
let issueAId: string;
let projectAId: string;
let viewerId: string;
let workspaceBKey: string;
let workspaceBId: string;
let deletedTeamBId: string;

const delivered: string[] = [];
const bodies: string[] = [];

function makeFetch(): typeof fetch {
  const fetchFn = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    delivered.push(String(input));
    bodies.push(String(init?.body ?? ""));
    return new Response("ok");
  };
  return Object.assign(fetchFn, { preconnect: fetch.preconnect });
}

async function createWebhook(
  url: string,
  selector: string,
  events: string[] = ["issue.created"],
): Promise<void> {
  const result = await gql(
    app,
    `mutation($url: String!, $events: [String!]) { webhookCreate(input: { url: $url, events: $events }) { webhook { id } } }`,
    { url, events },
    app.apiKey,
    selector,
  );
  expect(result.errors).toBeUndefined();
}

describe("workspace scope for webhook dispatch", () => {
  beforeAll(async () => {
    app = createTestApp();
    const initial = await gql(
      app,
      `{ workspace { id urlKey } viewer { id } team(key: "PB") { id } }`,
    );
    expect(initial.errors).toBeUndefined();
    workspaceAKey = initial.data!.workspace.urlKey;
    workspaceAId = initial.data!.workspace.id;
    viewerId = initial.data!.viewer.id;
    teamAId = initial.data!.team.id;
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "A event" }) { issue { id } } }`,
      {},
      app.apiKey,
      workspaceAKey,
    );
    expect(issue.errors).toBeUndefined();
    issueAId = issue.data!.issueCreate.issue.id;
    const project = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "A project", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: teamAId },
      app.apiKey,
      workspaceAKey,
    );
    expect(project.errors).toBeUndefined();
    projectAId = project.data!.projectCreate.project.id;

    const workspace = await gql(
      app,
      `mutation { workspaceCreate(input: { name: "Webhook B", urlKey: "webhook-b" }) { workspace { id urlKey } } }`,
    );
    expect(workspace.errors).toBeUndefined();
    workspaceBId = workspace.data!.workspaceCreate.workspace.id;
    workspaceBKey = workspace.data!.workspaceCreate.workspace.urlKey;
    await createWebhook("https://hooks.example/b", workspaceBKey);
    await createWebhook("https://hooks.example/b-all", workspaceBKey, ["*"]);
    await createWebhook("https://hooks.example/a", workspaceAKey);
    await createWebhook("https://hooks.example/a-deleted", workspaceAKey, ["team.deleted"]);

    const team = await gql(
      app,
      `mutation { teamCreate(input: { name: "Deleted B", key: "DB" }) { team { id key } } }`,
      {},
      app.apiKey,
      workspaceBKey,
    );
    expect(team.errors).toBeUndefined();
    deletedTeamBId = team.data!.teamCreate.team.id;
    const deleted = await gql(
      app,
      `mutation($id: ID!, $confirmation: String!) { teamDelete(id: $id, confirmation: $confirmation) { success } }`,
      { id: deletedTeamBId, confirmation: "DB" },
      app.apiKey,
      workspaceBKey,
    );
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data!.teamDelete.success).toBe(true);
    await app.events.idle();
    delivered.length = 0;
    bodies.length = 0;
  });

  afterAll(() => app.stop());

  it("entrega un evento solo a los hooks del Workspace del evento", async () => {
    delivered.length = 0;
    bodies.length = 0;
    const dispatcher = new WebhookDispatcher(app.db, {
      retryDelays: [],
      fetchFn: makeFetch(),
    });

    dispatcher.emit(
      "issue.created",
      { id: viewerId, name: "admin", type: "HUMAN" },
      {
        id: issueAId,
        teamId: teamAId,
      },
    );
    await dispatcher.idle();

    expect(delivered).toEqual(["https://hooks.example/a"]);
    expect(JSON.parse(bodies[0]!).workspaceId).toBe(workspaceAId);
  });

  it("falla cerrado si un Team borrado de otro Workspace se reenvía a A", async () => {
    delivered.length = 0;
    bodies.length = 0;
    const dispatcher = new WebhookDispatcher(app.db, {
      retryDelays: [],
      fetchFn: makeFetch(),
    });

    // El Team existió en B, pero ya no hay una fila que permita inferir su
    // Workspace. Un snapshot de owners no prueba el origen del evento.
    dispatcher.emitForWorkspace(
      workspaceAId,
      "team.deleted",
      { id: viewerId, name: "admin", type: "HUMAN" },
      {
        id: deletedTeamBId,
        teamId: deletedTeamBId,
        _teamOwnerIds: [viewerId],
      },
    );
    await dispatcher.idle();

    expect(delivered).toHaveLength(0);
    expect(bodies).toHaveLength(0);
  });

  it("mantiene la semántica legacy de issueId en SQLite", async () => {
    delivered.length = 0;
    bodies.length = 0;
    const dispatcher = new WebhookDispatcher(app.db, {
      retryDelays: [],
      fetchFn: makeFetch(),
    });

    dispatcher.emitForWorkspace(
      workspaceAId,
      "issue.created",
      { id: viewerId, name: "admin", type: "HUMAN" },
      { issueId: issueAId, teamId: teamAId },
    );
    await dispatcher.idle();

    expect(delivered).toEqual(["https://hooks.example/a"]);
  });

  it("falla cerrado para una Issue canónica inexistente aunque el Team sea válido", async () => {
    const hook = await gql(
      app,
      `mutation($url: String!, $teamId: ID!) {
        webhookCreate(input: { url: $url, events: ["issue.created"], teamId: $teamId }) {
          webhook { id }
        }
      }`,
      { url: "https://hooks.example/a-limited", teamId: teamAId },
      app.apiKey,
      workspaceAKey,
    );
    expect(hook.errors).toBeUndefined();

    delivered.length = 0;
    bodies.length = 0;
    const dispatcher = new WebhookDispatcher(app.db, {
      retryDelays: [],
      fetchFn: makeFetch(),
    });

    dispatcher.emitForWorkspace(
      workspaceAId,
      "issue.created",
      { id: viewerId, name: "admin", type: "HUMAN" },
      { id: "missing-canonical-issue", teamId: teamAId },
    );
    await dispatcher.idle();

    expect(delivered).toHaveLength(0);
    expect(bodies).toHaveLength(0);
    await gql(app, `mutation($id: ID!) { webhookDelete(id: $id) { success } }`, {
      id: hook.data!.webhookCreate.webhook.id,
    });
  });

  it("falla cerrado si el recurso no pertenece al Workspace explícito", async () => {
    delivered.length = 0;
    bodies.length = 0;
    const dispatcher = new WebhookDispatcher(app.db, {
      retryDelays: [],
      fetchFn: makeFetch(),
    });

    // El Team y la Issue son de A, pero el envelope afirma que el evento es
    // de B. Un Team lookup vacío no debe convertirse en un broadcast a B.
    dispatcher.emitForWorkspace(
      workspaceBId,
      "issue.created",
      { id: viewerId, name: "admin", type: "HUMAN" },
      { id: issueAId, issueId: issueAId, teamId: teamAId },
    );
    await dispatcher.idle();

    expect(delivered).toHaveLength(0);
    expect(bodies).toHaveLength(0);
  });

  it("falla cerrado para Teams y Projects de otro Workspace", async () => {
    delivered.length = 0;
    bodies.length = 0;
    const dispatcher = new WebhookDispatcher(app.db, {
      retryDelays: [],
      fetchFn: makeFetch(),
    });

    dispatcher.emitForWorkspace(
      workspaceBId,
      "team.created",
      { id: viewerId, name: "admin", type: "HUMAN" },
      { id: teamAId, teamId: teamAId, key: "PB", name: "A team" },
    );
    dispatcher.emitForWorkspace(
      workspaceBId,
      "project.updated",
      { id: viewerId, name: "admin", type: "HUMAN" },
      { id: projectAId },
    );
    await dispatcher.idle();

    expect(delivered).toHaveLength(0);
    expect(bodies).toHaveLength(0);
  });

  it("detiene un retry cuando el owner queda suspendido", async () => {
    delivered.length = 0;
    bodies.length = 0;
    let attempts = 0;
    const dispatcher = new WebhookDispatcher(app.db, {
      retryDelays: [0, 0],
      fetchFn: Object.assign(
        async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
          attempts += 1;
          delivered.push(String(input));
          if (attempts === 1) {
            app.db.query("UPDATE actors SET status = 'suspended' WHERE id = ?1").run(viewerId);
            app.db
              .query(
                "UPDATE workspace_memberships SET status = 'suspended' WHERE actor_id = ?1 AND workspace_id = ?2",
              )
              .run(viewerId, workspaceAId);
            return new Response("retry", { status: 503 });
          }
          return new Response("ok");
        },
        { preconnect: fetch.preconnect },
      ),
    });

    dispatcher.emit(
      "issue.created",
      { id: viewerId, name: "admin", type: "HUMAN" },
      { id: issueAId, issueId: issueAId, teamId: teamAId },
    );
    await dispatcher.idle();

    expect(attempts).toBe(1);
    expect(delivered).toEqual(["https://hooks.example/a"]);
    app.db.query("UPDATE actors SET status = 'active' WHERE id = ?1").run(viewerId);
    app.db
      .query(
        "UPDATE workspace_memberships SET status = 'active' WHERE actor_id = ?1 AND workspace_id = ?2",
      )
      .run(viewerId, workspaceAId);
  });

  it("falla cerrado para un evento sin Workspace en una topología multi-Workspace", async () => {
    delivered.length = 0;
    bodies.length = 0;
    const dispatcher = new WebhookDispatcher(app.db, {
      retryDelays: [],
      fetchFn: makeFetch(),
    });

    dispatcher.emit(
      "team.deleted",
      { id: viewerId, name: "admin", type: "HUMAN" },
      {
        id: "deleted-team-without-context",
        teamId: "deleted-team-without-context",
        _teamOwnerIds: [viewerId],
      },
    );
    await dispatcher.idle();

    expect(delivered).toHaveLength(0);
  });
});
