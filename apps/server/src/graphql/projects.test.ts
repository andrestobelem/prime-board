// Tests de AT-137: proyectos con lead, estados y asociación de issues.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let projectId: string;

beforeAll(async () => {
  app = createTestApp();
  const viewer = await gql(app, `{ viewer { id } }`);
  const project = await gql(
    app,
    `
    mutation($leadId: ID!) {
      projectCreate(input: {
        name: "MVP backend", description: "Parte 2", state: STARTED,
        leadId: $leadId, targetDate: "2026-09-01"
      }) {
        project { id name state lead { name } targetDate }
      }
    }
  `,
    { leadId: viewer.data!.viewer.id },
  );
  projectId = project.data!.projectCreate.project.id;
});
afterAll(() => app.stop());

describe("projects", () => {
  it("crea proyectos con lead y estado", async () => {
    const result = await gql(
      app,
      `query($id: ID!) { project(id: $id) { name state lead { name } } }`,
      { id: projectId },
    );
    expect(result.data!.project).toEqual({
      name: "MVP backend",
      state: "STARTED",
      lead: { name: "admin" },
    });
  });

  it("asocia issues vía issueCreate e issueUpdate y los lista", async () => {
    await gql(
      app,
      `
      mutation($projectId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "In project", projectId: $projectId }) { success }
      }
    `,
      { projectId },
    );
    await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Outside" }) { success } }`,
    );
    await gql(
      app,
      `
      mutation($projectId: ID!) { issueUpdate(id: "PB-2", input: { projectId: $projectId }) { success } }
    `,
      { projectId },
    );

    const result = await gql(
      app,
      `
      query($id: ID!) { project(id: $id) { issues { nodes { identifier project { name } } } } }
    `,
      { id: projectId },
    );
    const nodes = result.data!.project.issues.nodes;
    expect(nodes.map((n: any) => n.identifier).sort()).toEqual(["PB-1", "PB-2"]);
    expect(nodes[0].project.name).toBe("MVP backend");
  });

  it("permite continuar la paginación de issues de project y milestone", async () => {
    const milestoneResult = await gql(
      app,
      `
      mutation($projectId: ID!) {
        milestoneCreate(input: { projectId: $projectId, name: "Paged milestone" }) {
          milestone { id }
        }
      }
    `,
      { projectId },
    );
    const milestoneId = milestoneResult.data!.milestoneCreate.milestone.id;

    for (let index = 0; index < 51; index += 1) {
      await gql(
        app,
        `
        mutation($projectId: ID!, $milestoneId: ID!, $title: String!) {
          issueCreate(input: {
            teamKey: "PB", title: $title, projectId: $projectId, milestoneId: $milestoneId
          }) { success }
        }
      `,
        { projectId, milestoneId, title: `Paged issue ${index}` },
      );
    }

    const projectFirst = await gql(
      app,
      `
      query($id: ID!) {
        project(id: $id) {
          issues(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } }
        }
      }
    `,
      { id: projectId },
    );
    expect(projectFirst.data!.project.issues.nodes).toHaveLength(50);
    expect(projectFirst.data!.project.issues.pageInfo.hasNextPage).toBe(true);

    const projectSecond = await gql(
      app,
      `
      query($id: ID!, $after: String!) {
        project(id: $id) {
          issues(first: 50, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } }
        }
      }
    `,
      { id: projectId, after: projectFirst.data!.project.issues.pageInfo.endCursor },
    );
    expect(projectSecond.errors).toBeUndefined();
    expect(projectSecond.data!.project.issues.nodes).toHaveLength(3);
    expect(projectSecond.data!.project.issues.pageInfo.hasNextPage).toBe(false);

    const milestoneFirst = await gql(
      app,
      `
      query($projectId: ID!) {
        project(id: $projectId) {
          milestones { id issues(first: 50) { nodes { id } pageInfo { hasNextPage endCursor } } }
        }
      }
    `,
      { projectId },
    );
    const milestoneFirstPage = milestoneFirst.data!.project.milestones.find(
      (milestone: { id: string }) => milestone.id === milestoneId,
    ).issues;
    expect(milestoneFirstPage.nodes).toHaveLength(50);
    expect(milestoneFirstPage.pageInfo.hasNextPage).toBe(true);

    const milestoneSecond = await gql(
      app,
      `
      query($projectId: ID!, $after: String!) {
        project(id: $projectId) {
          milestones { id issues(first: 50, after: $after) { nodes { id } pageInfo { hasNextPage } } }
        }
      }
    `,
      { projectId, after: milestoneFirstPage.pageInfo.endCursor },
    );
    expect(milestoneSecond.errors).toBeUndefined();
    const milestoneSecondPage = milestoneSecond.data!.project.milestones.find(
      (milestone: { id: string }) => milestone.id === milestoneId,
    ).issues;
    expect(milestoneSecondPage.nodes).toHaveLength(1);
    expect(milestoneSecondPage.pageInfo.hasNextPage).toBe(false);
  });

  it("actualiza estado y lo refleja en el listado filtrado", async () => {
    await gql(
      app,
      `
      mutation($id: ID!) { projectUpdate(id: $id, input: { state: COMPLETED }) { success } }
    `,
      { id: projectId },
    );
    const completed = await gql(app, `{ projects(state: COMPLETED) { name } }`);
    expect(completed.data!.projects).toEqual([{ name: "MVP backend" }]);
    const started = await gql(app, `{ projects(state: STARTED) { name } }`);
    expect(started.data!.projects).toEqual([]);
  });

  it("valida estado y lead", async () => {
    const badLead = await gql(
      app,
      `
      mutation { projectCreate(input: { name: "X", leadId: "nope" }) { success } }
    `,
    );
    expect(badLead.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});
