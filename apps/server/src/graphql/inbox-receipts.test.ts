// PRB-210: marcar leído y archivar entradas del inbox.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("inbox receipts", () => {
  it("marca leído y archiva una entrada del inbox del viewer", async () => {
    const agent = await gql(
      app,
      `mutation { actorCreate(input: { name: "receipt-agent", type: AGENT }) { actor { id } } }`,
    );
    const agentId = agent.data!.actorCreate.actor.id;
    const key = (
      await gql(
        app,
        `mutation($actorId: ID!) {
          apiKeyCreate(input: { actorId: $actorId, name: "r" }) { key }
        }`,
        { actorId: agentId },
      )
    ).data!.apiKeyCreate.key;

    const issue = await gql(
      app,
      `mutation($assigneeId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Inbox item", assigneeId: $assigneeId }) {
          issue { id }
        }
      }`,
      { assigneeId: agentId },
    );
    await gql(
      app,
      `mutation($issueId: ID!) {
        commentCreate(input: { issueId: $issueId, body: "hey" }) { comment { id } }
      }`,
      { issueId: issue.data!.issueCreate.issue.id },
    );

    const inbox = await gql(app, `{ inbox { id isRead isArchived } }`, {}, key);
    expect(inbox.errors).toBeUndefined();
    expect(inbox.data!.inbox.length).toBeGreaterThan(0);
    expect(inbox.data!.inbox.every((item: { isRead: boolean }) => item.isRead === false)).toBe(
      true,
    );

    const firstId = inbox.data!.inbox[0].id;
    await gql(
      app,
      `mutation($id: ID!) { inboxMarkRead(id: $id) { success inboxItem { id isRead } } }`,
      { id: firstId },
      key,
    );

    const afterRead = await gql(app, `{ inbox { id isRead } }`, {}, key);
    expect(afterRead.data!.inbox.find((i: { id: string }) => i.id === firstId).isRead).toBe(true);

    await gql(
      app,
      `mutation($id: ID!) { inboxArchive(id: $id) { success } }`,
      { id: firstId },
      key,
    );
    const afterArchive = await gql(app, `{ inbox { id } }`, {}, key);
    expect(afterArchive.data!.inbox.some((i: { id: string }) => i.id === firstId)).toBe(false);

    const withArchived = await gql(
      app,
      `{ inbox(includeArchived: true) { id isArchived } }`,
      {},
      key,
    );
    expect(
      withArchived.data!.inbox.some(
        (i: { id: string; isArchived: boolean }) => i.id === firstId && i.isArchived,
      ),
    ).toBe(true);
  });

  it("no deja un receipt al rechazar mark-read para una actividad irrelevante", async () => {
    const agent = await gql(
      app,
      `mutation { actorCreate(input: { name: "orphan-read-agent", type: AGENT }) { actor { id } } }`,
    );
    const agentId = agent.data!.actorCreate.actor.id;
    const key = (
      await gql(
        app,
        `mutation($actorId: ID!) {
          apiKeyCreate(input: { actorId: $actorId, name: "orphan-read" }) { key }
        }`,
        { actorId: agentId },
      )
    ).data!.apiKeyCreate.key;
    const states = await gql(app, `{ team(key: "PB") { states { id type } } }`);
    const startedId = states.data!.team.states.find(
      (state: { type: string }) => state.type === "STARTED",
    ).id;
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Orphan read target" }) { issue { id } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id;
    await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId: startedId },
    );
    const activity = await gql(app, `query($id: ID!) { issue(id: $id) { activity { id type } } }`, {
      id: issueId,
    });
    const activityId = activity.data!.issue.activity.find(
      (event: { type: string }) => event.type === "state_changed",
    ).id;
    expect(
      app.db
        .query("SELECT 1 FROM inbox_receipts WHERE activity_id = ?1 AND actor_id = ?2")
        .all(activityId, agentId),
    ).toEqual([]);

    const rejected = await gql(
      app,
      `mutation($id: ID!) { inboxMarkRead(id: $id) { success } }`,
      { id: activityId },
      key,
    );
    expect(rejected.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(
      app.db
        .query(
          "SELECT read_at, archived_at FROM inbox_receipts WHERE activity_id = ?1 AND actor_id = ?2",
        )
        .all(activityId, agentId),
    ).toEqual([]);
  });

  it("permite marcar una entrada válida fuera de la primera página", async () => {
    const agent = await gql(
      app,
      `mutation { actorCreate(input: { name: "deep-inbox-agent", type: AGENT }) { actor { id } } }`,
    );
    const agentId = agent.data!.actorCreate.actor.id;
    const key = (
      await gql(
        app,
        `mutation($actorId: ID!) {
          apiKeyCreate(input: { actorId: $actorId, name: "deep-inbox" }) { key }
        }`,
        { actorId: agentId },
      )
    ).data!.apiKeyCreate.key;
    const issue = await gql(
      app,
      `mutation($assigneeId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Deep inbox target", assigneeId: $assigneeId }) {
          issue { id }
        }
      }`,
      { assigneeId: agentId },
    );
    const issueId = issue.data!.issueCreate.issue.id;
    const created = await gql(app, `query($id: ID!) { issue(id: $id) { activity { id type } } }`, {
      id: issueId,
    });
    const targetId = created.data!.issue.activity.find(
      (event: { type: string }) => event.type === "created",
    ).id;

    for (let index = 0; index < 105; index += 1) {
      const comment = await gql(
        app,
        `mutation($issueId: ID!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success }
        }`,
        { issueId, body: `deep inbox noise ${index}` },
      );
      expect(comment.errors).toBeUndefined();
    }

    const marked = await gql(
      app,
      `mutation($id: ID!) { inboxMarkRead(id: $id) { success inboxItem { id isRead } } }`,
      { id: targetId },
      key,
    );
    expect(marked.errors).toBeUndefined();
    expect(marked.data!.inboxMarkRead.inboxItem).toMatchObject({ id: targetId, isRead: true });
  });

  it("no deja un receipt al rechazar archive para una actividad irrelevante", async () => {
    const agent = await gql(
      app,
      `mutation { actorCreate(input: { name: "orphan-archive-agent", type: AGENT }) { actor { id } } }`,
    );
    const agentId = agent.data!.actorCreate.actor.id;
    const key = (
      await gql(
        app,
        `mutation($actorId: ID!) {
          apiKeyCreate(input: { actorId: $actorId, name: "orphan-archive" }) { key }
        }`,
        { actorId: agentId },
      )
    ).data!.apiKeyCreate.key;
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Orphan archive target" }) { issue { id } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id;
    await gql(
      app,
      `mutation($id: ID!) { issueUpdate(id: $id, input: { priority: 1 }) { success } }`,
      { id: issueId },
    );
    const activity = await gql(app, `query($id: ID!) { issue(id: $id) { activity { id type } } }`, {
      id: issueId,
    });
    const activityId = activity.data!.issue.activity.find(
      (event: { type: string }) => event.type === "priority_changed",
    ).id;
    const rejected = await gql(
      app,
      `mutation($id: ID!) { inboxArchive(id: $id) { success } }`,
      { id: activityId },
      key,
    );
    expect(rejected.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(
      app.db
        .query(
          "SELECT read_at, archived_at FROM inbox_receipts WHERE activity_id = ?1 AND actor_id = ?2",
        )
        .all(activityId, agentId),
    ).toEqual([]);
  });
});
