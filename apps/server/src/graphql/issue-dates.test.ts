// PRB-526: planificación y fechas de ciclo de vida de Issues.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("issue dates", () => {
  it("persists dueDate and applies deterministic lifecycle transitions", async () => {
    const team = await gql(app, `{ team(key: "PB") { id states { id type } } }`);
    const states = team.data!.team.states as Array<{ id: string; type: string }>;
    const stateBy = (type: string) => states.find((state) => state.type === type)!.id;
    const created = await gql(
      app,
      `mutation($teamId: ID!, $createdAt: DateTime!) {
        issueCreate(input: {
          teamId: $teamId, title: "Date fields", dueDate: "2026-03-10", createdAt: $createdAt
        }) { issue { id dueDate startedAt completedAt canceledAt } }
      }`,
      { teamId: team.data!.team.id, createdAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(created.errors).toBeUndefined();
    expect(created.data!.issueCreate.issue).toMatchObject({
      dueDate: "2026-03-10",
      startedAt: null,
      completedAt: null,
      canceledAt: null,
    });
    const id = created.data!.issueCreate.issue.id as string;
    const invalidCreate = await gql(
      app,
      `mutation($teamId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "Invalid date", dueDate: "not-a-date" }) {
          success
        }
      }`,
      { teamId: team.data!.team.id },
    );
    expect(invalidCreate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const invalidUpdate = await gql(
      app,
      `mutation($id: ID!) { issueUpdate(id: $id, input: { dueDate: "not-a-date" }) { success } }`,
      { id },
    );
    expect(invalidUpdate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const started = await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          issue { startedAt completedAt canceledAt state { type } }
        }
      }`,
      { id, stateId: stateBy("STARTED") },
    );
    expect(started.data!.issueUpdate.issue.state.type).toBe("STARTED");
    const startedAt = started.data!.issueUpdate.issue.startedAt;
    expect(startedAt).toEqual(expect.any(String));

    const completed = await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          issue { startedAt completedAt canceledAt }
        }
      }`,
      { id, stateId: stateBy("COMPLETED") },
    );
    expect(completed.data!.issueUpdate.issue.startedAt).toBe(startedAt);
    expect(completed.data!.issueUpdate.issue.completedAt).toEqual(expect.any(String));

    const reopened = await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          issue { startedAt completedAt canceledAt }
        }
      }`,
      { id, stateId: stateBy("STARTED") },
    );
    expect(reopened.data!.issueUpdate.issue).toMatchObject({
      startedAt,
      completedAt: null,
      canceledAt: null,
    });

    const canceled = await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { issue { canceledAt } }
      }`,
      { id, stateId: stateBy("CANCELED") },
    );
    expect(canceled.data!.issueUpdate.issue.canceledAt).toEqual(expect.any(String));
    const restored = await gql(
      app,
      `mutation($id: ID!, $stateId: ID!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { issue { canceledAt } }
      }`,
      { id, stateId: stateBy("BACKLOG") },
    );
    expect(restored.data!.issueUpdate.issue.canceledAt).toBeNull();
  });

  it("filters, orders and paginates by nullable dates", async () => {
    const teamId = (await gql(app, `{ team(key: "PB") { id } }`)).data!.team.id;
    await gql(
      app,
      `mutation($teamId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "With due date", dueDate: "2026-04-01" }) { success }
      }`,
      { teamId },
    );
    await gql(
      app,
      `mutation($teamId: ID!) {
        issueCreate(input: { teamId: $teamId, title: "Without due date" }) { success }
      }`,
      { teamId },
    );
    const filtered = await gql(
      app,
      `query { issues(filter: { dueDate: { eq: "2026-04-01" } }) { nodes { title dueDate } } }`,
    );
    expect(filtered.errors).toBeUndefined();
    expect(filtered.data!.issues.nodes).toEqual([
      { title: "With due date", dueDate: "2026-04-01" },
    ]);

    const first = await gql(
      app,
      `query { issues(orderBy: DUE_DATE_ASC, first: 1) {
        nodes { title dueDate } pageInfo { hasNextPage endCursor }
      } }`,
    );
    expect(first.errors).toBeUndefined();
    expect(first.data!.issues.pageInfo.hasNextPage).toBe(true);
    const second = await gql(
      app,
      `query($after: String!) { issues(orderBy: DUE_DATE_ASC, first: 20, after: $after) {
        nodes { title dueDate }
      } }`,
      { after: first.data!.issues.pageInfo.endCursor },
    );
    expect(second.errors).toBeUndefined();
    expect(second.data!.issues.nodes.length).toBeGreaterThan(0);
  });
});
