import { afterAll, describe, expect, it } from "bun:test";
import {
  createProject as createDomainProject,
  listProjectTeamIds,
  updateProject,
} from "../domain/projects.ts";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

function rowCount(table: "project_dependencies" | "initiative_updates"): number {
  const row = app.db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}

async function createActorKey(name: string, teamIds?: string[]): Promise<string> {
  const actor = await gql(
    app,
    `mutation($name: String!) { actorCreate(input: { name: $name, type: AGENT }) { actor { id } } }`,
    { name },
  );
  expect(actor.errors).toBeUndefined();
  const actorId = actor.data!.actorCreate.actor.id;
  const key = await gql(
    app,
    `mutation($actorId: ID!, $teamIds: [ID!]) {
      apiKeyCreate(input: { actorId: $actorId, name: "${name}-key", scopes: [WRITE], teamIds: $teamIds }) { key }
    }`,
    { actorId, teamIds },
  );
  expect(key.errors).toBeUndefined();
  return key.data!.apiKeyCreate.key;
}

async function teamId(key = app.apiKey): Promise<string> {
  const result = await gql(app, `{ team(key: "PB") { id } }`, {}, key);
  expect(result.errors).toBeUndefined();
  return result.data!.team.id;
}

async function createProject(name: string, teamIds: string[], key = app.apiKey): Promise<string> {
  const result = await gql(
    app,
    `mutation($name: String!, $teamIds: [ID!]) { projectCreate(input: { name: $name, teamIds: $teamIds }) { project { id } } }`,
    { name, teamIds },
    key,
  );
  expect(result.errors).toBeUndefined();
  return result.data!.projectCreate.project.id;
}

describe("planning mutation authorization", () => {
  it("requires write ACL and the union of dependency Team limits", async () => {
    const primaryTeamId = await teamId();
    const secondaryTeam = await gql(
      app,
      `mutation { teamCreate(input: { key: "SEC609", name: "PRB-609 secondary" }) { team { id } } }`,
    );
    expect(secondaryTeam.errors).toBeUndefined();
    const secondaryTeamId = secondaryTeam.data!.teamCreate.team.id;
    const sourceId = await createProject("PRB-609 source", [primaryTeamId]);
    const targetId = await createProject("PRB-609 target", [primaryTeamId]);
    const foreignTargetId = await createProject("PRB-609 foreign target", [secondaryTeamId]);

    const memberKey = await createActorKey("PRB-609 member");
    const memberId = (await gql(app, `{ viewer { id } }`, {}, memberKey)).data!.viewer.id;
    const membership = await gql(
      app,
      `mutation($actorId: ID!, $teamId: ID!) { teamMembershipCreate(input: { actorId: $actorId, teamId: $teamId, role: MEMBER }) { success } }`,
      { actorId: memberId, teamId: primaryTeamId },
    );
    expect(membership.errors).toBeUndefined();

    const created = await gql(
      app,
      `mutation($source: ID!, $target: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target, type: RELATED }) { dependency { id } } }`,
      { source: sourceId, target: targetId },
      memberKey,
    );
    expect(created.errors).toBeUndefined();
    const dependencyId = created.data!.projectDependencyCreate.dependency.id;

    const outsiderKey = await createActorKey("PRB-609 outsider");
    const denied = await gql(
      app,
      `mutation($source: ID!, $target: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target }) { success } }`,
      { source: sourceId, target: targetId },
      outsiderKey,
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(rowCount("project_dependencies")).toBe(1);

    const limitedKey = await createActorKey("PRB-609 limited", [primaryTeamId]);
    const targetAclDenied = await gql(
      app,
      `mutation($source: ID!, $target: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target }) { success } }`,
      { source: sourceId, target: foreignTargetId },
      memberKey,
    );
    expect(targetAclDenied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const limitedDenied = await gql(
      app,
      `mutation($source: ID!, $target: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target }) { success } }`,
      { source: sourceId, target: foreignTargetId },
      limitedKey,
    );
    expect(limitedDenied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(rowCount("project_dependencies")).toBe(1);

    const deleteDenied = await gql(
      app,
      `mutation($id: ID!) { projectDependencyDelete(id: $id) { success } }`,
      { id: dependencyId },
      outsiderKey,
    );
    expect(deleteDenied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const deleted = await gql(
      app,
      `mutation($id: ID!) { projectDependencyDelete(id: $id) { success } }`,
      { id: dependencyId },
      memberKey,
    );
    expect(deleted.errors).toBeUndefined();
  });

  it("applies Initiative ACL, Workspace scope and Team limits to status updates", async () => {
    const primaryTeamId = await teamId();
    const secondaryTeam = await gql(
      app,
      `mutation { teamCreate(input: { key: "ST609", name: "PRB-609 status" }) { team { id } } }`,
    );
    expect(secondaryTeam.errors).toBeUndefined();
    const secondaryTeamId = secondaryTeam.data!.teamCreate.team.id;
    const memberKey = await createActorKey("PRB-609 status member");
    const memberId = (await gql(app, `{ viewer { id } }`, {}, memberKey)).data!.viewer.id;
    const membership = await gql(
      app,
      `mutation($actorId: ID!, $teamId: ID!) { teamMembershipCreate(input: { actorId: $actorId, teamId: $teamId, role: MEMBER }) { success } }`,
      { actorId: memberId, teamId: primaryTeamId },
    );
    expect(membership.errors).toBeUndefined();
    const initiative = await gql(
      app,
      `mutation($teamId: ID!) { initiativeCreate(input: { name: "PRB-609 status initiative", teamIds: [$teamId], projectIds: [] }) { initiative { id } } }`,
      { teamId: primaryTeamId },
      memberKey,
    );
    expect(initiative.errors).toBeUndefined();
    const initiativeId = initiative.data!.initiativeCreate.initiative.id;

    const created = await gql(
      app,
      `mutation($id: ID!) { initiativeStatusUpdateCreate(input: { initiativeId: $id, health: ON_TRACK, body: "Ready" }) { initiativeUpdate { id } } }`,
      { id: initiativeId },
      memberKey,
    );
    expect(created.errors).toBeUndefined();
    const updateId = created.data!.initiativeStatusUpdateCreate.initiativeUpdate.id;

    const outsiderKey = await createActorKey("PRB-609 status outsider");
    const outsider = await gql(
      app,
      `mutation($id: ID!) { initiativeStatusUpdateCreate(input: { initiativeId: $id, health: AT_RISK, body: "Denied" }) { success } }`,
      { id: initiativeId },
      outsiderKey,
    );
    expect(outsider.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(rowCount("initiative_updates")).toBe(1);

    const limitedForeignKey = await createActorKey("PRB-609 status limited", [secondaryTeamId]);
    const limited = await gql(
      app,
      `mutation($id: ID!) { initiativeStatusUpdateCreate(input: { initiativeId: $id, health: AT_RISK, body: "Denied" }) { success } }`,
      { id: initiativeId },
      limitedForeignKey,
    );
    expect(limited.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const deleteLimited = await gql(
      app,
      `mutation($id: ID!) { initiativeStatusUpdateDelete(id: $id) { success } }`,
      { id: updateId },
      limitedForeignKey,
    );
    expect(deleteLimited.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(rowCount("initiative_updates")).toBe(1);

    const deleted = await gql(
      app,
      `mutation($id: ID!) { initiativeStatusUpdateDelete(id: $id) { success } }`,
      { id: updateId },
      memberKey,
    );
    expect(deleted.errors).toBeUndefined();
    expect(rowCount("initiative_updates")).toBe(0);
  });

  it("rejects archived Teams in SQLite project persistence", async () => {
    const workspace = app.db.query<{ id: string }, []>("SELECT id FROM workspace LIMIT 1").get();
    const team = app.db
      .query<{ id: string }, [string]>("SELECT id FROM teams WHERE key = ?1")
      .get("PB");
    if (!workspace || !team) throw new Error("Seed workspace and PB Team are required");

    const project = createDomainProject(
      app.db,
      { name: "PRB-609 archived Team project", teamIds: [team.id] },
      workspace.id,
    );
    app.db
      .query("UPDATE teams SET archived_at = ?1 WHERE id = ?2")
      .run("2026-09-07T00:00:00.000Z", team.id);

    expect(() =>
      createDomainProject(
        app.db,
        { name: "PRB-609 rejected archived Team project", teamIds: [team.id] },
        workspace.id,
      ),
    ).toThrow("Team is archived");
    expect(
      app.db
        .query<{ id: string }, []>(
          "SELECT id FROM projects WHERE name = 'PRB-609 rejected archived Team project'",
        )
        .get(),
    ).toBeNull();
    expect(() => updateProject(app.db, project.id, { teamIds: [team.id] }, workspace.id)).toThrow(
      "Team is archived",
    );
    expect(listProjectTeamIds(app.db, project.id, workspace.id)).toEqual([team.id]);
  });
});
