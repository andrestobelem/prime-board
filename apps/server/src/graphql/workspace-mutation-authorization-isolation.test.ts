// PRB-577: la resolución del Workspace precede a la autorización de mutaciones.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

const app = createTestApp();
let workspaceBKey: string;
let teamAId: string;
let teamBId: string;
let memberKey: string;

type MutationCase = readonly [query: string, variables: Record<string, unknown>];

const crossWorkspaceMutations = (teamId: string): MutationCase[] => [
  [
    `mutation($id: ID!) { teamUpdate(id: $id, input: { name: "cross-workspace" }) { success } }`,
    { id: teamId },
  ],
  [
    `mutation($teamId: ID!) { labelCreate(input: { teamId: $teamId, name: "cross-workspace" }) { success } }`,
    { teamId },
  ],
  [
    `mutation($teamId: ID!) { workflowStateCreate(input: { teamId: $teamId, name: "cross-workspace", type: STARTED }) { success } }`,
    { teamId },
  ],
  [
    `mutation($teamId: ID!) { cycleCreate(input: { teamId: $teamId, name: "cross-workspace", startsAt: "2027-01-01", endsAt: "2027-01-14" }) { success } }`,
    { teamId },
  ],
];

describe("Workspace context before team mutation authorization", () => {
  beforeAll(async () => {
    const teamA = await gql(app, `{ team(key: "PB") { id } }`);
    expect(teamA.errors).toBeUndefined();
    teamAId = teamA.data!.team.id as string;

    const workspace = await gql(
      app,
      `mutation { workspaceCreate(input: { name: "Mutation B", urlKey: "mutation-b" }) { workspace { urlKey } } }`,
    );
    expect(workspace.errors).toBeUndefined();
    workspaceBKey = workspace.data!.workspaceCreate.workspace.urlKey;

    const teamB = await gql(
      app,
      `mutation { teamCreate(input: { name: "Mutation target B", key: "MB" }) { team { id } } }`,
      {},
      app.apiKey,
      workspaceBKey,
    );
    expect(teamB.errors).toBeUndefined();
    teamBId = teamB.data!.teamCreate.team.id as string;

    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "workspace-b-member", type: AGENT }) { actor { id } } }`,
      {},
      app.apiKey,
      workspaceBKey,
    );
    expect(actor.errors).toBeUndefined();
    const actorId = actor.data!.actorCreate.actor.id as string;

    const key = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "workspace-b-member-key" }) { key } }`,
      { actorId },
      app.apiKey,
      workspaceBKey,
    );
    expect(key.errors).toBeUndefined();
    memberKey = key.data!.apiKeyCreate.key as string;

    const membership = await gql(
      app,
      `mutation($teamId: ID!, $actorId: ID!) { teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) { success } }`,
      { teamId: teamBId, actorId },
      app.apiKey,
      workspaceBKey,
    );
    expect(membership.errors).toBeUndefined();
  });

  afterAll(() => app.stop());

  it("devuelve NOT_FOUND para un miembro ante IDs del Workspace ajeno", async () => {
    for (const [query, variables] of crossWorkspaceMutations(teamAId)) {
      const result = await gql(app, query, variables, memberKey, workspaceBKey);
      expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    }
  });

  it("devuelve NOT_FOUND para un admin ante IDs del Workspace ajeno", async () => {
    for (const [query, variables] of crossWorkspaceMutations(teamAId)) {
      const result = await gql(app, query, variables, app.apiKey, workspaceBKey);
      expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    }
  });

  it("mantiene la autorización para recursos del Workspace activo", async () => {
    const adminMutations: MutationCase[] = [
      [
        `mutation($id: ID!) { teamUpdate(id: $id, input: { description: "admin update" }) { success } }`,
        { id: teamBId },
      ],
      [
        `mutation($teamId: ID!) { labelCreate(input: { teamId: $teamId, name: "admin label" }) { success } }`,
        { teamId: teamBId },
      ],
      [
        `mutation($teamId: ID!) { workflowStateCreate(input: { teamId: $teamId, name: "admin state", type: STARTED }) { success } }`,
        { teamId: teamBId },
      ],
      [
        `mutation($teamId: ID!) { cycleCreate(input: { teamId: $teamId, name: "admin cycle", startsAt: "2027-02-01", endsAt: "2027-02-14" }) { success } }`,
        { teamId: teamBId },
      ],
    ];
    for (const [query, variables] of adminMutations) {
      const result = await gql(app, query, variables, app.apiKey, workspaceBKey);
      expect(result.errors).toBeUndefined();
    }

    const memberMutations: MutationCase[] = [
      [
        `mutation($id: ID!) { teamUpdate(id: $id, input: { description: "member update" }) { success } }`,
        { id: teamBId },
      ],
      [
        `mutation($teamId: ID!) { labelCreate(input: { teamId: $teamId, name: "member label" }) { success } }`,
        { teamId: teamBId },
      ],
      [
        `mutation($teamId: ID!) { workflowStateCreate(input: { teamId: $teamId, name: "member state", type: STARTED }) { success } }`,
        { teamId: teamBId },
      ],
      [
        `mutation($teamId: ID!) { cycleCreate(input: { teamId: $teamId, name: "member cycle", startsAt: "2027-03-01", endsAt: "2027-03-14" }) { success } }`,
        { teamId: teamBId },
      ],
    ];
    for (const [query, variables] of memberMutations) {
      const result = await gql(app, query, variables, memberKey, workspaceBKey);
      expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    }
  });
});
