// PRB-207: project updates — CRUD e historial en el proyecto.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("project updates", () => {
  it("crea un update y lo lista en el proyecto", async () => {
    const project = await gql(
      app,
      `mutation {
        projectCreate(input: { name: "Status project" }) { project { id } }
      }`,
    );
    const projectId = project.data!.projectCreate.project.id;

    const created = await gql(
      app,
      `
      mutation($input: ProjectUpdateCreateInput!) {
        projectUpdateCreate(input: $input) {
          success
          projectUpdate {
            id
            health
            body
            risks
            author { name }
            project { id }
          }
        }
      }
    `,
      {
        input: {
          projectId,
          health: "AT_RISK",
          body: "Blocked on API keys",
          risks: "Need admin review",
        },
      },
    );

    expect(created.errors).toBeUndefined();
    expect(created.data!.projectUpdateCreate.projectUpdate).toMatchObject({
      health: "AT_RISK",
      body: "Blocked on API keys",
      risks: "Need admin review",
      author: { name: "admin" },
      project: { id: projectId },
    });

    const fetched = await gql(
      app,
      `query($id: ID!) {
        project(id: $id) {
          updates { body health risks author { name } }
        }
      }`,
      { id: projectId },
    );
    expect(fetched.data!.project.updates).toEqual([
      {
        body: "Blocked on API keys",
        health: "AT_RISK",
        risks: "Need admin review",
        author: { name: "admin" },
      },
    ]);
  });
});
