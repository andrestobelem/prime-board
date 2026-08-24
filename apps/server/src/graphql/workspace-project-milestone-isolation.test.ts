// PRB-476: Projects, Milestones y Project Updates deben quedar aislados por Workspace.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let workspaceBId: string;
let workspaceBKey: string;
let projectBId: string;
let milestoneBId: string;
let projectUpdateBId: string;

describe("Project, Milestone y Project Update Workspace isolation", () => {
  beforeAll(async () => {
    app = createTestApp();
    const workspace = await gql(
      app,
      `mutation { workspaceCreate(input: { name: "Projects B", urlKey: "projects-b" }) { workspace { id urlKey } } }`,
    );
    expect(workspace.errors).toBeUndefined();
    workspaceBId = workspace.data!.workspaceCreate.workspace.id;
    workspaceBKey = workspace.data!.workspaceCreate.workspace.urlKey;

    const teams = await gql(app, "{ teams { id key } }", {}, app.apiKey, workspaceBKey);
    expect(teams.errors).toBeUndefined();
    const teamId = teams.data!.teams[0].id;

    const project = await gql(
      app,
      `mutation($teamId: ID!) {
        projectCreate(input: { name: "B project", teamIds: [$teamId] }) { project { id } }
      }`,
      { teamId },
      app.apiKey,
      workspaceBKey,
    );
    expect(project.errors).toBeUndefined();
    projectBId = project.data!.projectCreate.project.id;

    const milestone = await gql(
      app,
      `mutation($projectId: ID!) {
        milestoneCreate(input: { projectId: $projectId, name: "B milestone" }) { milestone { id } }
      }`,
      { projectId: projectBId },
      app.apiKey,
      workspaceBKey,
    );
    expect(milestone.errors).toBeUndefined();
    milestoneBId = milestone.data!.milestoneCreate.milestone.id;

    const projectUpdate = await gql(
      app,
      `mutation($projectId: ID!) {
        projectUpdateCreate(input: { projectId: $projectId, health: ON_TRACK, body: "B update" }) { projectUpdate { id } }
      }`,
      { projectId: projectBId },
      app.apiKey,
      workspaceBKey,
    );
    expect(projectUpdate.errors).toBeUndefined();
    projectUpdateBId = projectUpdate.data!.projectUpdateCreate.projectUpdate.id;
  });

  afterAll(() => app.stop());

  it("oculta IDs cross-workspace y conserva el workspace_id persistido", async () => {
    const fromA = await gql(
      app,
      `query($projectId: ID!) { project(id: $projectId) { id } projects { id } }`,
      { projectId: projectBId },
    );
    expect(fromA.errors).toBeUndefined();
    expect(fromA.data!.project).toBeNull();
    expect(fromA.data!.projects).not.toContainEqual({ id: projectBId });

    const fromB = await gql(
      app,
      `query($projectId: ID!) {
        project(id: $projectId) {
          id
          milestones { id }
          updates { id }
        }
      }`,
      { projectId: projectBId },
      app.apiKey,
      workspaceBKey,
    );
    expect(fromB.errors).toBeUndefined();
    expect(fromB.data!.project).toEqual({
      id: projectBId,
      milestones: [{ id: milestoneBId }],
      updates: [{ id: projectUpdateBId }],
    });

    for (const table of ["projects", "milestones", "project_updates"]) {
      expect(
        (
          app.db
            .query(`SELECT workspace_id FROM ${table} WHERE id = ?1`)
            .get(
              table === "projects"
                ? projectBId
                : table === "milestones"
                  ? milestoneBId
                  : projectUpdateBId,
            ) as { workspace_id: string }
        ).workspace_id,
      ).toBe(workspaceBId);
    }
  });

  it("no permite mutar IDs de otro Workspace", async () => {
    const projectArchive = await gql(
      app,
      `mutation($id: ID!) { projectArchive(id: $id) { success } }`,
      { id: projectBId },
    );
    expect(projectArchive.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const projectUpdate = await gql(
      app,
      `mutation($id: ID!) { projectUpdate(id: $id, input: { name: "hijacked" }) { success } }`,
      { id: projectBId },
    );
    expect(projectUpdate.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const milestoneUpdate = await gql(
      app,
      `mutation($id: ID!) { milestoneUpdate(id: $id, input: { name: "hijacked" }) { success } }`,
      { id: milestoneBId },
    );
    expect(milestoneUpdate.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const milestoneDelete = await gql(
      app,
      `mutation($id: ID!) { milestoneDelete(id: $id) { success } }`,
      { id: milestoneBId },
    );
    expect(milestoneDelete.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const projectUpdateDelete = await gql(
      app,
      `mutation($id: ID!) { projectUpdateDelete(id: $id) { success } }`,
      { id: projectUpdateBId },
    );
    expect(projectUpdateDelete.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    expect(
      (app.db.query("SELECT name FROM projects WHERE id = ?1").get(projectBId) as { name: string })
        .name,
    ).toBe("B project");
    expect(
      (
        app.db.query("SELECT name FROM milestones WHERE id = ?1").get(milestoneBId) as {
          name: string;
        }
      ).name,
    ).toBe("B milestone");
    expect(
      (
        app.db.query("SELECT body FROM project_updates WHERE id = ?1").get(projectUpdateBId) as {
          body: string;
        }
      ).body,
    ).toBe("B update");
  });
});
