// Tests de AT-29: milestones como sub-estructura de proyecto.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let projectId: string;
let otherProjectId: string;
let m1: string;
let m2: string;

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(app, `{ team(key: "PB") { id } }`);
  const teamId = team.data!.team.id;
  const project = await gql(app, `
    mutation($t: [ID!]) { projectCreate(input: { name: "Roadmap", teamIds: $t }) { project { id } } }
  `, { t: [teamId] });
  projectId = project.data!.projectCreate.project.id;
  const other = await gql(app, `
    mutation($t: [ID!]) { projectCreate(input: { name: "Otro", teamIds: $t }) { project { id } } }
  `, { t: [teamId] });
  otherProjectId = other.data!.projectCreate.project.id;
});
afterAll(() => app.stop());

describe("milestones", () => {
  it("crea milestones ordenados dentro de un proyecto", async () => {
    for (const name of ["Fase 1", "Fase 2"]) {
      const r = await gql(app, `
        mutation($p: ID!, $n: String!) {
          milestoneCreate(input: { projectId: $p, name: $n }) { milestone { id name position } }
        }
      `, { p: projectId, n: name });
      expect(r.errors).toBeUndefined();
    }
    const list = await gql(app, `query($id: ID!) { project(id: $id) { milestones { id name position } } }`, { id: projectId });
    const ms = list.data!.project.milestones;
    expect(ms.map((m: any) => m.name)).toEqual(["Fase 1", "Fase 2"]);
    expect(ms[0].position).toBeLessThan(ms[1].position);
    m1 = ms[0].id; m2 = ms[1].id;
  });

  it("rechaza nombres duplicados en el mismo proyecto", async () => {
    const dup = await gql(app, `
      mutation($p: ID!) { milestoneCreate(input: { projectId: $p, name: "Fase 1" }) { success } }
    `, { p: projectId });
    expect(dup.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("asigna issues a un milestone y los filtra", async () => {
    await gql(app, `
      mutation($p: ID!, $m: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Con milestone", projectId: $p, milestoneId: $m }) { success }
      }
    `, { p: projectId, m: m1 });
    const listed = await gql(app, `
      query($m: ID!) { issues(filter: { milestone: { eq: $m } }) { nodes { identifier milestone { name } } } }
    `, { m: m1 });
    expect(listed.data!.issues.nodes.length).toBe(1);
    expect(listed.data!.issues.nodes[0].milestone.name).toBe("Fase 1");
  });

  it("exige que el milestone sea del proyecto del issue", async () => {
    const bad = await gql(app, `
      mutation($p: ID!, $m: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Mismatch", projectId: $p, milestoneId: $m }) { success }
      }
    `, { p: otherProjectId, m: m1 });
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const noProject = await gql(app, `
      mutation($m: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Sin proyecto", milestoneId: $m }) { success }
      }
    `, { m: m1 });
    expect(noProject.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("calcula progreso según issues completados", async () => {
    const before = await gql(app, `query($id: ID!) { project(id: $id) { milestones { name progress } } }`, { id: projectId });
    expect(before.data!.project.milestones[0].progress).toBe(0);

    const team = await gql(app, `{ team(key: "PB") { states { id type } } }`);
    const doneState = team.data!.team.states.find((s: any) => s.type === "COMPLETED").id;
    const issues = await gql(app, `query($m: ID!) { issues(filter: { milestone: { eq: $m } }) { nodes { id } } }`, { m: m1 });
    await gql(app, `
      mutation($id: ID!, $s: ID!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }
    `, { id: issues.data!.issues.nodes[0].id, s: doneState });

    const after = await gql(app, `query($id: ID!) { project(id: $id) { milestones { name progress } } }`, { id: projectId });
    expect(after.data!.project.milestones[0].progress).toBe(1);
  });

  it("mover el issue de milestone queda registrado en la actividad", async () => {
    const issues = await gql(app, `query($m: ID!) { issues(filter: { milestone: { eq: $m } }) { nodes { id } } }`, { m: m1 });
    const id = issues.data!.issues.nodes[0].id;
    await gql(app, `mutation($id: ID!, $m: ID!) { issueUpdate(id: $id, input: { milestoneId: $m }) { success } }`,
      { id, m: m2 });
    const activity = await gql(app, `query($id: ID!) { issue(id: $id) { activity { type } milestone { name } } }`, { id });
    expect(activity.data!.issue.milestone.name).toBe("Fase 2");
    expect(activity.data!.issue.activity.map((a: any) => a.type)).toContain("milestone_changed");
  });

  it("limpia el milestone al mover el issue a otro proyecto (bug encontrado en AT-29)", async () => {
    const created = await gql(app, `
      mutation($p: ID!, $m: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Se muda", projectId: $p, milestoneId: $m }) {
          issue { id milestone { name } }
        }
      }
    `, { p: projectId, m: m1 });
    const id = created.data!.issueCreate.issue.id;
    expect(created.data!.issueCreate.issue.milestone.name).toBe("Fase 1");

    const moved = await gql(app, `
      mutation($id: ID!, $p: ID!) {
        issueUpdate(id: $id, input: { projectId: $p }) { issue { project { name } milestone { name } } }
      }
    `, { id, p: otherProjectId });
    expect(moved.data!.issueUpdate.issue.project.name).toBe("Otro");
    expect(moved.data!.issueUpdate.issue.milestone).toBeNull();
  });
});
