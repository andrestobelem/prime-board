// PRB-476: las Issues, relaciones, comentarios y Activity conservan el Workspace efectivo.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let workspaceAId: string;
let workspaceBId: string;
let workspaceBKey: string;
let teamAId: string;
let teamBId: string;
let issueA1: string;
let issueA2: string;
let issueB1: string;
let issueB2: string;
let projectB: string;
let labelB: string;
let relationB: string;

async function createIssue(
  selector: string | null,
  teamKey: string,
  title: string,
  labelIds: string[] = [],
): Promise<string> {
  const result = await gql(
    app,
    `mutation($teamKey: String!, $title: String!, $labelIds: [ID!]) {
      issueCreate(input: { teamKey: $teamKey, title: $title, labelIds: $labelIds }) { issue { id } }
    }`,
    { teamKey, title, labelIds },
    app.apiKey,
    selector,
  );
  expect(result.errors).toBeUndefined();
  return result.data!.issueCreate.issue.id;
}

describe("issue Workspace isolation", () => {
  beforeAll(async () => {
    app = createTestApp();
    const workspace = await gql(app, "{ workspace { id } }");
    workspaceAId = workspace.data!.workspace.id;
    const teamA = await gql(app, '{ team(key: "PB") { id } }');
    teamAId = teamA.data!.team.id;
    issueA1 = await createIssue(null, "PB", "A one");
    issueA2 = await createIssue(null, "PB", "A two");

    const created = await gql(
      app,
      `mutation { workspaceCreate(input: { name: "Issues B", urlKey: "issues-b" }) {
        workspace { id urlKey }
      } }`,
    );
    expect(created.errors).toBeUndefined();
    workspaceBId = created.data!.workspaceCreate.workspace.id;
    workspaceBKey = created.data!.workspaceCreate.workspace.urlKey;
    const teamB = await gql(app, "{ teams { id key } }", {}, app.apiKey, workspaceBKey);
    const selectedTeam = teamB.data!.teams[0];
    teamBId = selectedTeam.id;
    const project = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "B project", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: teamBId },
      app.apiKey,
      workspaceBKey,
    );
    expect(project.errors).toBeUndefined();
    projectB = project.data!.projectCreate.project.id;
    const label = await gql(
      app,
      `mutation { labelCreate(input: { name: "B label" }) { label { id } } }`,
      {},
      app.apiKey,
      workspaceBKey,
    );
    expect(label.errors).toBeUndefined();
    labelB = label.data!.labelCreate.label.id;
    issueB1 = await createIssue(workspaceBKey, selectedTeam.key, "B one", [labelB]);
    issueB2 = await createIssue(workspaceBKey, selectedTeam.key, "B two");

    const comment = await gql(
      app,
      `mutation($issueId: ID!) { commentCreate(input: { issueId: $issueId, body: "B comment" }) { comment { id } } }`,
      { issueId: issueB1 },
      app.apiKey,
      workspaceBKey,
    );
    expect(comment.errors).toBeUndefined();
    const relation = await gql(
      app,
      `mutation($issueId: ID!, $relatedIssueId: ID!) {
        issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: RELATED }) {
          relation { id }
        }
      }`,
      { issueId: issueB1, relatedIssueId: issueB2 },
      app.apiKey,
      workspaceBKey,
    );
    expect(relation.errors).toBeUndefined();
    relationB = relation.data!.issueRelationCreate.relation.id;
    const commentA = await gql(
      app,
      `mutation($issueId: ID!) { commentCreate(input: { issueId: $issueId, body: "A comment" }) { success } }`,
      { issueId: issueA1 },
    );
    expect(commentA.errors).toBeUndefined();
    const relationA = await gql(
      app,
      `mutation($issueId: ID!, $relatedIssueId: ID!) {
        issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: RELATED }) { success }
      }`,
      { issueId: issueA1, relatedIssueId: issueA2 },
    );
    expect(relationA.errors).toBeUndefined();
  });

  afterAll(() => app.stop());

  it("lista Issues, comentarios y relaciones solo del Workspace seleccionado", async () => {
    const a = await gql(
      app,
      `query { issues { nodes { id } } issue(id: \"${issueA1}\") { comments { body } relations { id } } }`,
    );
    expect(a.errors).toBeUndefined();
    expect(a.data!.issues.nodes.map((row: { id: string }) => row.id)).toContain(issueA1);
    expect(a.data!.issues.nodes.map((row: { id: string }) => row.id)).not.toContain(issueB1);
    expect(a.data!.issue.comments).toEqual([{ body: "A comment" }]);
    expect(a.data!.issue.relations).toHaveLength(1);

    const b = await gql(
      app,
      `query { issues { nodes { id } } issue(id: \"${issueB1}\") { comments { body } labels { id } relations { id } } }`,
      {},
      app.apiKey,
      workspaceBKey,
    );
    expect(b.errors).toBeUndefined();
    expect(b.data!.issues.nodes.map((row: { id: string }) => row.id)).toContain(issueB1);
    expect(b.data!.issues.nodes.map((row: { id: string }) => row.id)).not.toContain(issueA1);
    expect(b.data!.issue.comments).toEqual([{ body: "B comment" }]);
    expect(b.data!.issue.labels).toEqual([{ id: labelB }]);
    expect(b.data!.issue.relations).toEqual([{ id: relationB }]);

    expect(
      (
        app.db.query("SELECT workspace_id FROM issues WHERE id = ?1").get(issueA1) as {
          workspace_id: string;
        }
      ).workspace_id,
    ).toBe(workspaceAId);
    expect(
      (
        app.db.query("SELECT workspace_id FROM issues WHERE id = ?1").get(issueB1) as {
          workspace_id: string;
        }
      ).workspace_id,
    ).toBe(workspaceBId);
    expect(
      (
        app.db.query("SELECT workspace_id FROM activity WHERE issue_id = ?1").get(issueB1) as {
          workspace_id: string;
        }
      ).workspace_id,
    ).toBe(workspaceBId);
    expect(
      (
        app.db.query("SELECT workspace_id FROM comments WHERE issue_id = ?1").get(issueB1) as {
          workspace_id: string;
        }
      ).workspace_id,
    ).toBe(workspaceBId);
    expect(
      (
        app.db
          .query("SELECT workspace_id FROM issue_labels WHERE issue_id = ?1 AND label_id = ?2")
          .get(issueB1, labelB) as { workspace_id: string }
      ).workspace_id,
    ).toBe(workspaceBId);
    expect(
      (
        app.db.query("SELECT workspace_id FROM issue_relations WHERE id = ?1").get(relationB) as {
          workspace_id: string;
        }
      ).workspace_id,
    ).toBe(workspaceBId);
  });

  it("rechaza parent, project, relation y comment cross-workspace sin mutar conteos", async () => {
    const relationCount = (
      app.db.query("SELECT count(*) AS count FROM issue_relations").get() as { count: number }
    ).count;
    const commentCount = (
      app.db.query("SELECT count(*) AS count FROM comments").get() as { count: number }
    ).count;

    for (const [name, result] of [
      [
        "parent",
        await gql(
          app,
          `mutation($id: ID!, $parentId: ID!) { issueUpdate(id: $id, input: { parentId: $parentId }) { success } }`,
          { id: issueA2, parentId: issueB1 },
        ),
      ],
      [
        "project",
        await gql(
          app,
          `mutation($id: ID!, $projectId: ID!) { issueUpdate(id: $id, input: { projectId: $projectId }) { success } }`,
          { id: issueA1, projectId: projectB },
        ),
      ],
      [
        "relation",
        await gql(
          app,
          `mutation($issueId: ID!, $relatedIssueId: ID!) { issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: RELATED }) { success } }`,
          { issueId: issueA1, relatedIssueId: issueB1 },
        ),
      ],
      [
        "comment",
        await gql(
          app,
          `mutation($issueId: ID!) { commentCreate(input: { issueId: $issueId, body: "must fail" }) { success } }`,
          { issueId: issueB1 },
        ),
      ],
      [
        "relation delete",
        await gql(app, `mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`, {
          id: relationB,
        }),
      ],
    ] as Array<[string, Awaited<ReturnType<typeof gql>>]>) {
      expect(result.errors?.[0]?.extensions?.code, name).toBe("NOT_FOUND");
    }

    expect(
      (app.db.query("SELECT count(*) AS count FROM issue_relations").get() as { count: number })
        .count,
    ).toBe(relationCount);
    expect(
      (app.db.query("SELECT count(*) AS count FROM comments").get() as { count: number }).count,
    ).toBe(commentCount);
  });
});
