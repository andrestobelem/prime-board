// PRB-404: matriz preparatoria de aislamiento entre Workspaces.
// El fixture ajeno vive en otra DB en memoria; nunca se agrega a la DB operativa.
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertWorkspaceId, resolveWorkspaceContext } from "../domain/workspace-context.ts";
import { migrate } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";
import {
  createDetachedWorkspaceFixture,
  createTestApp,
  gql,
  type DetachedWorkspaceFixture,
  type TestApp,
} from "../test-helpers.ts";

const app: TestApp = createTestApp();
const foreign: DetachedWorkspaceFixture = createDetachedWorkspaceFixture();

afterAll(() => {
  foreign.close();
  app.stop();
});

function countWorkspaces(db: Database): number {
  return (db.query("SELECT count(*) AS count FROM workspace").get() as { count: number }).count;
}

async function createActiveIssue(title: string): Promise<{ id: string; identifier: string }> {
  const result = await gql(
    app,
    `mutation($title: String!) {
      issueCreate(input: { teamKey: "PB", title: $title }) { issue { id identifier } }
    }`,
    { title },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.issueCreate.issue as { id: string; identifier: string };
}

describe("cross-workspace isolation matrix", () => {
  it("mantiene un solo Workspace operativo y rechaza el contexto ajeno", () => {
    const context = resolveWorkspaceContext(app.db);

    expect(countWorkspaces(app.db)).toBe(1);
    expect(context.workspaceId).not.toBe(foreign.workspaceId);
    expect(() => assertWorkspaceId(context, context.workspaceId)).not.toThrow();
    expect(() => assertWorkspaceId(context, foreign.workspaceId)).toThrow(
      "Resource not found in the active Workspace",
    );
  });

  it("no resuelve IDs directos de entidades del Workspace ajeno", async () => {
    const result = await gql(
      app,
      `query($issue: ID!, $team: ID!, $project: ID!) {
        issue(id: $issue) { id }
        team(id: $team) { id }
        project(id: $project) { id }
      }`,
      { issue: foreign.issueId, team: foreign.teamId, project: foreign.projectId },
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ issue: null, team: null, project: null });
  });

  it("rechaza referencias ajenas en relaciones entre entidades", async () => {
    const active = await createActiveIssue("Cross-workspace relation target");
    const before = (
      app.db.query("SELECT count(*) AS count FROM issue_relations").get() as {
        count: number;
      }
    ).count;

    const relation = await gql(
      app,
      `mutation($issue: ID!, $related: ID!) {
        issueRelationCreate(input: {
          issueId: $issue, relatedIssueId: $related, type: RELATED
        }) { success }
      }`,
      { issue: active.id, related: foreign.issueId },
    );

    expect(relation.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    expect(relation.errors?.[0]?.message).toContain(foreign.issueId);
    expect(
      (app.db.query("SELECT count(*) AS count FROM issue_relations").get() as { count: number })
        .count,
    ).toBe(before);

    const deleted = await gql(
      app,
      `mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`,
      { id: foreign.relationId },
    );
    expect(deleted.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const parent = await gql(
      app,
      `mutation($id: ID!, $parent: ID!) {
        issueUpdate(id: $id, input: { parentId: $parent }) { success }
      }`,
      { id: active.id, parent: foreign.issueId },
    );
    expect(parent.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const project = await gql(
      app,
      `mutation($id: ID!, $project: ID!) {
        issueUpdate(id: $id, input: { projectId: $project }) { success }
      }`,
      { id: active.id, project: foreign.projectId },
    );
    expect(project.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("no permite que el bypass de admin atraviese la frontera del Workspace", async () => {
    const issue = await gql(
      app,
      `mutation($id: ID!) { issueUpdate(id: $id, input: { priority: 1 }) { success } }`,
      { id: foreign.issueId },
    );
    expect(issue.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const actor = await gql(
      app,
      `mutation($id: ID!) { actorUpdate(id: $id, input: { name: "foreign-renamed" }) { success } }`,
      { id: foreign.actorId },
    );
    expect(actor.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const project = await gql(app, `mutation($id: ID!) { projectArchive(id: $id) { success } }`, {
      id: foreign.projectId,
    });
    expect(project.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("no expone ni permite borrar Webhooks ajenos", async () => {
    const listed = await gql(app, "{ webhooks { id } }");
    expect(listed.errors).toBeUndefined();
    expect(listed.data!.webhooks).not.toContainEqual({ id: foreign.webhookId });

    const deleted = await gql(app, `mutation($id: ID!) { webhookDelete(id: $id) { success } }`, {
      id: foreign.webhookId,
    });
    expect(deleted.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  it("reconstruye el export ajeno como una sola instalación y no exporta credenciales", () => {
    const dir = mkdtempSync(join(tmpdir(), "prime-board-cross-workspace-"));
    const rebuilt = new Database(":memory:", { strict: true });
    rebuilt.exec("PRAGMA foreign_keys = ON;");
    migrate(rebuilt);

    try {
      exportBoard(foreign.db, dir);
      const result = rebuildFromRepo(rebuilt, dir);

      expect(result.issues).toBe(2);
      expect(countWorkspaces(rebuilt)).toBe(1);
      expect((rebuilt.query("SELECT id FROM workspace").get() as { id: string }).id).not.toBe(
        foreign.workspaceId,
      );
      expect(
        (rebuilt.query("SELECT count(*) AS count FROM issue_relations").get() as { count: number })
          .count,
      ).toBe(1);
      // Los secretos de Webhook pertenecen al Operational State y no viajan al repo.
      expect(
        (rebuilt.query("SELECT count(*) AS count FROM webhooks").get() as { count: number }).count,
      ).toBe(0);
    } finally {
      rebuilt.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
