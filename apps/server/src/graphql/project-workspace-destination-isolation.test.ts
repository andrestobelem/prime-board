// PRB-594: los destinos implícitos de Projects respetan el Workspace activo.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
let workspaceBKey: string;
let teamAId: string;
let teamBId: string;
let memberKey: string;

beforeAll(async () => {
  const teamA = await gql(app, `{ team(key: "PB") { id } }`);
  expect(teamA.errors).toBeUndefined();
  teamAId = teamA.data!.team.id as string;

  const restrictedTeam = await gql(
    app,
    `mutation($id: ID!) {
      teamUpdate(id: $id, input: { visibility: PRIVATE, accessPolicy: TEAM_MEMBERS }) { success }
    }`,
    { id: teamAId },
  );
  expect(restrictedTeam.errors).toBeUndefined();

  const workspace = await gql(
    app,
    `mutation { workspaceCreate(input: { name: "Project B", urlKey: "project-b" }) { workspace { urlKey } } }`,
  );
  expect(workspace.errors).toBeUndefined();
  workspaceBKey = workspace.data!.workspaceCreate.workspace.urlKey;

  const teamB = await gql(app, `{ team(key: "WS") { id } }`, {}, app.apiKey, workspaceBKey);
  expect(teamB.errors).toBeUndefined();
  teamBId = teamB.data!.team.id as string;

  const actor = await gql(
    app,
    `mutation { actorCreate(input: { name: "project-member", type: AGENT }) { actor { id } } }`,
    {},
    app.apiKey,
    workspaceBKey,
  );
  expect(actor.errors).toBeUndefined();
  const actorId = actor.data!.actorCreate.actor.id as string;

  const key = await gql(
    app,
    `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "project-member-key" }) { key } }`,
    { actorId },
    app.apiKey,
    workspaceBKey,
  );
  expect(key.errors).toBeUndefined();
  memberKey = key.data!.apiKeyCreate.key as string;

  const membership = await gql(
    app,
    `mutation($actorId: ID!, $teamId: ID!) {
      teamMembershipCreate(input: { actorId: $actorId, teamId: $teamId, role: MEMBER }) { success }
    }`,
    { actorId, teamId: teamBId },
    app.apiKey,
    workspaceBKey,
  );
  expect(membership.errors).toBeUndefined();
});

afterAll(() => app.stop());

describe("Project Workspace destination isolation", () => {
  it("uses only Workspace B teams when teamIds is omitted or null", async () => {
    const inputs = [
      `mutation { projectCreate(input: { name: "implicit omitted" }) { project { id } } }`,
      `mutation { projectCreate(input: { name: "implicit null", teamIds: null }) { project { id } } }`,
    ];

    for (const query of inputs) {
      const result = await gql(app, query, {}, memberKey, workspaceBKey);
      expect(result.errors).toBeUndefined();
      const projectId = result.data!.projectCreate.project.id as string;
      const teams = app.db
        .query("SELECT team_id FROM project_teams WHERE project_id = ?1")
        .all(projectId) as Array<{ team_id: string }>;
      expect(teams).toEqual([{ team_id: teamBId }]);
    }
  });

  it("rejects an explicit foreign Team without creating a Project", async () => {
    const result = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "explicit foreign", teamIds: [$teamId] }) { success } }`,
      { teamId: teamAId },
      memberKey,
      workspaceBKey,
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    const stored = app.db
      .query("SELECT count(*) AS count FROM projects WHERE name = ?1")
      .get("explicit foreign") as { count: number };
    expect(stored.count).toBe(0);
  });
});
