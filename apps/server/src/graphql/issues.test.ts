// Tests de AT-134: ciclo de vida completo de un issue con sub-issues vía GraphQL.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let teamId: string;
let states: Array<{ id: string; name: string; type: string }>;

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(app, `{ team(key: "PB") { id states { id name type } } }`);
  teamId = team.data!.team.id;
  states = team.data!.team.states;
});
afterAll(() => app.stop());

const stateBy = (type: string) => states.find((state) => state.type === type)!;

describe("issueCreate", () => {
  it("crea un issue con identificador legible y defaults", async () => {
    const result = await gql(
      app,
      `
      mutation {
        issueCreate(input: { teamKey: "PB", title: "Set up webhooks", description: "HMAC signed" }) {
          issue {
            identifier title priority
            state { type }
            creator { name }
            branchName
          }
        }
      }
    `,
    );
    expect(result.errors).toBeUndefined();
    const issue = result.data!.issueCreate.issue;
    expect(issue.identifier).toBe("PB-1");
    expect(issue.priority).toBe(0);
    expect(issue.state.type).toBe("BACKLOG");
    expect(issue.creator.name).toBe("admin");
    expect(issue.branchName).toBe("board/pb-1-set-up-webhooks");
  });

  it("numera secuencialmente por team", async () => {
    const second = await gql(
      app,
      `
      mutation { issueCreate(input: { teamKey: "PB", title: "Second" }) { issue { identifier } } }
    `,
    );
    expect(second.data!.issueCreate.issue.identifier).toBe("PB-2");
  });

  it("crea sub-issues colgadas de un padre", async () => {
    const parent = await gql(app, `{ issue(id: "PB-1") { id } }`);
    const child = await gql(
      app,
      `
      mutation($parentId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Write dispatcher", parentId: $parentId }) {
          issue { identifier parent { identifier } }
        }
      }
    `,
      { parentId: parent.data!.issue.id },
    );
    expect(child.data!.issueCreate.issue.parent.identifier).toBe("PB-1");

    const withChildren = await gql(app, `{ issue(id: "PB-1") { children { identifier } } }`);
    expect(withChildren.data!.issue.children.map((c: any) => c.identifier)).toEqual(["PB-3"]);
  });
});

describe("issueUpdate", () => {
  it("mueve el issue por estados hasta Done con prioridad y assignee", async () => {
    const result = await gql(
      app,
      `
      mutation($stateId: ID!) {
        issueUpdate(id: "PB-1", input: { stateId: $stateId, priority: 1 }) {
          issue { state { type } priority }
        }
      }
    `,
      { stateId: stateBy("STARTED").id },
    );
    expect(result.data!.issueUpdate.issue.state.type).toBe("STARTED");
    expect(result.data!.issueUpdate.issue.priority).toBe(1);

    const done = await gql(
      app,
      `
      mutation($stateId: ID!) {
        issueUpdate(id: "PB-1", input: { stateId: $stateId }) { issue { state { type } } }
      }
    `,
      { stateId: stateBy("COMPLETED").id },
    );
    expect(done.data!.issueUpdate.issue.state.type).toBe("COMPLETED");
  });

  it("rechaza estados de otro team y prioridades inválidas", async () => {
    const other = await gql(
      app,
      `mutation { teamCreate(input: { name: "Other", key: "OT" }) { team { states { id } } } }`,
    );
    const foreignState = other.data!.teamCreate.team.states[0].id;
    const bad = await gql(
      app,
      `
      mutation($stateId: ID!) { issueUpdate(id: "PB-1", input: { stateId: $stateId }) { success } }
    `,
      { stateId: foreignState },
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const badPriority = await gql(
      app,
      `
      mutation { issueUpdate(id: "PB-1", input: { priority: 9 }) { success } }
    `,
    );
    expect(badPriority.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("evita ciclos de parentesco", async () => {
    const parent = await gql(app, `{ issue(id: "PB-1") { id } }`);
    const child = await gql(app, `{ issue(id: "PB-3") { id } }`);
    const cycle = await gql(
      app,
      `
      mutation($id: ID!, $parentId: ID!) {
        issueUpdate(id: $id, input: { parentId: $parentId }) { success }
      }
    `,
      { id: parent.data!.issue.id, parentId: child.data!.issue.id },
    );
    expect(cycle.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});

describe("issues query + archive", () => {
  it("lista con filtro por team y excluye archivados", async () => {
    const before = await gql(
      app,
      `
      query($teamId: ID!) { issues(filter: { team: { eq: $teamId } }) { nodes { identifier } } }
    `,
      { teamId },
    );
    expect(before.data!.issues.nodes.length).toBe(3);

    await gql(app, `mutation { issueArchive(id: "PB-2") { issue { archivedAt } } }`);
    const after = await gql(
      app,
      `
      query($teamId: ID!) { issues(filter: { team: { eq: $teamId } }) { nodes { identifier } } }
    `,
      { teamId },
    );
    expect(after.data!.issues.nodes.map((n: any) => n.identifier).sort()).toEqual(["PB-1", "PB-3"]);
  });

  it("resuelve issue por UUID y por identificador", async () => {
    const byIdentifier = await gql(app, `{ issue(id: "PB-1") { id title } }`);
    const uuid = byIdentifier.data!.issue.id;
    const viaUuid = await gql(app, `query($id: ID!) { issue(id: $id) { identifier } }`, {
      id: uuid,
    });
    expect(viaUuid.data!.issue.identifier).toBe("PB-1");
  });

  it("excluye hijos archivados de la jerarquía activa", async () => {
    const parent = await gql(
      app,
      `
      mutation { issueCreate(input: { teamKey: "PB", title: "Parent with archived child" }) {
        issue { id }
      } }
    `,
    );
    const child = await gql(
      app,
      `
      mutation($parentId: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Archived child", parentId: $parentId }) {
          issue { id identifier }
        }
      }
    `,
      { parentId: parent.data!.issueCreate.issue.id },
    );
    await gql(app, `mutation($id: ID!) { issueArchive(id: $id) { success } }`, {
      id: child.data!.issueCreate.issue.id,
    });

    const result = await gql(
      app,
      `
      query($id: ID!) { issue(id: $id) { children { identifier archivedAt } } }
    `,
      { id: parent.data!.issueCreate.issue.id },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data!.issue.children).toEqual([]);

    const history = await gql(
      app,
      `
      query($id: ID!) {
        issue(id: $id) { children(includeArchived: true) { identifier archivedAt } }
      }
    `,
      { id: parent.data!.issueCreate.issue.id },
    );
    expect(history.errors).toBeUndefined();
    expect(history.data!.issue.children).toEqual([
      { identifier: child.data!.issueCreate.issue.identifier, archivedAt: expect.any(String) },
    ]);
  });

  it("rechaza ciclos de parent que superan 100 niveles", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 102; index += 1) {
      const created = await gql(
        app,
        `
        mutation($title: String!) {
          issueCreate(input: { teamKey: "PB", title: $title }) { issue { id } }
        }
      `,
        { title: `Deep parent ${index}` },
      );
      expect(created.errors).toBeUndefined();
      ids.push(created.data!.issueCreate.issue.id);
    }

    for (let index = 1; index < ids.length; index += 1) {
      const linked = await gql(
        app,
        `
        mutation($id: ID!, $parentId: ID!) {
          issueUpdate(id: $id, input: { parentId: $parentId }) { success }
        }
      `,
        { id: ids[index], parentId: ids[index - 1] },
      );
      expect(linked.errors).toBeUndefined();
    }

    const cycle = await gql(
      app,
      `
      mutation($id: ID!, $parentId: ID!) {
        issueUpdate(id: $id, input: { parentId: $parentId }) { success }
      }
    `,
      { id: ids[0], parentId: ids[ids.length - 1] },
    );
    expect(cycle.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const root = await gql(app, `query($id: ID!) { issue(id: $id) { parent { id } } }`, {
      id: ids[0],
    });
    expect(root.data!.issue.parent).toBeNull();
  });
});
