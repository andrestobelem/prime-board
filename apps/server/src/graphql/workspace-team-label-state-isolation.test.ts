// PRB-476: Team, labels y workflow states deben respetar el Workspace efectivo.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let workspaceBKey: string;
let teamBId: string;
let labelBId: string;
let stateBId: string;

describe("Team, label y workflow state Workspace isolation", () => {
  beforeAll(async () => {
    app = createTestApp();

    const labelA = await gql(
      app,
      `mutation { labelCreate(input: { name: "Shared label" }) { label { id } } }`,
    );
    expect(labelA.errors).toBeUndefined();

    const workspace = await gql(
      app,
      `mutation { workspaceCreate(input: { name: "Labels B", urlKey: "labels-b" }) { workspace { id urlKey } } }`,
    );
    expect(workspace.errors).toBeUndefined();
    workspaceBKey = workspace.data!.workspaceCreate.workspace.urlKey;

    const teams = await gql(app, "{ teams { id key } }", {}, app.apiKey, workspaceBKey);
    expect(teams.errors).toBeUndefined();
    teamBId = teams.data!.teams[0].id;

    const label = await gql(
      app,
      `mutation { labelCreate(input: { name: "Shared label" }) { label { id } } }`,
      {},
      app.apiKey,
      workspaceBKey,
    );
    expect(label.errors).toBeUndefined();
    labelBId = label.data!.labelCreate.label.id;

    const state = await gql(
      app,
      `mutation($teamId: ID!) { workflowStateCreate(input: { teamId: $teamId, name: "B only", type: STARTED }) { workflowState { id } } }`,
      { teamId: teamBId },
      app.apiKey,
      workspaceBKey,
    );
    expect(state.errors).toBeUndefined();
    stateBId = state.data!.workflowStateCreate.workflowState.id;
  });

  afterAll(() => app.stop());

  it("oculta Teams, labels y estados de otro Workspace en roots y nested fields", async () => {
    const fromA = await gql(
      app,
      `{
        teams { id states { id } labels { id } }
        labels { id name }
        team(id: "${teamBId}") { id }
      }`,
    );
    expect(fromA.errors).toBeUndefined();
    expect(fromA.data!.team).toBeNull();
    expect(fromA.data!.teams.map((team: { id: string }) => team.id)).not.toContain(teamBId);
    expect(fromA.data!.labels.map((label: { id: string }) => label.id)).not.toContain(labelBId);

    const fromB = await gql(
      app,
      `query($teamId: ID!) {
        team(id: $teamId) { id states { id } labels { id name } }
        labels { id name }
      }`,
      { teamId: teamBId },
      app.apiKey,
      workspaceBKey,
    );
    expect(fromB.errors).toBeUndefined();
    expect(fromB.data!.team.id).toBe(teamBId);
    expect(fromB.data!.team.states.map((state: { id: string }) => state.id)).toContain(stateBId);
    expect(fromB.data!.team.labels).toContainEqual({ id: labelBId, name: "Shared label" });
    expect(fromB.data!.labels).toContainEqual({ id: labelBId, name: "Shared label" });
  });

  it("rechaza mutaciones cross-Workspace sin tocar las filas", async () => {
    const before = app.db.query("SELECT name FROM labels WHERE id = ?1").get(labelBId) as {
      name: string;
    };
    const results = await Promise.all([
      gql(
        app,
        `mutation($id: ID!) { labelUpdate(id: $id, input: { name: "hijacked" }) { success } }`,
        { id: labelBId },
      ),
      gql(app, `mutation($id: ID!) { labelDelete(id: $id) { success } }`, { id: labelBId }),
      gql(
        app,
        `mutation($id: ID!) { workflowStateUpdate(id: $id, input: { name: "hijacked" }) { success } }`,
        { id: stateBId },
      ),
      gql(app, `mutation($id: ID!) { workflowStateDelete(id: $id) { success } }`, { id: stateBId }),
      gql(
        app,
        `mutation($id: ID!) { teamUpdate(id: $id, input: { name: "hijacked" }) { success } }`,
        { id: teamBId },
      ),
      gql(
        app,
        `mutation($teamId: ID!) { workflowStateCreate(input: { teamId: $teamId, name: "invalid", type: STARTED }) { success } }`,
        { teamId: teamBId },
      ),
    ]);

    for (const result of results) {
      expect(result.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    }
    expect(
      (app.db.query("SELECT name FROM labels WHERE id = ?1").get(labelBId) as { name: string })
        .name,
    ).toBe(before.name);
    expect(
      (app.db.query("SELECT name FROM teams WHERE id = ?1").get(teamBId) as { name: string }).name,
    ).not.toBe("hijacked");
    expect(
      (
        app.db.query("SELECT name FROM workflow_states WHERE id = ?1").get(stateBId) as {
          name: string;
        }
      ).name,
    ).toBe("B only");
  });
});
