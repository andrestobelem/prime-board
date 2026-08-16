// PRB-206: iniciativas — CRUD y asociación de proyectos.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("initiatives", () => {
  it("crea una iniciativa, asocia un proyecto y la lista", async () => {
    const project = await gql(
      app,
      `mutation {
        projectCreate(input: { name: "Roadmap piece" }) {
          project { id name }
        }
      }`,
    );
    const projectId = project.data!.projectCreate.project.id;

    const created = await gql(
      app,
      `
      mutation($input: InitiativeCreateInput!) {
        initiativeCreate(input: $input) {
          success
          initiative {
            id
            name
            state
            description
            projects { id name }
          }
        }
      }
    `,
      {
        input: {
          name: "Q3 Goals",
          description: "Ship agent UX",
          state: "ACTIVE",
          projectIds: [projectId],
        },
      },
    );

    expect(created.errors).toBeUndefined();
    const initiative = created.data!.initiativeCreate.initiative;
    expect(initiative).toMatchObject({
      name: "Q3 Goals",
      state: "ACTIVE",
      description: "Ship agent UX",
      projects: [{ id: projectId, name: "Roadmap piece" }],
    });

    const listed = await gql(app, `{ initiatives { id name } }`);
    expect(listed.data!.initiatives.some((i: { id: string }) => i.id === initiative.id)).toBe(true);

    const updated = await gql(
      app,
      `mutation($id: ID!) {
        initiativeUpdate(id: $id, input: { name: "Q3 Goals v2", projectIds: [] }) {
          initiative { id name projects { id } }
        }
      }`,
      { id: initiative.id },
    );
    expect(updated.data!.initiativeUpdate.initiative).toMatchObject({
      id: initiative.id,
      name: "Q3 Goals v2",
      projects: [],
    });
  });
});
