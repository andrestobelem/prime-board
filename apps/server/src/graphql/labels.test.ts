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

  it("conserva descripción, grupos y exclusividad de labels", async () => {
    const groupResult = await gql(
      app,
      `mutation($teamId: ID!) {
        labelCreate(input: {
          name: "PRB group"
          description: "Mutually exclusive labels"
          teamId: $teamId
          isGroup: true
        }) {
          label { id name description isGroup teamId children { id } }
        }
      }`,
      { teamId },
    );
    expect(groupResult.errors).toBeUndefined();
    const group = groupResult.data!.labelCreate.label;
    expect(group).toMatchObject({
      name: "PRB group",
      description: "Mutually exclusive labels",
      isGroup: true,
      teamId,
      children: [],
    });

    const childAResult = await gql(
      app,
      `mutation($teamId: ID!, $groupId: ID!) {
        labelCreate(input: { name: "PRB one", teamId: $teamId, groupId: $groupId }) {
          label { id groupId group { name } }
        }
      }`,
      { teamId, groupId: group.id },
    );
    const childBResult = await gql(
      app,
      `mutation($teamId: ID!, $groupId: ID!) {
        labelCreate(input: { name: "PRB two", teamId: $teamId, groupId: $groupId }) {
          label { id }
        }
      }`,
      { teamId, groupId: group.id },
    );
    expect(childAResult.errors).toBeUndefined();
    expect(childBResult.errors).toBeUndefined();
    const childA = childAResult.data!.labelCreate.label;
    const childB = childBResult.data!.labelCreate.label;
    const groupWithChildren = await gql(
      app,
      `query { labels(includeArchived: true) { id children { id } } }`,
    );
    expect(groupWithChildren.errors).toBeUndefined();
    expect(
      groupWithChildren.data!.labels.find((label: any) => label.id === group.id).children,
    ).toEqual(expect.arrayContaining([{ id: childA.id }, { id: childB.id }]));

    const issue = await gql(
      app,
      `mutation($label: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Exclusive group issue", labelIds: [$label] }) {
          issue { id labels { id } }
        }
      }`,
      { label: childA.id },
    );
    expect(issue.errors).toBeUndefined();
    const conflict = await gql(
      app,
      `mutation($id: ID!, $label: ID!) {
        issueUpdate(id: $id, input: { addLabelIds: [$label] }) { success }
      }`,
      { id: issue.data!.issueCreate.issue.id, label: childB.id },
    );
    expect(conflict.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("archiva sin quitar labels existentes y permite unarchive", async () => {
    const labelResult = await gql(
      app,
      `mutation($teamId: ID!) {
        labelCreate(input: { name: "PRB archived", teamId: $teamId }) { label { id } }
      }`,
      { teamId },
    );
    const labelId = labelResult.data!.labelCreate.label.id;
    const issue = await gql(
      app,
      `mutation($label: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Archived label issue", labelIds: [$label] }) {
          issue { id labels { id } }
        }
      }`,
      { label: labelId },
    );
    const issueId = issue.data!.issueCreate.issue.id;
    const archived = await gql(
      app,
      `mutation($id: ID!) { labelArchive(id: $id) { label { id archivedAt } } }`,
      { id: labelId },
    );
    expect(archived.errors).toBeUndefined();
    expect(archived.data!.labelArchive.label.archivedAt).toBeTruthy();
    const hidden = await gql(app, `query { labels { id } }`);
    expect(hidden.data!.labels.map((label: any) => label.id)).not.toContain(labelId);
    const existing = await gql(app, `query($id: ID!) { issue(id: $id) { labels { id } } }`, {
      id: issueId,
    });
    expect(existing.data!.issue.labels).toEqual([{ id: labelId }]);
    const rejected = await gql(
      app,
      `mutation($label: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Cannot use archived", labelIds: [$label] }) { success }
      }`,
      { label: labelId },
    );
    expect(rejected.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const restored = await gql(
      app,
      `mutation($id: ID!) { labelUnarchive(id: $id) { label { archivedAt } } }`,
      { id: labelId },
    );
    expect(restored.errors).toBeUndefined();
    expect(restored.data!.labelUnarchive.label.archivedAt).toBeNull();
  });

  it("merge reemplaza referencias y conserva la actividad histórica", async () => {
    const source = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { name: "PRB merge source", teamId: $teamId }) { label { id } } }`,
      { teamId },
    );
    const target = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { name: "PRB merge target", teamId: $teamId }) { label { id } } }`,
      { teamId },
    );
    const issue = await gql(
      app,
      `mutation($label: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Merge source issue", labelIds: [$label] }) {
          issue { id }
        }
      }`,
      { label: source.data!.labelCreate.label.id },
    );
    const merged = await gql(
      app,
      `mutation($source: ID!, $target: ID!) {
        labelMerge(sourceId: $source, targetId: $target) {
          source { id archivedAt mergedIntoId }
          target { id }
          affectedIssues
        }
      }`,
      { source: source.data!.labelCreate.label.id, target: target.data!.labelCreate.label.id },
    );
    expect(merged.errors).toBeUndefined();
    expect(merged.data!.labelMerge).toMatchObject({
      affectedIssues: 1,
      source: {
        id: source.data!.labelCreate.label.id,
        mergedIntoId: target.data!.labelCreate.label.id,
      },
      target: { id: target.data!.labelCreate.label.id },
    });
    const after = await gql(
      app,
      `query($id: ID!) { issue(id: $id) { labels { id } activity { type actor { name } payload } } }`,
      { id: issue.data!.issueCreate.issue.id },
    );
    expect(after.data!.issue.labels).toEqual([{ id: target.data!.labelCreate.label.id }]);
    expect(after.data!.issue.activity).toContainEqual({
      type: "unlabeled",
      actor: { name: "admin" },
      payload: {
        label: "PRB merge source",
        reason: "label_merged",
        target: "PRB merge target",
      },
    });
    const unarchived = await gql(
      app,
      `mutation($id: ID!) { labelUnarchive(id: $id) { success } }`,
      { id: source.data!.labelCreate.label.id },
    );
    expect(unarchived.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const reassigned = await gql(
      app,
      `mutation($id: ID!, $label: ID!) {
        issueUpdate(id: $id, input: { addLabelIds: [$label] }) { success }
      }`,
      { id: issue.data!.issueCreate.issue.id, label: source.data!.labelCreate.label.id },
    );
    expect(reassigned.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("rechaza mover una label a un grupo cuando sus issues ya tienen otra hija", async () => {
    const group = await gql(
      app,
      `mutation($teamId: ID!) {
        labelCreate(input: { name: "PRB move group", teamId: $teamId, isGroup: true }) {
          label { id }
        }
      }`,
      { teamId },
    );
    const existing = await gql(
      app,
      `mutation($teamId: ID!, $groupId: ID!) {
        labelCreate(input: { name: "PRB existing child", teamId: $teamId, groupId: $groupId }) {
          label { id }
        }
      }`,
      { teamId, groupId: group.data!.labelCreate.label.id },
    );
    const candidate = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { name: "PRB candidate", teamId: $teamId }) { label { id groupId } } }`,
      { teamId },
    );
    const existingIssue = await gql(
      app,
      `mutation($existing: ID!, $candidate: ID!) {
        issueCreate(input: {
          teamKey: "PB"
          title: "Existing group child"
          labelIds: [$existing, $candidate]
        }) { issue { id } }
      }`,
      {
        existing: existing.data!.labelCreate.label.id,
        candidate: candidate.data!.labelCreate.label.id,
      },
    );
    const moved = await gql(
      app,
      `mutation($id: ID!, $groupId: ID!) {
        labelUpdate(id: $id, input: { groupId: $groupId }) { success label { groupId } }
      }`,
      { id: candidate.data!.labelCreate.label.id, groupId: group.data!.labelCreate.label.id },
    );
    expect(moved.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const unchanged = await gql(app, `query { labels(includeArchived: true) { id groupId } }`);
    expect(
      unchanged.data!.labels.find(
        (label: { id: string }) => label.id === candidate.data!.labelCreate.label.id,
      ).groupId,
    ).toBeNull();
  });

  it("rechaza mergear una label si el issue ya tiene otra hija del grupo destino", async () => {
    const group = await gql(
      app,
      `mutation($teamId: ID!) {
        labelCreate(input: { name: "PRB merge group", teamId: $teamId, isGroup: true }) {
          label { id }
        }
      }`,
      { teamId },
    );
    const existing = await gql(
      app,
      `mutation($teamId: ID!, $groupId: ID!) {
        labelCreate(input: { name: "PRB merge existing", teamId: $teamId, groupId: $groupId }) {
          label { id }
        }
      }`,
      { teamId, groupId: group.data!.labelCreate.label.id },
    );
    const target = await gql(
      app,
      `mutation($teamId: ID!, $groupId: ID!) {
        labelCreate(input: { name: "PRB merge target child", teamId: $teamId, groupId: $groupId }) {
          label { id }
        }
      }`,
      { teamId, groupId: group.data!.labelCreate.label.id },
    );
    const source = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { name: "PRB merge conflict source", teamId: $teamId }) { label { id } } }`,
      { teamId },
    );
    const issue = await gql(
      app,
      `mutation($existing: ID!, $source: ID!) {
        issueCreate(input: { teamKey: "PB", title: "Merge group conflict", labelIds: [$existing, $source] }) {
          issue { id labels { id } }
        }
      }`,
      { existing: existing.data!.labelCreate.label.id, source: source.data!.labelCreate.label.id },
    );
    expect(issue.errors).toBeUndefined();
    const merged = await gql(
      app,
      `mutation($source: ID!, $target: ID!) {
        labelMerge(sourceId: $source, targetId: $target) { success }
      }`,
      { source: source.data!.labelCreate.label.id, target: target.data!.labelCreate.label.id },
    );
    expect(merged.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const unchanged = await gql(app, `query($id: ID!) { issue(id: $id) { labels { id } } }`, {
      id: issue.data!.issueCreate.issue.id,
    });
    expect(unchanged.data!.issue.labels.map((label: { id: string }) => label.id).sort()).toEqual(
      [existing.data!.labelCreate.label.id, source.data!.labelCreate.label.id].sort(),
    );
  });

  it("no permite que una API key limitada convierta una label de Team en global", async () => {
    const adminId = (
      app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }
    ).id;
    const keyResult = await gql(
      app,
      `mutation($actorId: ID!, $teamId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "limited label admin", scopes: [ADMIN], teamIds: [$teamId] }) { key }
      }`,
      { actorId: adminId, teamId },
    );
    expect(keyResult.errors).toBeUndefined();
    const label = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { name: "PRB limited team label", teamId: $teamId }) { label { id } } }`,
      { teamId },
    );
    const update = await gql(
      app,
      `mutation($id: ID!) { labelUpdate(id: $id, input: { teamId: null }) { success } }`,
      { id: label.data!.labelCreate.label.id },
      keyResult.data!.apiKeyCreate.key,
    );
    expect(update.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });
});
