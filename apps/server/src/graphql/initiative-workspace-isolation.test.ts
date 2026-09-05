// PRB-590: las Initiatives sin relaciones mantienen el límite del Workspace.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

const app = createTestApp();
let workspaceBKey: string;
let initiativeAId: string;
let foreignProjectAId: string;
let foreignTeamAId: string;
let memberKey: string;
let limitedMemberKey: string;
let initiativeBId: string;

beforeAll(async () => {
  const initiative = await gql(
    app,
    `mutation { initiativeCreate(input: { name: "Empty initiative A", teamIds: [], projectIds: [] }) { initiative { id name } } }`,
  );
  expect(initiative.errors).toBeUndefined();
  initiativeAId = initiative.data!.initiativeCreate.initiative.id as string;

  const project = await gql(
    app,
    `mutation { projectCreate(input: { name: "Project A" }) { project { id } } }`,
  );
  expect(project.errors).toBeUndefined();
  foreignProjectAId = project.data!.projectCreate.project.id as string;

  const teamA = await gql(app, `{ team(key: "PB") { id } }`);
  expect(teamA.errors).toBeUndefined();
  foreignTeamAId = teamA.data!.team.id as string;

  const workspace = await gql(
    app,
    `mutation { workspaceCreate(input: { name: "Initiative B", urlKey: "initiative-b" }) { workspace { urlKey } } }`,
  );
  expect(workspace.errors).toBeUndefined();
  workspaceBKey = workspace.data!.workspaceCreate.workspace.urlKey;

  const team = await gql(
    app,
    `mutation { teamCreate(input: { name: "Initiative B team", key: "IB" }) { team { id } } }`,
    {},
    app.apiKey,
    workspaceBKey,
  );
  expect(team.errors).toBeUndefined();
  const teamBId = team.data!.teamCreate.team.id as string;

  const actor = await gql(
    app,
    `mutation { actorCreate(input: { name: "initiative-member", type: AGENT }) { actor { id } } }`,
    {},
    app.apiKey,
    workspaceBKey,
  );
  expect(actor.errors).toBeUndefined();
  const actorId = actor.data!.actorCreate.actor.id as string;

  const unrestricted = await gql(
    app,
    `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "initiative-member-key" }) { key } }`,
    { actorId },
    app.apiKey,
    workspaceBKey,
  );
  expect(unrestricted.errors).toBeUndefined();
  memberKey = unrestricted.data!.apiKeyCreate.key as string;

  const limited = await gql(
    app,
    `mutation($actorId: ID!, $teamId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "initiative-limited-key", scopes: [WRITE], teamIds: [$teamId] }) { key } }`,
    { actorId, teamId: teamBId },
    app.apiKey,
    workspaceBKey,
  );
  expect(limited.errors).toBeUndefined();
  limitedMemberKey = limited.data!.apiKeyCreate.key as string;

  const membership = await gql(
    app,
    `mutation($actorId: ID!, $teamId: ID!) { teamMembershipCreate(input: { actorId: $actorId, teamId: $teamId, role: MEMBER }) { success } }`,
    { actorId, teamId: teamBId },
    app.apiKey,
    workspaceBKey,
  );
  expect(membership.errors).toBeUndefined();

  const initiativeB = await gql(
    app,
    `mutation { initiativeCreate(input: { name: "Initiative B", teamIds: [], projectIds: [] }) { initiative { id } } }`,
    {},
    app.apiKey,
    workspaceBKey,
  );
  expect(initiativeB.errors).toBeUndefined();
  initiativeBId = initiativeB.data!.initiativeCreate.initiative.id as string;
});

afterAll(() => app.stop());

describe("Initiative Workspace isolation", () => {
  it("returns NOT_FOUND for empty foreign Initiatives with unrestricted and limited keys", async () => {
    const updates = await Promise.all(
      [memberKey, limitedMemberKey].map((key) =>
        gql(
          app,
          `mutation($id: ID!) { initiativeUpdate(id: $id, input: { name: "Hijacked", teamIds: [], projectIds: [] }) { success } }`,
          { id: initiativeAId },
          key,
          workspaceBKey,
        ),
      ),
    );
    for (const update of updates) {
      expect(update.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    }

    const stored = app.db
      .query("SELECT name FROM initiatives WHERE id = ?1")
      .get(initiativeAId) as {
      name: string;
    };
    expect(stored.name).toBe("Empty initiative A");
  });

  it("rejects foreign Projects and Teams without persisting Initiative state", async () => {
    const createCases = [
      {
        name: "foreign project create",
        input: "projectIds: [$reference], teamIds: []",
        reference: foreignProjectAId,
      },
      {
        name: "foreign team create",
        input: "projectIds: [], teamIds: [$reference]",
        reference: foreignTeamAId,
      },
    ];

    for (const testCase of createCases) {
      const result = await gql(
        app,
        `mutation($reference: ID!) { initiativeCreate(input: { name: "${testCase.name}", ${testCase.input} }) { success } }`,
        { reference: testCase.reference },
        app.apiKey,
        workspaceBKey,
      );
      expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
      const stored = app.db
        .query("SELECT count(*) AS count FROM initiatives WHERE name = ?1")
        .get(testCase.name) as { count: number };
      expect(stored.count).toBe(0);
    }

    const updateCases = [
      { input: "projectIds: [$reference], teamIds: []", reference: foreignProjectAId },
      { input: "projectIds: [], teamIds: [$reference]", reference: foreignTeamAId },
    ];
    for (const testCase of updateCases) {
      const result = await gql(
        app,
        `mutation($id: ID!, $reference: ID!) { initiativeUpdate(id: $id, input: { ${testCase.input} }) { success } }`,
        { id: initiativeBId, reference: testCase.reference },
        app.apiKey,
        workspaceBKey,
      );
      expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    }

    const relationCount = app.db
      .query("SELECT count(*) AS count FROM initiative_projects WHERE initiative_id = ?1")
      .get(initiativeBId) as { count: number };
    expect(relationCount.count).toBe(0);
    const teamRelationCount = app.db
      .query("SELECT count(*) AS count FROM initiative_teams WHERE initiative_id = ?1")
      .get(initiativeBId) as { count: number };
    expect(teamRelationCount.count).toBe(0);
  });
});
