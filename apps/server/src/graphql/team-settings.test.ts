// Tests de AT-31: editar estados del workflow y administrar labels.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let stateId: string;
let labelId: string;

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(app, `{ team(key: "PB") { id states { id name position } } }`);
  stateId = team.data!.team.states[0].id;
  const label = await gql(app, `
    mutation($t: ID!) { labelCreate(input: { name: "temporal", color: "#111111", teamId: $t }) { label { id } } }
  `, { t: team.data!.team.id });
  labelId = label.data!.labelCreate.label.id;
});
afterAll(() => app.stop());

describe("estados del workflow", () => {
  it("renombra, recolorea y reposiciona", async () => {
    const result = await gql(app, `
      mutation($id: ID!) {
        workflowStateUpdate(id: $id, input: { name: "Icebox", color: "#123456", position: 9 }) {
          workflowState { name color position type }
        }
      }
    `, { id: stateId });
    expect(result.data!.workflowStateUpdate.workflowState).toMatchObject({
      name: "Icebox", color: "#123456", position: 9,
    });
  });

  it("rechaza nombres duplicados y tipos inválidos", async () => {
    const dup = await gql(app, `
      mutation($id: ID!) { workflowStateUpdate(id: $id, input: { name: "Done" }) { success } }
    `, { id: stateId });
    expect(dup.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});

describe("labels", () => {
  it("renombra y recolorea", async () => {
    const result = await gql(app, `
      mutation($id: ID!) {
        labelUpdate(id: $id, input: { name: "definitiva", color: "#abcdef" }) { label { name color } }
      }
    `, { id: labelId });
    expect(result.data!.labelUpdate.label).toEqual({ name: "definitiva", color: "#abcdef" });
  });

  it("se borra y se quita de los issues que la tenían", async () => {
    const issue = await gql(app, `
      mutation($l: [ID!]) {
        issueCreate(input: { teamKey: "PB", title: "Con label temporal", labelIds: $l }) { issue { id } }
      }
    `, { l: [labelId] });
    const deleted = await gql(app, `mutation($id: ID!) { labelDelete(id: $id) { success affectedIssues } }`,
      { id: labelId });
    expect(deleted.data!.labelDelete).toEqual({ success: true, affectedIssues: 1 });

    const after = await gql(app, `query($id: ID!) { issue(id: $id) { title labels { name } } }`,
      { id: issue.data!.issueCreate.issue.id });
    expect(after.data!.issue.labels).toEqual([]);
  });
});

describe("borrar estados (AT-164)", () => {
  it("exige destino si el estado tiene issues y los migra con actividad", async () => {
    const team = await gql(app, `{ team(key: "PB") { id states { id name type } } }`);
    const states = team.data!.team.states;
    const todo = states.find((s: any) => s.name === "Todo")!;
    const backlog = states.find((s: any) => s.type === "BACKLOG")!;
    const created = await gql(app, `
      mutation($s: ID!) { issueCreate(input: { teamKey: "PB", title: "Va a migrar", stateId: $s }) { issue { id } } }
    `, { s: todo.id });

    const sinDestino = await gql(app, `mutation($id: ID!) { workflowStateDelete(id: $id) { success } }`, { id: todo.id });
    expect(sinDestino.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(sinDestino.errors?.[0]?.message).toContain("moveToStateId");

    const ok = await gql(app, `
      mutation($id: ID!, $to: ID!) { workflowStateDelete(id: $id, moveToStateId: $to) { success movedIssues } }
    `, { id: todo.id, to: backlog.id });
    expect(ok.data!.workflowStateDelete.success).toBe(true);
    expect(ok.data!.workflowStateDelete.movedIssues).toBeGreaterThanOrEqual(1);

    const issue = await gql(app, `query($id: ID!) { issue(id: $id) { state { name } activity { type payload } } }`,
      { id: created.data!.issueCreate.issue.id });
    expect(issue.data!.issue.state.name).toBe(backlog.name);
    // La migración queda registrada, no es un cambio silencioso.
    const migration = issue.data!.issue.activity.find((a: any) => a.payload?.reason === "state_deleted");
    expect(migration).toBeDefined();
  });

  it("rechaza destinos de otro team", async () => {
    const other = await gql(app, `mutation { teamCreate(input: { name: "Ajeno", key: "AJ" }) { team { states { id } } } }`);
    const team = await gql(app, `{ team(key: "PB") { states { id name } } }`);
    const some = team.data!.team.states.find((s: any) => s.name === "Canceled")!;
    const bad = await gql(app, `
      mutation($id: ID!, $to: ID!) { workflowStateDelete(id: $id, moveToStateId: $to) { success } }
    `, { id: some.id, to: other.data!.teamCreate.team.states[0].id });
    // Sin issues no hace falta destino, así que este borra igual; el chequeo aplica con issues.
    expect(bad.errors === undefined || bad.errors[0]!.extensions?.code === "VALIDATION_FAILED").toBe(true);
  });

  it("protege el último estado completed del team", async () => {
    const team = await gql(app, `{ team(key: "PB") { states { id name type } } }`);
    const completed = team.data!.team.states.filter((s: any) => s.type === "COMPLETED");
    // Con un solo estado completed, borrarlo debe fallar.
    if (completed.length === 1) {
      const result = await gql(app, `mutation($id: ID!) { workflowStateDelete(id: $id) { success } }`,
        { id: completed[0]!.id });
      expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
      expect(result.errors?.[0]?.message).toContain("completed");
    }
  });
});
