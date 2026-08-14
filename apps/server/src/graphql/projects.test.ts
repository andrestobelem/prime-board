// Tests de AT-137: proyectos con lead, estados y asociación de issues.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let projectId: string;

beforeAll(async () => {
  app = createTestApp();
  const viewer = await gql(app, `{ viewer { id } }`);
  const project = await gql(app, `
    mutation($leadId: ID!) {
      projectCreate(input: {
        name: "MVP backend", description: "Parte 2", state: STARTED,
        leadId: $leadId, targetDate: "2026-09-01"
      }) {
        project { id name state lead { name } targetDate }
      }
    }
  `, { leadId: viewer.data!.viewer.id });
  projectId = project.data!.projectCreate.project.id;
});
afterAll(() => app.stop());

describe("projects", () => {
  it("crea proyectos con lead y estado", async () => {
    const result = await gql(app, `query($id: ID!) { project(id: $id) { name state lead { name } } }`, { id: projectId });
    expect(result.data!.project).toEqual({ name: "MVP backend", state: "STARTED", lead: { name: "admin" } });
  });

  it("asocia issues vía issueCreate e issueUpdate y los lista", async () => {
    await gql(app, `
      mutation($projectId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "In project", projectId: $projectId }) { success }
      }
    `, { projectId });
    await gql(app, `mutation { issueCreate(input: { teamKey: "PB", title: "Outside" }) { success } }`);
    await gql(app, `
      mutation($projectId: ID!) { issueUpdate(id: "PB-2", input: { projectId: $projectId }) { success } }
    `, { projectId });

    const result = await gql(app, `
      query($id: ID!) { project(id: $id) { issues { nodes { identifier project { name } } } } }
    `, { id: projectId });
    const nodes = result.data!.project.issues.nodes;
    expect(nodes.map((n: any) => n.identifier).sort()).toEqual(["PB-1", "PB-2"]);
    expect(nodes[0].project.name).toBe("MVP backend");
  });

  it("actualiza estado y lo refleja en el listado filtrado", async () => {
    await gql(app, `
      mutation($id: ID!) { projectUpdate(id: $id, input: { state: COMPLETED }) { success } }
    `, { id: projectId });
    const completed = await gql(app, `{ projects(state: COMPLETED) { name } }`);
    expect(completed.data!.projects).toEqual([{ name: "MVP backend" }]);
    const started = await gql(app, `{ projects(state: STARTED) { name } }`);
    expect(started.data!.projects).toEqual([]);
  });

  it("valida estado y lead", async () => {
    const badLead = await gql(app, `
      mutation { projectCreate(input: { name: "X", leadId: "nope" }) { success } }
    `);
    expect(badLead.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});
