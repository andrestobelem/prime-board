// PRB-476: Inbox no mezcla actividad ni receipts entre Workspaces.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { listInboxActivity } from "../domain/inbox.ts";

let app: TestApp;
let adminId: string;
let defaultWorkspaceId: string;
let otherWorkspaceId: string;
let defaultIssueId: string;
let otherIssueId: string;
let defaultInboxItemId: string;
let otherInboxItemId: string;
let defaultAgentKey: string;
let otherAgentKey: string;
let adminRow: ActorRow;

const errorCode = (result: { errors?: Array<{ extensions?: { code?: string } }> }) =>
  result.errors?.[0]?.extensions?.code;

beforeAll(async () => {
  app = createTestApp();
  const viewer = await gql(app, `{ viewer { id } }`);
  adminId = viewer.data!.viewer.id as string;
  defaultWorkspaceId = (
    app.db.query("SELECT id FROM workspace WHERE url_key = 'prime-board'").get() as { id: string }
  ).id;
  adminRow = app.db.query("SELECT * FROM actors WHERE id = ?1").get(adminId) as ActorRow;

  const defaultTeam = await gql(app, `{ team(key: "PB") { id } }`);
  const defaultTeamId = defaultTeam.data!.team.id as string;
  const defaultAgent = await gql(
    app,
    `mutation { actorCreate(input: { name: "default-inbox-agent", type: AGENT }) { actor { id } } }`,
  );
  const defaultAgentId = defaultAgent.data!.actorCreate.actor.id as string;
  const defaultMembership = await gql(
    app,
    `mutation($teamId: ID!, $actorId: ID!) {
      teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) { success }
    }`,
    { teamId: defaultTeamId, actorId: defaultAgentId },
  );
  expect(defaultMembership.errors).toBeUndefined();
  defaultAgentKey = (
    await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "default-inbox" }) { key } }`,
      { actorId: defaultAgentId },
    )
  ).data!.apiKeyCreate.key as string;

  const defaultIssue = await gql(
    app,
    `mutation($assigneeId: ID!) {
      issueCreate(input: { teamKey: "PB", title: "Default inbox issue", assigneeId: $assigneeId }) {
        issue { id }
      }
    }`,
    { assigneeId: adminId },
  );
  defaultIssueId = defaultIssue.data!.issueCreate.issue.id as string;
  const defaultComment = await gql(
    app,
    `mutation($issueId: ID!) { commentCreate(input: { issueId: $issueId, body: "Default inbox event" }) { success } }`,
    { issueId: defaultIssueId },
    defaultAgentKey,
  );
  expect(defaultComment.errors).toBeUndefined();

  const workspace = await gql(
    app,
    `mutation {
      workspaceCreate(input: { name: "Inbox other", urlKey: "inbox-other" }) {
        workspace { id urlKey }
      }
    }`,
  );
  expect(workspace.errors).toBeUndefined();
  otherWorkspaceId = workspace.data!.workspaceCreate.workspace.id as string;

  const otherTeams = await gql(app, `{ teams { id key } }`, {}, app.apiKey, "inbox-other");
  expect(otherTeams.errors).toBeUndefined();
  const otherTeamId = otherTeams.data!.teams[0].id as string;
  const otherTeamKey = otherTeams.data!.teams[0].key as string;
  const otherAgent = await gql(
    app,
    `mutation { actorCreate(input: { name: "other-inbox-agent", type: AGENT }) { actor { id } } }`,
    {},
    app.apiKey,
    "inbox-other",
  );
  const otherAgentId = otherAgent.data!.actorCreate.actor.id as string;
  const otherMembership = await gql(
    app,
    `mutation($teamId: ID!, $actorId: ID!) {
      teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) { success }
    }`,
    { teamId: otherTeamId, actorId: otherAgentId },
    app.apiKey,
    "inbox-other",
  );
  expect(otherMembership.errors).toBeUndefined();
  otherAgentKey = (
    await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "other-inbox" }) { key } }`,
      { actorId: otherAgentId },
      app.apiKey,
      "inbox-other",
    )
  ).data!.apiKeyCreate.key as string;

  const otherIssue = await gql(
    app,
    `mutation($assigneeId: ID!, $teamKey: String!) {
      issueCreate(input: { teamKey: $teamKey, title: "Other inbox issue", assigneeId: $assigneeId }) {
        issue { id }
      }
    }`,
    { assigneeId: adminId, teamKey: otherTeamKey },
    app.apiKey,
    "inbox-other",
  );
  expect(otherIssue.errors).toBeUndefined();
  otherIssueId = otherIssue.data!.issueCreate.issue.id as string;
  const otherComment = await gql(
    app,
    `mutation($issueId: ID!) { commentCreate(input: { issueId: $issueId, body: "Other inbox event" }) { success } }`,
    { issueId: otherIssueId },
    otherAgentKey,
    "inbox-other",
  );
  expect(otherComment.errors).toBeUndefined();

  const defaultInbox = await gql(
    app,
    `{ inbox { id issue { id } type payload } }`,
    {},
    app.apiKey,
    "prime-board",
  );
  expect(defaultInbox.errors).toBeUndefined();
  const defaultItem = (
    defaultInbox.data!.inbox as Array<{ id: string; issue: { id: string }; type: string }>
  ).find((item) => item.issue.id === defaultIssueId && item.type === "commented");
  expect(defaultItem).toBeTruthy();
  defaultInboxItemId = defaultItem!.id;

  const otherInbox = await gql(
    app,
    `{ inbox { id issue { id } type payload } }`,
    {},
    app.apiKey,
    "inbox-other",
  );
  expect(otherInbox.errors).toBeUndefined();
  const otherItem = (
    otherInbox.data!.inbox as Array<{ id: string; issue: { id: string }; type: string }>
  ).find((item) => item.issue.id === otherIssueId && item.type === "commented");
  expect(otherItem).toBeTruthy();
  otherInboxItemId = otherItem!.id;
});

afterAll(() => app.stop());

describe("aislamiento de Inbox por Workspace", () => {
  it("falla cerrado sin selector en una base multi-Workspace", () => {
    expect(() => listInboxActivity(app.db, adminRow, {})).toThrow(
      "Inbox requires a Workspace context",
    );
  });

  it("lista y cuenta solo la actividad del Workspace seleccionado", async () => {
    const defaultResult = await gql(
      app,
      `{ inbox { issue { id } payload } inboxUnreadCount }`,
      {},
      app.apiKey,
      "prime-board",
    );
    const otherResult = await gql(
      app,
      `{ inbox { issue { id } payload } inboxUnreadCount }`,
      {},
      app.apiKey,
      "inbox-other",
    );
    expect(defaultResult.errors).toBeUndefined();
    expect(otherResult.errors).toBeUndefined();
    expect(
      (defaultResult.data!.inbox as Array<{ issue: { id: string } }>).every(
        (item) => item.issue.id === defaultIssueId,
      ),
    ).toBe(true);
    expect(
      (otherResult.data!.inbox as Array<{ issue: { id: string } }>).every(
        (item) => item.issue.id === otherIssueId,
      ),
    ).toBe(true);
    expect(defaultResult.data!.inboxUnreadCount).toBe(1);
    expect(otherResult.data!.inboxUnreadCount).toBe(1);
  });

  it("rechaza receipts y cursores de otro Workspace sin mutar", async () => {
    const before = app.db
      .query(
        "SELECT count(*) AS count FROM inbox_receipts WHERE activity_id = ?1 AND actor_id = ?2",
      )
      .get(defaultInboxItemId, adminId) as { count: number };
    const rejected = await gql(
      app,
      `mutation($id: ID!) { inboxMarkRead(id: $id) { success } }`,
      { id: defaultInboxItemId },
      app.apiKey,
      "inbox-other",
    );
    expect(errorCode(rejected)).toBe("NOT_FOUND");
    const after = app.db
      .query(
        "SELECT count(*) AS count FROM inbox_receipts WHERE activity_id = ?1 AND actor_id = ?2",
      )
      .get(defaultInboxItemId, adminId) as { count: number };
    expect(after.count).toBe(before.count);

    const defaultPage = await gql(
      app,
      `{ inboxPage(first: 1) { pageInfo { endCursor } } }`,
      {},
      app.apiKey,
      "prime-board",
    );
    const cursor = defaultPage.data!.inboxPage.pageInfo.endCursor as string;
    const foreignCursor = await gql(
      app,
      `query($after: String!) { inboxPage(first: 1, after: $after) { nodes { id } } }`,
      { after: cursor },
      app.apiKey,
      "inbox-other",
    );
    expect(errorCode(foreignCursor)).toBe("VALIDATION_FAILED");

    const validRead = await gql(
      app,
      `mutation($id: ID!) { inboxMarkRead(id: $id) { inboxItem { id isRead } } }`,
      { id: defaultInboxItemId },
      app.apiKey,
      "prime-board",
    );
    expect(validRead.errors).toBeUndefined();
    const validArchive = await gql(
      app,
      `mutation($id: ID!) { inboxArchive(id: $id) { success } }`,
      { id: otherInboxItemId },
      app.apiKey,
      "inbox-other",
    );
    expect(validArchive.errors).toBeUndefined();

    const counts = await gql(app, `{ inboxUnreadCount }`, {}, app.apiKey, "prime-board");
    expect(counts.data!.inboxUnreadCount).toBe(0);
    expect(defaultWorkspaceId).not.toBe(otherWorkspaceId);
  });
});
