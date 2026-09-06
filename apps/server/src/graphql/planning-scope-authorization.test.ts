import { afterEach, describe, expect, it } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { createProjectDependency, deleteProjectDependency } from "../domain/projects.ts";
import { createInitiativeUpdate, deleteInitiativeUpdate } from "../domain/initiatives.ts";
import type { ActorRow, AuthScopeContext } from "../auth/viewer.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp | null = null;

afterEach(() => {
  app?.stop();
  app = null;
});

function countRows(table: "project_dependencies" | "initiative_updates"): number {
  const row = app!.db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}

function workspaceId(): string {
  const row = app!.db.query<{ id: string }, []>("SELECT id FROM workspace LIMIT 1").get();
  if (!row) throw new Error("Workspace fixture is incomplete");
  return row.id;
}

function teamWorkspaceId(teamId: string): string | null {
  const row = app!.db
    .query<{ workspace_id: string | null }, [string]>(
      "SELECT workspace_id FROM teams WHERE id = ?1",
    )
    .get(teamId);
  if (!row) throw new Error("Team fixture is incomplete");
  return row.workspace_id;
}

function replaceKeyTeams(keyId: string, teamId: string): void {
  app!.db.transaction(() => {
    app!.db.query("DELETE FROM api_key_team_limits WHERE api_key_id = ?1").run(keyId);
    app!.db
      .query(
        "INSERT INTO api_key_team_limits (api_key_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
      )
      .run(keyId, teamId, teamWorkspaceId(teamId));
  })();
}

function replaceProjectTeams(projectId: string, teamId: string): void {
  app!.db.transaction(() => {
    app!.db.query("DELETE FROM project_teams WHERE project_id = ?1").run(projectId);
    app!.db
      .query("INSERT INTO project_teams (project_id, team_id, workspace_id) VALUES (?1, ?2, ?3)")
      .run(projectId, teamId, teamWorkspaceId(teamId));
  })();
}

function replaceInitiativeTeams(initiativeId: string, teamId: string): void {
  app!.db.transaction(() => {
    app!.db.query("DELETE FROM initiative_teams WHERE initiative_id = ?1").run(initiativeId);
    app!.db
      .query(
        "INSERT INTO initiative_teams (initiative_id, team_id, workspace_id) VALUES (?1, ?2, ?3)",
      )
      .run(initiativeId, teamId, teamWorkspaceId(teamId));
  })();
}

function replaceInitiativeProjects(initiativeId: string, projectId: string): void {
  app!.db.transaction(() => {
    app!.db.query("DELETE FROM initiative_projects WHERE initiative_id = ?1").run(initiativeId);
    app!.db
      .query(
        "INSERT INTO initiative_projects (initiative_id, project_id, workspace_id) VALUES (?1, ?2, ?3)",
      )
      .run(initiativeId, projectId, teamWorkspaceId(primaryTeamId()));
  })();
}

function primaryTeamId(): string {
  const row = app!.db.query<{ id: string }, []>("SELECT id FROM teams WHERE key = 'PB'").get();
  if (!row) throw new Error("Primary Team fixture is incomplete");
  return row.id;
}

async function createTeam(key: string): Promise<string> {
  const result = await gql(
    app!,
    "mutation($key: String!) { teamCreate(input: { key: $key, name: $key }) { team { id } } }",
    { key },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.teamCreate.team.id;
}

async function createActorWithKey(
  name: string,
  teamIds: string[],
): Promise<{ actorId: string; keyId: string; key: string }> {
  const actorResult = await gql(
    app!,
    "mutation($name: String!) { actorCreate(input: { name: $name, type: AGENT }) { actor { id } } }",
    { name },
  );
  expect(actorResult.errors).toBeUndefined();
  const actorId = actorResult.data!.actorCreate.actor.id;
  const keyResult = await gql(
    app!,
    `mutation($actorId: ID!, $teamIds: [ID!]) { apiKeyCreate(input: { actorId: $actorId, name: "scope-key", scopes: [WRITE], teamIds: $teamIds }) { key } }`,
    { actorId, teamIds },
  );
  expect(keyResult.errors).toBeUndefined();
  const keyRow = app!.db
    .query<{ id: string }, [string]>(
      "SELECT id FROM api_keys WHERE actor_id = ?1 ORDER BY created_at DESC LIMIT 1",
    )
    .get(actorId);
  if (!keyRow) throw new Error("API key fixture is incomplete");
  return { actorId, keyId: keyRow.id, key: keyResult.data!.apiKeyCreate.key };
}

async function addMembership(actorId: string, teamId: string): Promise<void> {
  const result = await gql(
    app!,
    "mutation($actorId: ID!, $teamId: ID!) { teamMembershipCreate(input: { actorId: $actorId, teamId: $teamId, role: MEMBER }) { success } }",
    { actorId, teamId },
  );
  expect(result.errors).toBeUndefined();
}

function limitedViewer(actorId: string): ActorRow {
  return fromPartial<ActorRow>({ id: actorId, workspace_role: "member" });
}

function limitedAuth(keyId: string, teamId: string): AuthScopeContext {
  return fromPartial<AuthScopeContext>({ keyId, teamIds: [teamId] });
}

describe("planning Team-limit authorization scope", () => {
  it("rejects dependency create/delete after project_teams changes without writes", async () => {
    app = createTestApp();
    const primary = primaryTeamId();
    const secondary = await createTeam("SDEP618");
    const limited = await createActorWithKey("scope dependency actor", [primary]);
    await addMembership(limited.actorId, primary);
    await addMembership(limited.actorId, secondary);

    const sourceResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "scope source", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: primary },
    );
    expect(sourceResult.errors).toBeUndefined();
    const sourceId = sourceResult.data!.projectCreate.project.id;
    const targetResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "scope target", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: primary },
    );
    expect(targetResult.errors).toBeUndefined();
    const targetId = targetResult.data!.projectCreate.project.id;
    const viewer = limitedViewer(limited.actorId);
    const auth = limitedAuth(limited.keyId, primary);

    expect(() =>
      createProjectDependency(
        app!.db,
        { projectId: sourceId, dependsOnProjectId: targetId },
        "foreign-workspace",
        viewer,
        auth,
      ),
    ).toThrow();
    expect(countRows("project_dependencies")).toBe(0);

    replaceKeyTeams(limited.keyId, secondary);
    expect(() =>
      createProjectDependency(
        app!.db,
        { projectId: sourceId, dependsOnProjectId: targetId },
        workspaceId(),
        viewer,
        auth,
      ),
    ).toThrow();
    expect(countRows("project_dependencies")).toBe(0);

    replaceKeyTeams(limited.keyId, primary);
    replaceProjectTeams(targetId, primary);
    const dependencyResult = await gql(
      app,
      "mutation($source: ID!, $target: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target }) { dependency { id } } }",
      { source: sourceId, target: targetId },
    );
    expect(dependencyResult.errors).toBeUndefined();
    const dependencyId = dependencyResult.data!.projectDependencyCreate.dependency.id;
    replaceProjectTeams(targetId, secondary);
    expect(() =>
      deleteProjectDependency(app!.db, dependencyId, workspaceId(), viewer, auth),
    ).toThrow();
    expect(countRows("project_dependencies")).toBe(1);
  });

  it("rejects status create/delete after initiative relation changes without writes", async () => {
    app = createTestApp();
    const primary = primaryTeamId();
    const secondary = await createTeam("SSTA618");
    const limited = await createActorWithKey("scope status actor", [primary]);
    await addMembership(limited.actorId, primary);
    await addMembership(limited.actorId, secondary);

    const primaryProjectResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "status primary", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: primary },
    );
    expect(primaryProjectResult.errors).toBeUndefined();
    const primaryProjectId = primaryProjectResult.data!.projectCreate.project.id;
    const secondaryProjectResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "status secondary", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: secondary },
    );
    expect(secondaryProjectResult.errors).toBeUndefined();
    const secondaryProjectId = secondaryProjectResult.data!.projectCreate.project.id;
    const initiativeResult = await gql(
      app,
      `mutation($teamId: ID!, $projectId: ID!) { initiativeCreate(input: { name: "scope initiative", teamIds: [$teamId], projectIds: [$projectId] }) { initiative { id } } }`,
      { teamId: primary, projectId: primaryProjectId },
      limited.key,
    );
    expect(initiativeResult.errors).toBeUndefined();
    const initiativeId = initiativeResult.data!.initiativeCreate.initiative.id;
    const viewer = limitedViewer(limited.actorId);
    const auth = limitedAuth(limited.keyId, primary);

    replaceKeyTeams(limited.keyId, secondary);
    expect(() =>
      createInitiativeUpdate(
        app!.db,
        initiativeId,
        limited.actorId,
        { body: "scope changed", health: "on_track" },
        workspaceId(),
        viewer,
        auth,
      ),
    ).toThrow();
    expect(countRows("initiative_updates")).toBe(0);

    replaceKeyTeams(limited.keyId, primary);
    replaceInitiativeTeams(initiativeId, secondary);
    expect(() =>
      createInitiativeUpdate(
        app!.db,
        initiativeId,
        limited.actorId,
        { body: "scope changed", health: "on_track" },
        workspaceId(),
        viewer,
        auth,
      ),
    ).toThrow();
    expect(countRows("initiative_updates")).toBe(0);
    replaceInitiativeTeams(initiativeId, primary);
    const update = createInitiativeUpdate(
      app!.db,
      initiativeId,
      limited.actorId,
      { body: "scope stable", health: "on_track" },
      workspaceId(),
      viewer,
      auth,
    );
    expect(update.initiative_id).toBe(initiativeId);
    replaceInitiativeProjects(initiativeId, secondaryProjectId);
    expect(() => deleteInitiativeUpdate(app!.db, update.id, workspaceId(), viewer, auth)).toThrow();
    expect(countRows("initiative_updates")).toBe(1);
    expect(primaryProjectId).not.toBe(secondaryProjectId);
  });
});
