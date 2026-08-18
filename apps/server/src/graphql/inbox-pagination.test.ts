// PRB-334: el inbox debe poder recorrer más de 100 entradas y exponer el unread completo.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("inbox pagination", () => {
  it("rechaza cursores inválidos en lugar de reiniciar la primera página", async () => {
    const malformed = await gql(
      app,
      `{ inboxPage(first: 10, after: "not-a-cursor") { nodes { id } } }`,
    );
    expect(malformed.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "cursor-agent", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id as string;
    const keyResult = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "cursor" }) { key } }`,
      { actorId },
    );
    const setup = await gql(app, `{ team(key: "PB") { states { id type } } }`);
    const stateId = setup.data!.team.states.find(
      (state: { id: string; type: string }) => state.type === "UNSTARTED",
    ).id;
    await gql(
      app,
      `mutation($assigneeId: ID!, $stateId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Cursor issue", assigneeId: $assigneeId, stateId: $stateId }) { success }
      }`,
      { assigneeId: actorId, stateId },
    );
    const key = keyResult.data!.apiKeyCreate.key as string;
    const first = await gql(app, `{ inboxPage(first: 1) { pageInfo { endCursor } } }`, {}, key);
    const cursor = first.data!.inboxPage.pageInfo.endCursor as string;
    const foreign = await gql(
      app,
      `query($cursor: String!) { inboxPage(first: 1, after: $cursor) { nodes { id } } }`,
      { cursor: `${cursor.slice(0, -1)}x` },
      key,
    );
    expect(foreign.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("paginates beyond 100 entries and counts unread items outside the first page", async () => {
    const setup = await gql(app, `{ viewer { id } team(key: "PB") { states { id type } } }`);
    const stateId = setup.data!.team.states.find(
      (state: { id: string; type: string }) => state.type === "UNSTARTED",
    ).id;
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "pagination-agent", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id;
    const keyResult = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "pagination" }) { key } }`,
      { actorId },
    );
    const key = keyResult.data!.apiKeyCreate.key;

    for (let index = 0; index < 105; index += 1) {
      await gql(
        app,
        `mutation($assigneeId: ID!, $stateId: ID!) {
          issueCreate(input: { teamKey: "PB", title: "Inbox ${index}", assigneeId: $assigneeId, stateId: $stateId }) { issue { id } }
        }`,
        { assigneeId: actorId, stateId },
      );
    }

    const first = await gql(
      app,
      `{ inboxPage(first: 100) { nodes { id isRead } pageInfo { hasNextPage endCursor } } inboxUnreadCount }`,
      {},
      key,
    );
    expect(first.errors).toBeUndefined();
    expect(first.data!.inboxPage.nodes).toHaveLength(100);
    expect(first.data!.inboxPage.pageInfo.hasNextPage).toBe(true);
    expect(first.data!.inboxUnreadCount).toBe(105);

    const second = await gql(
      app,
      `query($after: String!) { inboxPage(first: 100, after: $after) { nodes { id } pageInfo { hasNextPage } } }`,
      { after: first.data!.inboxPage.pageInfo.endCursor },
      key,
    );
    expect(second.errors).toBeUndefined();
    expect(second.data!.inboxPage.nodes).toHaveLength(5);
    expect(second.data!.inboxPage.pageInfo.hasNextPage).toBe(false);
  });
});
