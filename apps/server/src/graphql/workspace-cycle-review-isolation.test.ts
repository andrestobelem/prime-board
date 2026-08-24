// PRB-476: Cycles y Reviews deben quedar ocultos fuera de su Workspace.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let workspaceAId: string;
let workspaceBId: string;
let workspaceBKey: string;
let teamBId: string;
let cycleBId: string;
let reviewBId: string;
let issueBId: string;
let actorId: string;

describe("Cycle y Review Workspace isolation", () => {
  beforeAll(async () => {
    app = createTestApp();
    workspaceAId = (await gql(app, "{ workspace { id } }")).data!.workspace.id;
    actorId = (await gql(app, "{ viewer { id } }")).data!.viewer.id;

    const workspace = await gql(
      app,
      `mutation { workspaceCreate(input: { name: "Cycles B", urlKey: "cycles-b" }) { workspace { id urlKey } } }`,
    );
    expect(workspace.errors).toBeUndefined();
    workspaceBId = workspace.data!.workspaceCreate.workspace.id;
    workspaceBKey = workspace.data!.workspaceCreate.workspace.urlKey;

    const teams = await gql(app, "{ teams { id key } }", {}, app.apiKey, workspaceBKey);
    expect(teams.errors).toBeUndefined();
    teamBId = teams.data!.teams[0].id;
    const teamKey = teams.data!.teams[0].key;
    const issue = await gql(
      app,
      `mutation($teamKey: String!) { issueCreate(input: { teamKey: $teamKey, title: "B review issue" }) { issue { id } } }`,
      { teamKey },
      app.apiKey,
      workspaceBKey,
    );
    expect(issue.errors).toBeUndefined();
    issueBId = issue.data!.issueCreate.issue.id;

    const cycle = await gql(
      app,
      `mutation($teamId: ID!) { cycleCreate(input: { teamId: $teamId, name: "B cycle", startsAt: "2030-01-01", endsAt: "2030-01-14" }) { cycle { id } } }`,
      { teamId: teamBId },
      app.apiKey,
      workspaceBKey,
    );
    expect(cycle.errors).toBeUndefined();
    cycleBId = cycle.data!.cycleCreate.cycle.id;

    const review = await gql(
      app,
      `mutation($issueId: ID!, $reviewerId: ID!) { reviewCreate(input: { issueId: $issueId, reviewerId: $reviewerId }) { review { id } } }`,
      { issueId: issueBId, reviewerId: actorId },
      app.apiKey,
      workspaceBKey,
    );
    expect(review.errors).toBeUndefined();
    reviewBId = review.data!.reviewCreate.review.id;
  });

  afterAll(() => app.stop());

  it("oculta IDs cross-workspace y conserva el aislamiento en las filas", async () => {
    const fromA = await gql(
      app,
      `query($teamId: ID!, $cycleId: ID!, $reviewId: ID!) {
        cycles(teamId: $teamId) { id }
        cycle(id: $cycleId) { id }
        review(id: $reviewId) { id }
      }`,
      { teamId: teamBId, cycleId: cycleBId, reviewId: reviewBId },
    );
    expect(fromA.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(fromA.data).toBeNull();

    const directA = await gql(
      app,
      `query($cycleId: ID!, $reviewId: ID!) { cycle(id: $cycleId) { id } review(id: $reviewId) { id } }`,
      { cycleId: cycleBId, reviewId: reviewBId },
    );
    expect(directA.errors).toBeUndefined();
    expect(directA.data!.cycle).toBeNull();
    expect(directA.data!.review).toBeNull();
    const queueA = await gql(app, "{ reviews { nodes { id } } }");
    expect(queueA.errors).toBeUndefined();
    expect(queueA.data!.reviews.nodes).not.toContainEqual({ id: reviewBId });

    const fromB = await gql(
      app,
      `query($teamId: ID!, $cycleId: ID!, $reviewId: ID!) {
        cycles(teamId: $teamId) { id }
        cycle(id: $cycleId) { id }
        review(id: $reviewId) { id issue { id } }
        reviews { nodes { id } }
      }`,
      { teamId: teamBId, cycleId: cycleBId, reviewId: reviewBId },
      app.apiKey,
      workspaceBKey,
    );
    expect(fromB.errors).toBeUndefined();
    expect(fromB.data!.cycles).toContainEqual({ id: cycleBId });
    expect(fromB.data!.cycle).toEqual({ id: cycleBId });
    expect(fromB.data!.review).toEqual({ id: reviewBId, issue: { id: issueBId } });
    expect(fromB.data!.reviews.nodes).toContainEqual({ id: reviewBId });

    expect(
      (
        app.db.query("SELECT workspace_id FROM cycles WHERE id = ?1").get(cycleBId) as {
          workspace_id: string;
        }
      ).workspace_id,
    ).toBe(workspaceBId);
    expect(
      (
        app.db.query("SELECT workspace_id FROM reviews WHERE id = ?1").get(reviewBId) as {
          workspace_id: string;
        }
      ).workspace_id,
    ).toBe(workspaceBId);
    expect(workspaceAId).not.toBe(workspaceBId);
  });

  it("no permite mutar IDs de otro Workspace", async () => {
    const cycleUpdate = await gql(
      app,
      `mutation($id: ID!) { cycleUpdate(id: $id, input: { name: "hijacked" }) { success } }`,
      { id: cycleBId },
    );
    expect(cycleUpdate.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const reviewUpdate = await gql(
      app,
      `mutation($id: ID!) { reviewUpdate(id: $id, input: { status: APPROVED }) { success } }`,
      { id: reviewBId },
    );
    expect(reviewUpdate.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const reviewDelete = await gql(
      app,
      `mutation($id: ID!) { reviewDelete(id: $id) { success } }`,
      { id: reviewBId },
    );
    expect(reviewDelete.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    expect(
      (app.db.query("SELECT name FROM cycles WHERE id = ?1").get(cycleBId) as { name: string })
        .name,
    ).toBe("B cycle");
    expect(app.db.query("SELECT id FROM reviews WHERE id = ?1").get(reviewBId)).not.toBeNull();
  });
});
