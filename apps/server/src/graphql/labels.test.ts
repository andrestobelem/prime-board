// Tests de AT-135: labels de workspace y de team aplicadas a issues.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let teamId: string;
let bugId: string;
let urgentId: string;

beforeAll(async () => {
  app = createTestApp();
  const team = await gql(app, `{ team(key: "PB") { id } }`);
  teamId = team.data!.team.id;
  const bug = await gql(
    app,
    `
    mutation($teamId: ID!) { labelCreate(input: { name: "bug", color: "#eb5757", teamId: $teamId }) { label { id } } }
  `,
    { teamId },
  );
  bugId = bug.data!.labelCreate.label.id;
  const urgent = await gql(
    app,
    `
    mutation { labelCreate(input: { name: "agent:review" }) { label { id teamId } } }
  `,
  );
  urgentId = urgent.data!.labelCreate.label.id;
  await gql(
    app,
    `mutation { issueCreate(input: { teamKey: "PB", title: "Labeled issue" }) { issue { id } } }`,
  );
});
afterAll(() => app.stop());

describe("labels", () => {
  it("distingue labels de workspace (teamId null) y de team", async () => {
    const result = await gql(app, `query($team: ID) { labels(team: $team) { name teamId } }`, {
      team: teamId,
    });
    const byName = Object.fromEntries(result.data!.labels.map((l: any) => [l.name, l.teamId]));
    expect(byName["agent:review"]).toBeNull();
    expect(byName["bug"]).toBe(teamId);
  });

  it("rechaza duplicados en el mismo scope", async () => {
    const dup = await gql(
      app,
      `mutation { labelCreate(input: { name: "agent:review" }) { success } }`,
    );
    expect(dup.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("etiqueta un issue con add/remove y set completo", async () => {
    const added = await gql(
      app,
      `
      mutation($add: [ID!]) {
        issueUpdate(id: "PB-1", input: { addLabelIds: $add }) { issue { labels { name } } }
      }
    `,
      { add: [bugId, urgentId] },
    );
    expect(added.data!.issueUpdate.issue.labels.map((l: any) => l.name).sort()).toEqual([
      "agent:review",
      "bug",
    ]);

    const removed = await gql(
      app,
      `
      mutation($remove: [ID!]) {
        issueUpdate(id: "PB-1", input: { removeLabelIds: $remove }) { issue { labels { name } } }
      }
    `,
      { remove: [bugId] },
    );
    expect(removed.data!.issueUpdate.issue.labels.map((l: any) => l.name)).toEqual([
      "agent:review",
    ]);

    const set = await gql(
      app,
      `
      mutation($set: [ID!]) {
        issueUpdate(id: "PB-1", input: { labelIds: $set }) { issue { labels { name } } }
      }
    `,
      { set: [bugId] },
    );
    expect(set.data!.issueUpdate.issue.labels.map((l: any) => l.name)).toEqual(["bug"]);
  });

  it("rechaza labels de otro team", async () => {
    const other = await gql(
      app,
      `mutation { teamCreate(input: { name: "Other", key: "OX" }) { team { id } } }`,
    );
    const foreign = await gql(
      app,
      `
      mutation($teamId: ID!) { labelCreate(input: { name: "foreign", teamId: $teamId }) { label { id } } }
    `,
      { teamId: other.data!.teamCreate.team.id },
    );
    const bad = await gql(
      app,
      `
      mutation($add: [ID!]) { issueUpdate(id: "PB-1", input: { addLabelIds: $add }) { success } }
    `,
      { add: [foreign.data!.labelCreate.label.id] },
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("aplica labels en la creación, sin issueUpdate extra (AT-28)", async () => {
    const result = await gql(
      app,
      `
      mutation($labels: [ID!]) {
        issueCreate(input: { teamKey: "PB", title: "Con labels de una", labelIds: $labels }) {
          issue { identifier labels { name } }
        }
      }
    `,
      { labels: [bugId, urgentId] },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data!.issueCreate.issue.labels.map((l: any) => l.name).sort()).toEqual([
      "agent:review",
      "bug",
    ]);
  });

  it("rechaza en la creación labels de otro team", async () => {
    const other = await gql(
      app,
      `mutation { teamCreate(input: { name: "Third", key: "TH" }) { team { id } } }`,
    );
    const foreign = await gql(
      app,
      `
      mutation($teamId: ID!) { labelCreate(input: { name: "third-label", teamId: $teamId }) { label { id } } }
    `,
      { teamId: other.data!.teamCreate.team.id },
    );
    const bad = await gql(
      app,
      `
      mutation($labels: [ID!]) {
        issueCreate(input: { teamKey: "PB", title: "Nope", labelIds: $labels }) { success }
      }
    `,
      { labels: [foreign.data!.labelCreate.label.id] },
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("registra actividad y updatedAt al borrar una label dependiente", async () => {
    const label = await gql(
      app,
      `
      mutation($teamId: ID!) {
        labelCreate(input: { name: "deleted-label", teamId: $teamId }) { label { id } }
      }
    `,
      { teamId },
    );
    const labelId = label.data!.labelCreate.label.id;
    const issue = await gql(
      app,
      `
      mutation($labels: [ID!]) {
        issueCreate(input: { teamKey: "PB", title: "Label lifecycle", labelIds: $labels }) {
          issue { id updatedAt }
        }
      }
    `,
      { labels: [labelId] },
    );
    const issueId = issue.data!.issueCreate.issue.id;
    const before = issue.data!.issueCreate.issue.updatedAt;
    await Bun.sleep(2);

    const deleted = await gql(
      app,
      `mutation($id: ID!) {
      labelDelete(id: $id) { success affectedIssues }
    }`,
      { id: labelId },
    );
    expect(deleted.data!.labelDelete).toEqual({ success: true, affectedIssues: 1 });

    const after = await gql(
      app,
      `query($id: ID!) {
      issue(id: $id) { updatedAt labels { name } activity { type actor { name } payload } }
    }`,
      { id: issueId },
    );
    expect(after.data!.issue.labels).toEqual([]);
    expect(after.data!.issue.updatedAt).not.toBe(before);
    expect(after.data!.issue.updatedAt >= before).toBe(true);
    expect(after.data!.issue.activity).toContainEqual({
      type: "unlabeled",
      actor: { name: "admin" },
      payload: { label: "deleted-label", reason: "label_deleted" },
    });
  });
});
