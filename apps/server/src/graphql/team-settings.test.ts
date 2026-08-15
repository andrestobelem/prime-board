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
