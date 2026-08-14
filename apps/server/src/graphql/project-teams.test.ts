// Tests de AT-152: proyectos por team, validación issue↔proyecto y compat.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let pbId: string;
let otherId: string;

beforeAll(async () => {
  app = createTestApp();
  const pb = await gql(app, `{ team(key: "PB") { id } }`);
  pbId = pb.data!.team.id;
  const other = await gql(app, `mutation { teamCreate(input: { name: "Other", key: "OT" }) { team { id } } }`);
  otherId = other.data!.teamCreate.team.id;
});
afterAll(() => app.stop());

describe("proyectos por team", () => {
  it("crea un proyecto con teams explícitos y lo expone en Team.projects", async () => {
    const created = await gql(app, `
      mutation($teamIds: [ID!]) {
        projectCreate(input: { name: "PB only", teamIds: $teamIds }) {
          project { id teams { key } }
        }
      }
    `, { teamIds: [pbId] });
    expect(created.data!.projectCreate.project.teams.map((t: any) => t.key)).toEqual(["PB"]);

    const team = await gql(app, `{ team(key: "PB") { projects { name } } }`);
    expect(team.data!.team.projects.map((p: any) => p.name)).toEqual(["PB only"]);
    const otherTeam = await gql(app, `{ team(key: "OT") { projects { name } } }`);
    expect(otherTeam.data!.team.projects).toEqual([]);
  });

  it("sin teamIds asocia a todos los teams (compat) y filtra por team", async () => {
    await gql(app, `mutation { projectCreate(input: { name: "Everywhere" }) { success } }`);
    const filtered = await gql(app, `
      query($team: ID) { projects(team: $team) { name } }
    `, { team: otherId });
    expect(filtered.data!.projects.map((p: any) => p.name)).toEqual(["Everywhere"]);
  });

  it("rechaza asociar un issue a un proyecto que no incluye su team", async () => {
    const projects = await gql(app, `{ projects { id name } }`);
    const pbOnly = projects.data!.projects.find((p: any) => p.name === "PB only");
    const bad = await gql(app, `
      mutation($projectId: ID!) {
        issueCreate(input: { teamKey: "OT", title: "Nope", projectId: $projectId }) { success }
      }
    `, { projectId: pbOnly.id });
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    // en el team correcto funciona
    const ok = await gql(app, `
      mutation($projectId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Yes", projectId: $projectId }) {
          issue { project { name } }
        }
      }
    `, { projectId: pbOnly.id });
    expect(ok.data!.issueCreate.issue.project.name).toBe("PB only");
  });

  it("projectUpdate reemplaza los teams y valida no-vacío", async () => {
    const projects = await gql(app, `{ projects { id name } }`);
    const pbOnly = projects.data!.projects.find((p: any) => p.name === "PB only");
    const updated = await gql(app, `
      mutation($id: ID!, $teamIds: [ID!]) {
        projectUpdate(id: $id, input: { teamIds: $teamIds }) { project { teams { key } } }
      }
    `, { id: pbOnly.id, teamIds: [pbId, otherId] });
    expect(updated.data!.projectUpdate.project.teams.length).toBe(2);

    const empty = await gql(app, `
      mutation($id: ID!) { projectUpdate(id: $id, input: { teamIds: [] }) { success } }
    `, { id: pbOnly.id });
    expect(empty.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});
