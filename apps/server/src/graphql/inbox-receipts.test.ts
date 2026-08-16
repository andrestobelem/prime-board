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
});
