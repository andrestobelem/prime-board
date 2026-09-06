import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("project dependency GraphQL contract", () => {
  it("matches SQLite validation and relation output", async () => {
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const teamId = team.data!.team.id as string;
    const sourceResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "Dependency source", teamIds: [$teamId] }) { project { id } } }`,
      { teamId },
    );
    const sourceId = sourceResult.data!.projectCreate.project.id as string;
    const targetResult = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "Dependency target", teamIds: [$teamId] }) { project { id } } }`,
      { teamId },
    );
    const targetId = targetResult.data!.projectCreate.project.id as string;

    const related = await gql(
      app,
      `mutation($source: ID!, $target: ID!) {
        projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target, type: RELATED }) {
          success dependency { id project { id } dependsOnProject { id } type createdAt }
        }
      }`,
      { source: sourceId, target: targetId },
    );
    expect(related.errors).toBeUndefined();
    expect(related.data!.projectDependencyCreate).toMatchObject({
      success: true,
      dependency: {
        project: { id: sourceId },
        dependsOnProject: { id: targetId },
        type: "RELATED",
      },
    });

    const self = await gql(
      app,
      `mutation($source: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $source }) { success } }`,
      { source: sourceId },
    );
    expect(self.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const missing = await gql(
      app,
      `mutation($source: ID!, $target: ID!) { projectDependencyCreate(input: { projectId: $source, dependsOnProjectId: $target }) { success } }`,
      { source: sourceId, target: "missing-project" },
    );
    expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const dependencyId = related.data!.projectDependencyCreate.dependency.id as string;
    const deleted = await gql(
      app,
      `mutation($id: ID!) { projectDependencyDelete(id: $id) { success } }`,
      { id: dependencyId },
    );
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data!.projectDependencyDelete).toEqual({ success: true });
  });
});
