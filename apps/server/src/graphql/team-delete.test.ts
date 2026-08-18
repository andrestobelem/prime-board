// PRB-373: borrado definitivo de Teams con confirmación y precondiciones.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("team delete", () => {
  it("requires an exact key confirmation and removes internal dependencies atomically", async () => {
    const created = await gql(
      app,
      `mutation { teamCreate(input: { name: "Disposable", key: "DEL" }) { team { id key states { id } } } }`,
    );
    expect(created.errors).toBeUndefined();
    const teamId = created.data!.teamCreate.team.id as string;
    const stateCount = app.db
      .query("SELECT count(*) AS count FROM workflow_states WHERE team_id = ?1")
      .get(teamId) as { count: number };
    const membershipCount = app.db
      .query("SELECT count(*) AS count FROM team_memberships WHERE team_id = ?1")
      .get(teamId) as { count: number };
    expect(stateCount.count).toBeGreaterThan(0);
    expect(membershipCount.count).toBeGreaterThan(0);

    const mismatch = await gql(
      app,
      `mutation($id: ID!, $confirmation: String!) {
        teamDelete(id: $id, confirmation: $confirmation) { success }
      }`,
      { id: teamId, confirmation: "DELETE" },
    );
    expect(mismatch.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(app.db.query("SELECT id FROM teams WHERE id = ?1").get(teamId)).toBeTruthy();

    const deleted = await gql(
      app,
      `mutation($id: ID!, $confirmation: String!) {
        teamDelete(id: $id, confirmation: $confirmation) { success }
      }`,
      { id: teamId, confirmation: "DEL" },
    );
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data!.teamDelete.success).toBe(true);
    expect(app.db.query("SELECT id FROM teams WHERE id = ?1").get(teamId)).toBeNull();
    expect(
      (
        app.db
          .query("SELECT count(*) AS count FROM workflow_states WHERE team_id = ?1")
          .get(teamId) as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (
        app.db
          .query("SELECT count(*) AS count FROM team_memberships WHERE team_id = ?1")
          .get(teamId) as {
          count: number;
        }
      ).count,
    ).toBe(0);
  });

  it("rejects dependent resources without deleting anything", async () => {
    const created = await gql(
      app,
      `mutation { teamCreate(input: { name: "Non-empty", key: "NODEL" }) { team { id } } }`,
    );
    const teamId = created.data!.teamCreate.team.id as string;
    const issue = await gql(
      app,
      `mutation($teamId: ID!) { issueCreate(input: { teamId: $teamId, title: "Keep me" }) { issue { id } } }`,
      { teamId },
    );
    expect(issue.errors).toBeUndefined();
    const issueId = issue.data!.issueCreate.issue.id as string;

    const deleted = await gql(
      app,
      `mutation($id: ID!, $confirmation: String!) {
        teamDelete(id: $id, confirmation: $confirmation) { success }
      }`,
      { id: teamId, confirmation: "NODEL" },
    );
    expect(deleted.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(deleted.errors?.[0]?.message).toContain("issues=1");
    expect(app.db.query("SELECT id FROM teams WHERE id = ?1").get(teamId)).toBeTruthy();
    expect(app.db.query("SELECT id FROM issues WHERE id = ?1").get(issueId)).toBeTruthy();
  });

  it("is restricted to Workspace Admins", async () => {
    const created = await gql(
      app,
      `mutation { teamCreate(input: { name: "Protected", key: "NOAUTH" }) { team { id } } }`,
    );
    const teamId = created.data!.teamCreate.team.id as string;
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "delete-member", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id as string;
    const key = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "delete member" }) { key } }`,
      { actorId },
    );
    const denied = await gql(
      app,
      `mutation($id: ID!) { teamDelete(id: $id, confirmation: "NOAUTH") { success } }`,
      { id: teamId },
      key.data!.apiKeyCreate.key as string,
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(app.db.query("SELECT id FROM teams WHERE id = ?1").get(teamId)).toBeTruthy();
  });
});
