// Tests de AT-30: archivar y desarchivar proyectos.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let projectId: string;

beforeAll(async () => {
  app = createTestApp();
  const p = await gql(app, `mutation { projectCreate(input: { name: "Viejo" }) { project { id } } }`);
  projectId = p.data!.projectCreate.project.id;
  await gql(app, `
    mutation($p: ID!) { issueCreate(input: { teamKey: "PB", title: "En proyecto viejo", projectId: $p }) { success } }
  `, { p: projectId });
});
afterAll(() => app.stop());

describe("archivado de proyectos", () => {
  it("desaparece del listado pero sigue accesible por id", async () => {
    await gql(app, `mutation($id: ID!) { projectArchive(id: $id) { project { archivedAt } } }`, { id: projectId });
    const listed = await gql(app, `{ projects { name } }`);
    expect(listed.data!.projects.map((p: any) => p.name)).not.toContain("Viejo");

    const direct = await gql(app, `query($id: ID!) { project(id: $id) { name archivedAt } }`, { id: projectId });
    expect(direct.data!.project.name).toBe("Viejo");
    expect(direct.data!.project.archivedAt).not.toBeNull();
  });

  it("se puede incluir explícitamente y desarchivar", async () => {
    const withArchived = await gql(app, `{ projects(includeArchived: true) { name } }`);
    expect(withArchived.data!.projects.map((p: any) => p.name)).toContain("Viejo");

    await gql(app, `mutation($id: ID!) { projectUnarchive(id: $id) { project { archivedAt } } }`, { id: projectId });
    const listed = await gql(app, `{ projects { name } }`);
    expect(listed.data!.projects.map((p: any) => p.name)).toContain("Viejo");
  });

  it("los issues del proyecto archivado siguen consultables", async () => {
    await gql(app, `mutation($id: ID!) { projectArchive(id: $id) { success } }`, { id: projectId });
    const issues = await gql(app, `
      query($p: ID!) { issues(filter: { project: { eq: $p } }) { nodes { title project { name } } } }
    `, { p: projectId });
    expect(issues.data!.issues.nodes[0].project.name).toBe("Viejo");
  });

  it("archivar un proyecto inexistente da NOT_FOUND", async () => {
    const bad = await gql(app, `mutation { projectArchive(id: "nope") { success } }`);
    expect(bad.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});
