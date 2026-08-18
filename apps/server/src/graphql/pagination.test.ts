// Regresiones públicas de validación de paginación GraphQL (PRB-311).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(app, `{ team(key: "PB") { id } }`);
  const teamId = team.data!.team.id;

  const project = await gql(
    app,
    `
    mutation($teamId: ID!) {
      projectCreate(input: { name: "Paginated project", teamIds: [$teamId] }) { project { id } }
    }
  `,
    { teamId },
  );
  projectId = project.data!.projectCreate.project.id;

  const otherProject = await gql(
    app,
    `
    mutation($teamId: ID!) {
      projectCreate(input: { name: "Other project", teamIds: [$teamId] }) { project { id } }
    }
  `,
    { teamId },
  );
  otherProjectId = otherProject.data!.projectCreate.project.id;

  for (const title of ["Nested one", "Nested two", "Nested three"]) {
    const created = await gql(
      app,
      `
      mutation($projectId: ID!, $title: String!) {
        issueCreate(input: { teamKey: "PB", title: $title, projectId: $projectId }) { success }
      }
    `,
      { projectId, title },
    );
    expect(created.errors).toBeUndefined();
  }
  const outside = await gql(
    app,
    `
    mutation($projectId: ID!) {
      issueCreate(input: { teamKey: "PB", title: "Other project issue", projectId: $projectId }) {
        success
      }
    }
  `,
    { projectId: otherProjectId },
  );
  expect(outside.errors).toBeUndefined();
});

afterAll(() => app.stop());

describe("issue connection arguments", () => {
  it.each([0, -1, 251])("rejects first=%i", async (first: number) => {
    const result = await gql(
      app,
      `
      query($first: Int!) { issues(first: $first) { nodes { identifier } } }
    `,
      { first },
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("rejects malformed and truncated cursors", async () => {
    const page = await gql(app, `query { issues(first: 1) { pageInfo { endCursor } } }`);
    const cursors = ["nonsense", page.data!.issues.pageInfo.endCursor.slice(0, -1)];
    for (const cursor of cursors) {
      const result = await gql(
        app,
        `
        query($cursor: String!) { issues(first: 1, after: $cursor) { nodes { identifier } } }
      `,
        { cursor },
      );
      expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects a cursor produced with a different order", async () => {
    const first = await gql(
      app,
      `
      query { issues(first: 1, orderBy: CREATED_DESC) { pageInfo { endCursor } } }
    `,
    );
    const result = await gql(
      app,
      `
      query($cursor: String!) {
        issues(first: 1, orderBy: UPDATED_DESC, after: $cursor) { nodes { identifier } }
      }
    `,
      { cursor: first.data!.issues.pageInfo.endCursor },
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a cursor produced for a different filtered query", async () => {
    const first = await gql(
      app,
      `
      query($projectId: ID!) {
        issues(filter: { project: { eq: $projectId } }, first: 1) {
          pageInfo { endCursor }
        }
      }
    `,
      { projectId },
    );
    const result = await gql(
      app,
      `
      query($projectId: ID!, $cursor: String!) {
        issues(filter: { project: { eq: $projectId } }, first: 1, after: $cursor) {
          nodes { identifier }
        }
      }
    `,
      { projectId: otherProjectId, cursor: first.data!.issues.pageInfo.endCursor },
    );
    expect(result.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});
