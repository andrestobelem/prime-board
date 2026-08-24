// PRB-476: las subconsultas de filtros y FTS respetan el Workspace efectivo.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let workspaceAKey: string;
let workspaceAId: string;
let workspaceBKey: string;
let workspaceBId: string;
let viewerId: string;
let issueBlockerId: string;
let issueTargetId: string;
let workspaceBLabelId: string;

async function createIssue(title: string, workspaceSelector?: string): Promise<string> {
  const result = await gql(
    app,
    `mutation($title: String!) { issueCreate(input: { teamKey: "PB", title: $title }) { issue { id } } }`,
    { title },
    app.apiKey,
    workspaceSelector ?? workspaceAKey,
  );
  expect(result.errors).toBeUndefined();
  return result.data!.issueCreate.issue.id;
}

async function filterIssueIds(filter: Record<string, unknown>): Promise<string[]> {
  const result = await gql(
    app,
    `query($filter: IssueFilter) { issues(first: 50, filter: $filter) { nodes { id } } }`,
    { filter },
    app.apiKey,
    workspaceAKey,
  );
  expect(result.errors).toBeUndefined();
  return result.data!.issues.nodes.map((node: { id: string }) => node.id);
}

describe("workspace scope for issue filters", () => {
  beforeAll(async () => {
    app = createTestApp();
    const initial = await gql(app, `{ workspace { id urlKey } viewer { id } }`);
    expect(initial.errors).toBeUndefined();
    workspaceAId = initial.data!.workspace.id;
    workspaceAKey = initial.data!.workspace.urlKey;
    viewerId = initial.data!.viewer.id;
    issueBlockerId = await createIssue("A blocker");
    issueTargetId = await createIssue("A target");

    const created = await gql(
      app,
      `mutation { workspaceCreate(input: { name: "Filter B", urlKey: "filter-b" }) { workspace { id urlKey } } }`,
    );
    expect(created.errors).toBeUndefined();
    workspaceBId = created.data!.workspaceCreate.workspace.id;
    workspaceBKey = created.data!.workspaceCreate.workspace.urlKey;
    const label = await gql(
      app,
      `mutation { labelCreate(input: { name: "B-only-label" }) { label { id } } }`,
      {},
      app.apiKey,
      workspaceBKey,
    );
    expect(label.errors).toBeUndefined();
    workspaceBLabelId = label.data!.labelCreate.label.id;

    // Estas filas representan datos corruptos o legacy que no deben convertir
    // una relación de otro Workspace en un resultado visible.
    app.db.exec("PRAGMA foreign_keys = OFF");
    app.db
      .query("INSERT INTO issue_labels (issue_id, label_id, workspace_id) VALUES (?1, ?2, ?3)")
      .run(issueTargetId, workspaceBLabelId, workspaceAId);
    app.db
      .query(
        "INSERT INTO issue_subscribers (issue_id, actor_id, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4)",
      )
      .run(issueTargetId, viewerId, new Date().toISOString(), workspaceBId);
    app.db
      .query(
        "INSERT INTO issue_relations (id, issue_id, related_id, type, created_at, workspace_id) VALUES (?1, ?2, ?3, 'blocks', ?4, ?5)",
      )
      .run(
        "cross-workspace-filter-relation",
        issueBlockerId,
        issueTargetId,
        new Date().toISOString(),
        workspaceBId,
      );
    app.db
      .query(
        "INSERT INTO comments (id, issue_id, actor_id, body, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .run(
        "cross-workspace-filter-comment",
        issueTargetId,
        viewerId,
        "B-only-search-token",
        new Date().toISOString(),
        workspaceBId,
      );
    app.db.exec("PRAGMA foreign_keys = ON");
  });

  afterAll(() => app.stop());

  it("no cruza labels, subscribers, frontier ni comentarios FTS", async () => {
    await expect(
      filterIssueIds({ labels: { includes: workspaceBLabelId } }),
    ).resolves.not.toContain(issueTargetId);
    await expect(filterIssueIds({ subscribed: true })).resolves.not.toContain(issueTargetId);
    await expect(filterIssueIds({ unblocked: false })).resolves.not.toContain(issueTargetId);
    await expect(filterIssueIds({ search: "B-only-search-token" })).resolves.not.toContain(
      issueTargetId,
    );
  });
});
