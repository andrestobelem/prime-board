// PRB-476: el dispatcher de Webhooks no cruza el Workspace del evento.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { WebhookDispatcher } from "../webhooks/dispatcher.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let workspaceAKey: string;
let teamAId: string;
let issueAId: string;
let viewerId: string;
let workspaceBKey: string;

const delivered: string[] = [];

function makeFetch(): typeof fetch {
  const fetchFn = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    delivered.push(String(input));
    return new Response("ok");
  };
  return Object.assign(fetchFn, { preconnect: fetch.preconnect });
}

async function createWebhook(url: string, selector: string): Promise<void> {
  const result = await gql(
    app,
    `mutation($url: String!) { webhookCreate(input: { url: $url, events: ["issue.created"] }) { webhook { id } } }`,
    { url },
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

    const workspace = await gql(
      app,
      `mutation { workspaceCreate(input: { name: "Webhook B", urlKey: "webhook-b" }) { workspace { urlKey } } }`,
    );
    expect(workspace.errors).toBeUndefined();
    workspaceBKey = workspace.data!.workspaceCreate.workspace.urlKey;
    await createWebhook("https://hooks.example/b", workspaceBKey);
    await createWebhook("https://hooks.example/a", workspaceAKey);
  });

  afterAll(() => app.stop());

  it("entrega un evento solo a los hooks del Workspace del evento", async () => {
    delivered.length = 0;
    const dispatcher = new WebhookDispatcher(app.db, {
      retryDelays: [],
      fetchFn: makeFetch(),
    });

    dispatcher.emit(
      "issue.created",
      { id: viewerId, name: "admin", type: "HUMAN" },
      {
        id: issueAId,
        issueId: issueAId,
        teamId: teamAId,
      },
    );
    await dispatcher.idle();

    expect(delivered).toEqual(["https://hooks.example/a"]);
  });

  it("falla cerrado para un evento sin Workspace en una topología multi-Workspace", async () => {
    delivered.length = 0;
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
