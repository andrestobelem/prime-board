import { afterEach, describe, expect, it } from "bun:test";
import { createApiKey, rotateApiKey } from "../domain/actors.ts";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp | null = null;
afterEach(() => app?.stop());

describe("API key scopes and lifecycle", () => {
  it("intersects scope hierarchy and blocks a read-only key from minting", async () => {
    app = createTestApp();
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "reader", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id;
    const pbId = (app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as { id: string }).id;
    const created = await gql(
      app,
      `mutation($id: ID!, $team: ID!) {
      apiKeyCreate(input: { actorId: $id, name: "reader", scopes: [READ], teamIds: [$team] }) { key apiKey { id scopes teamIds } }
    }`,
      { id: actorId, team: pbId },
    );
    const key = created.data!.apiKeyCreate.key;
    expect(created.data!.apiKeyCreate.apiKey.scopes).toEqual(["READ"]);
    await gql(
      app,
      `mutation { teamCreate(input: { key: "SEC", name: "Security" }) { team { id } } }`,
    );
    const read = await gql(app, `{ teams { key } }`, {}, key);
    expect(read.data!.teams.map((team: { key: string }) => team.key)).toEqual(["PB"]);
    const foreignTeam = await gql(app, `{ team(key: "SEC") { id } }`, {}, key);
    expect(foreignTeam.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const write = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "blocked" }) { success } }`,
      {},
      key,
    );
    expect(write.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const mint = await gql(
      app,
      `mutation { apiKeyCreate(input: { actorId: "${actorId}", name: "escalation" }) { key } }`,
      {},
      key,
    );
    expect(mint.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const deletion = await gql(
      app,
      `mutation($id: ID!) { teamDelete(id: $id, confirmation: "PB") { success } }`,
      { id: pbId },
    );
    expect(deletion.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(deletion.errors?.[0]?.message).toContain("API key allowlists");
  });

  it("rejects expired credentials before last-used bookkeeping", async () => {
    app = createTestApp();
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "expiring", type: AGENT }) { actor { id } } }`,
    );
    const id = actor.data!.actorCreate.actor.id;
    const created = await gql(
      app,
      `mutation($id: ID!) { apiKeyCreate(input: { actorId: $id, name: "expires", expiresAt: "2099-01-01T00:00:00.000Z" }) { key apiKey { id } } }`,
      { id },
    );
    const keyId = created.data!.apiKeyCreate.apiKey.id;
    const key = created.data!.apiKeyCreate.key;
    app.db
      .query("UPDATE api_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1")
      .run(keyId);
    const rejected = await gql(app, `{ viewer { id } }`, {}, key);
    expect(rejected.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(
      (
        app.db.query("SELECT last_used_at FROM api_keys WHERE id = ?1").get(keyId) as {
          last_used_at: string | null;
        }
      ).last_used_at,
    ).toBeNull();
  });

  it("rotates atomically and revokes the old bearer", async () => {
    app = createTestApp();
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "rotator", type: AGENT }) { actor { id } } }`,
    );
    const id = actor.data!.actorCreate.actor.id;
    const teamId = (app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as { id: string })
      .id;
    const created = await gql(
      app,
      `mutation($id: ID!, $team: ID!) { apiKeyCreate(input: { actorId: $id, name: "old", scopes: [WRITE], teamIds: [$team] }) { key apiKey { id } } }`,
      { id, team: teamId },
    );
    const oldKey = created.data!.apiKeyCreate.key;
    const oldId = created.data!.apiKeyCreate.apiKey.id;
    const rotated = await gql(
      app,
      `mutation($id: ID!) { apiKeyRotate(id: $id, input: { name: "new", scopes: [READ] }) { key apiKey { id revokedAt rotatedFromId scopes teamIds } } }`,
      { id: oldId },
    );
    expect(rotated.data!.apiKeyRotate.apiKey.rotatedFromId).toBe(oldId);
    expect(rotated.data!.apiKeyRotate.apiKey.scopes).toEqual(["READ"]);
    expect(rotated.data!.apiKeyRotate.apiKey.teamIds).toEqual([teamId]);
    const rejected = await gql(app, `{ viewer { id } }`, {}, oldKey);
    expect(rejected.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const accepted = await gql(app, `{ teams { key } }`, {}, rotated.data!.apiKeyRotate.key);
    expect(accepted.data!.teams.map((team: { key: string }) => team.key)).toEqual(["PB"]);
  });
  it("scopes created and rotated keys to the active Workspace", async () => {
    app = createTestApp();
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "workspace-key", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id;
    const currentWorkspace = app.db
      .query("SELECT id FROM workspace ORDER BY created_at, id LIMIT 1")
      .get() as { id: string };
    const currentTeam = app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as {
      id: string;
    };
    const otherWorkspaceId = "workspace-api-key-other";
    const otherTeamId = "team-api-key-other";
    app.db
      .query(
        "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES (?1, 'Other', 'other-api-key', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')",
      )
      .run(otherWorkspaceId);
    app.db
      .query(
        `INSERT INTO teams
         (id, name, key, next_issue_number, created_at, updated_at, default_state_id,
          archived_at, visibility, access_policy, workspace_id)
         VALUES (?1, 'Other team', 'PB', 1, '2099-01-01T00:00:00.000Z',
                 '2099-01-01T00:00:00.000Z', NULL, NULL, 'public', 'team_members', ?2)`,
      )
      .run(otherTeamId, otherWorkspaceId);

    const created = createApiKey(app.db, {
      actorId,
      name: "current",
      teamIds: [currentTeam.id],
      workspaceId: currentWorkspace.id,
    });
    const oldId = created.row.id;
    expect(
      app.db.query("SELECT workspace_id FROM api_key_team_limits WHERE api_key_id = ?1").get(oldId),
    ).toEqual({ workspace_id: currentWorkspace.id });
    expect(
      app.db
        .query("SELECT workspace_id, is_default FROM api_key_workspaces WHERE api_key_id = ?1")
        .get(oldId),
    ).toEqual({ workspace_id: currentWorkspace.id, is_default: 1 });

    expect(() =>
      createApiKey(app!.db, {
        actorId,
        name: "foreign",
        teamIds: [otherTeamId],
        workspaceId: currentWorkspace.id,
      }),
    ).toThrow("Team not found");
    expect(
      app.db.query("SELECT count(*) AS count FROM api_keys WHERE name = 'foreign'").get(),
    ).toEqual({ count: 0 });

    expect(() =>
      rotateApiKey(app!.db, oldId, {
        name: "foreign-rotation",
        teamIds: [otherTeamId],
        workspaceId: currentWorkspace.id,
      }),
    ).toThrow("Team not found");
    expect(app.db.query("SELECT revoked_at FROM api_keys WHERE id = ?1").get(oldId)).toEqual({
      revoked_at: null,
    });
    expect(
      app.db.query("SELECT count(*) AS count FROM api_keys WHERE name = 'foreign-rotation'").get(),
    ).toEqual({ count: 0 });

    const rotated = rotateApiKey(app.db, oldId, {
      name: "rotated",
      teamIds: [currentTeam.id],
      workspaceId: currentWorkspace.id,
    });
    const rotatedId = rotated.row.id;
    expect(rotated.row.rotated_from_id).toBe(oldId);
    expect(
      app.db
        .query("SELECT workspace_id FROM api_key_team_limits WHERE api_key_id = ?1")
        .get(rotatedId),
    ).toEqual({ workspace_id: currentWorkspace.id });
    expect(
      app.db
        .query("SELECT workspace_id, is_default FROM api_key_workspaces WHERE api_key_id = ?1")
        .get(rotatedId),
    ).toEqual({ workspace_id: currentWorkspace.id, is_default: 1 });
  });

  it("does not leak multi-Team resources or Workspace collections through a limited key", async () => {
    app = createTestApp();
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "limited-reader", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id;
    const pbId = (app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as { id: string }).id;
    const security = await gql(
      app,
      `mutation { teamCreate(input: { key: "SEC", name: "Security" }) { team { id } } }`,
    );
    const secId = security.data!.teamCreate.team.id;
    const project = await gql(
      app,
      `mutation($teams: [ID!]!) { projectCreate(input: { name: "cross-team", teamIds: $teams }) { project { id } } }`,
      { teams: [pbId, secId] },
    );
    const projectId = project.data!.projectCreate.project.id;
    const pbIssue = await gql(
      app,
      `mutation($project: ID!) { issueCreate(input: { teamKey: "PB", projectId: $project, title: "PB issue" }) { issue { id } } }`,
      { project: projectId },
    );
    const secIssue = await gql(
      app,
      `mutation { issueCreate(input: { teamId: "${secId}", title: "SEC issue" }) { issue { id } } }`,
    );
    const pbIssueId = pbIssue.data!.issueCreate.issue.id;
    const secIssueId = secIssue.data!.issueCreate.issue.id;
    await gql(
      app,
      `mutation($a: ID!, $b: ID!) { issueRelationCreate(input: { issueId: $a, relatedIssueId: $b, type: RELATED }) { success } }`,
      { a: pbIssueId, b: secIssueId },
    );
    const limited = await gql(
      app,
      `mutation($id: ID!, $team: ID!) { apiKeyCreate(input: { actorId: $id, name: "limited", scopes: [READ], teamIds: [$team] }) { key } }`,
      { id: actorId, team: pbId },
    );
    const limitedKey = limited.data!.apiKeyCreate.key;
    const secCycle = await gql(
      app,
      `mutation($team: ID!) { cycleCreate(input: { teamId: $team, name: "SEC cycle", startsAt: "2025-01-01T00:00:00.000Z", endsAt: "2025-02-01T00:00:00.000Z" }) { cycle { id } } }`,
      { team: secId },
    );
    const secLabel = await gql(
      app,
      `mutation($team: ID!) { labelCreate(input: { name: "SEC label", teamId: $team }) { label { id } } }`,
      { team: secId },
    );
    const workspaceLabel = await gql(
      app,
      `mutation { labelCreate(input: { name: "Workspace label" }) { label { id } } }`,
    );
    app.db
      .query("UPDATE issues SET parent_id = ?1, cycle_id = ?2 WHERE id = ?3")
      .run(secIssueId, secCycle.data!.cycleCreate.cycle.id, pbIssueId);
    app.db.query("UPDATE issues SET parent_id = ?1 WHERE id = ?2").run(pbIssueId, secIssueId);
    app.db
      .query("INSERT INTO issue_labels (issue_id, label_id) VALUES (?1, ?2), (?1, ?3)")
      .run(
        pbIssueId,
        secLabel.data!.labelCreate.label.id,
        workspaceLabel.data!.labelCreate.label.id,
      );
    const nested = await gql(
      app,
      `{ team(key: "PB") { projects { id teams { key } } } issue(id: "PB-1") { project { id } relations { relatedIssue { identifier } } activity { type payload } } }`,
      {},
      limitedKey,
    );
    expect(nested.data!.team.projects).toEqual([]);
    expect(nested.data!.issue.project).toBeNull();
    expect(nested.data!.issue.relations).toEqual([]);
    const relationActivity = nested.data!.issue.activity.find(
      (activity: { type: string }) => activity.type === "relation_added",
    );
    expect(relationActivity?.payload?.issue).toBeUndefined();
    expect(JSON.stringify(nested.data!.issue.activity)).not.toContain("SEC-");
    const crossNested = await gql(
      app,
      `query($id: ID!) { issue(id: $id) { parent { identifier } children { identifier } cycle { id } labels { name teamId } } }`,
      { id: pbIssueId },
      limitedKey,
    );
    expect(crossNested.data!.issue.parent).toBeNull();
    expect(crossNested.data!.issue.children).toEqual([]);
    expect(crossNested.data!.issue.cycle).toBeNull();
    expect(crossNested.data!.issue.labels).toEqual([{ name: "Workspace label", teamId: null }]);
    for (const query of [
      `{ initiatives { id } }`,
      `{ savedViews { id } }`,
      `{ favorites { id } }`,
      `{ inbox { issue { id } } }`,
      `{ webhooks { id } }`,
      `{ labels { id } }`,
    ]) {
      const denied = await gql(app, query, {}, limitedKey);
      expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    }
    const writeKeyResult = await gql(
      app,
      `mutation($id: ID!, $team: ID!) { apiKeyCreate(input: { actorId: $id, name: "writer", scopes: [WRITE], teamIds: [$team] }) { key } }`,
      { id: actorId, team: pbId },
    );
    const thirdPartyUpdate = await gql(
      app,
      `mutation { actorUpdate(id: "${(app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string }).id}", input: { name: "hijack" }) { success } }`,
      {},
      writeKeyResult.data!.apiKeyCreate.key,
    );
    expect(thirdPartyUpdate.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const adminScope = await gql(
      app,
      `mutation($id: ID!, $team: ID!) { apiKeyCreate(input: { actorId: $id, name: "admin-scope", scopes: [ADMIN], teamIds: [$team] }) { key } }`,
      { id: actorId, team: pbId },
    );
    const globalLabel = await gql(
      app,
      `mutation { labelCreate(input: { name: "global" }) { success } }`,
      {},
      adminScope.data!.apiKeyCreate.key,
    );
    expect(globalLabel.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("rechaza una mutación escalar fuera del límite de la API key", async () => {
    app = createTestApp();
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "limited-owner", type: AGENT }) { actor { id } } }`,
    );
    expect(actor.errors).toBeUndefined();
    const actorId = actor.data!.actorCreate.actor.id as string;
    const team = await gql(
      app,
      `mutation { teamCreate(input: { key: "SEC", name: "Security" }) { team { id } } }`,
    );
    expect(team.errors).toBeUndefined();
    const teamId = team.data!.teamCreate.team.id as string;
    const membership = await gql(
      app,
      `mutation($teamId: ID!, $actorId: ID!) {
        teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: OWNER }) { success }
      }`,
      { teamId, actorId },
    );
    expect(membership.errors).toBeUndefined();
    const primaryTeamId = (
      app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as {
        id: string;
      }
    ).id;
    const limited = await gql(
      app,
      `mutation($actorId: ID!, $teamId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "limited-owner-key", scopes: [WRITE], teamIds: [$teamId] }) { key }
      }`,
      { actorId, teamId: primaryTeamId },
    );
    expect(limited.errors).toBeUndefined();
    const denied = await gql(
      app,
      `mutation($id: ID!) { teamUpdate(id: $id, input: { description: "must remain unchanged" }) { success } }`,
      { id: teamId },
      limited.data!.apiKeyCreate.key as string,
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(
      (
        app.db.query("SELECT description FROM teams WHERE id = ?1").get(teamId) as {
          description: string | null;
        }
      ).description,
    ).toBeNull();
  });

  it("rechaza las referencias escalares y de lista fuera del límite", async () => {
    app = createTestApp();
    const owner = await gql(
      app,
      `mutation { actorCreate(input: { name: "limited-owner-list", type: AGENT }) { actor { id } } }`,
    );
    const ownerId = owner.data!.actorCreate.actor.id as string;
    const target = await gql(
      app,
      `mutation { actorCreate(input: { name: "limited-target-list", type: AGENT }) { actor { id } } }`,
    );
    const targetId = target.data!.actorCreate.actor.id as string;
    const team = await gql(
      app,
      `mutation { teamCreate(input: { key: "SEC", name: "Security list" }) { team { id } } }`,
    );
    const teamId = team.data!.teamCreate.team.id as string;
    const ownerMembership = await gql(
      app,
      `mutation($teamId: ID!, $actorId: ID!) {
        teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: OWNER }) { success }
      }`,
      { teamId, actorId: ownerId },
    );
    expect(ownerMembership.errors).toBeUndefined();
    const primaryTeamId = (
      app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as {
        id: string;
      }
    ).id;
    const limited = await gql(
      app,
      `mutation($actorId: ID!, $teamId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "limited-owner-list-key", scopes: [WRITE], teamIds: [$teamId] }) { key }
      }`,
      { actorId: ownerId, teamId: primaryTeamId },
    );
    const limitedKey = limited.data!.apiKeyCreate.key as string;

    const membership = await gql(
      app,
      `mutation($teamId: ID!, $actorId: ID!) {
        teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) { success }
      }`,
      { teamId, actorId: targetId },
      limitedKey,
    );
    expect(membership.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(
      app.db
        .query(
          "SELECT count(*) AS count FROM team_memberships WHERE team_id = ?1 AND actor_id = ?2",
        )
        .get(teamId, targetId),
    ).toEqual({ count: 0 });

    const state = await gql(
      app,
      `mutation($teamId: ID!) {
        workflowStateCreate(input: { teamId: $teamId, name: "Blocked state", type: UNSTARTED }) { success }
      }`,
      { teamId },
      limitedKey,
    );
    expect(state.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(
      app.db
        .query("SELECT count(*) AS count FROM workflow_states WHERE team_id = ?1 AND name = ?2")
        .get(teamId, "Blocked state"),
    ).toEqual({ count: 0 });

    const project = await gql(
      app,
      `mutation($teamIds: [ID!]) {
        projectCreate(input: { name: "Blocked list project", teamIds: $teamIds }) { success }
      }`,
      { teamIds: [teamId] },
      limitedKey,
    );
    expect(project.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(
      app.db
        .query("SELECT count(*) AS count FROM projects WHERE name = ?1")
        .get("Blocked list project"),
    ).toEqual({ count: 0 });
  });

  it("conserva los errores de dominio para listas vacías scoped", async () => {
    app = createTestApp();
    const actorId = (
      app.db
        .query("SELECT id FROM actors WHERE workspace_role = 'admin' ORDER BY created_at LIMIT 1")
        .get() as {
        id: string;
      }
    ).id;
    const teamId = (app.db.query("SELECT id FROM teams WHERE key = 'PB'").get() as { id: string })
      .id;
    const keyResult = await gql(
      app,
      `mutation($actorId: ID!, $teamId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "empty-list-key", scopes: [WRITE], teamIds: [$teamId] }) { key }
      }`,
      { actorId, teamId },
    );
    const key = keyResult.data!.apiKeyCreate.key as string;

    const project = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "empty-list-project", teamIds: [$teamId] }) { project { id } } }`,
      { teamId },
    );
    const projectId = project.data!.projectCreate.project.id as string;
    const foreignTeam = await gql(
      app,
      `mutation { teamCreate(input: { key: "OTHER", name: "Other empty-list Team" }) { team { id } } }`,
    );
    const foreignTeamId = foreignTeam.data!.teamCreate.team.id as string;
    const foreignProject = await gql(
      app,
      `mutation($teamId: ID!) { projectCreate(input: { name: "other-empty-list-project", teamIds: [$teamId] }) { project { id } } }`,
      { teamId: foreignTeamId },
    );
    const foreignProjectId = foreignProject.data!.projectCreate.project.id as string;

    const projectOnlyInitiative = await gql(
      app,
      `mutation($projectId: ID!) { initiativeCreate(input: { name: "project-only-empty-team-initiative", projectIds: [$projectId], teamIds: [] }) { initiative { id } } }`,
      { projectId },
      key,
    );
    expect(projectOnlyInitiative.errors).toBeUndefined();
    const projectOnlyInitiativeId = projectOnlyInitiative.data!.initiativeCreate.initiative
      .id as string;

    const projectOnlyRescope = await gql(
      app,
      `mutation($id: ID!, $projectId: ID!) { initiativeUpdate(id: $id, input: { projectIds: [$projectId], teamIds: [] }) { success } }`,
      { id: projectOnlyInitiativeId, projectId },
      key,
    );
    expect(projectOnlyRescope.errors).toBeUndefined();

    const projectOnlyClear = await gql(
      app,
      `mutation($id: ID!) { initiativeUpdate(id: $id, input: { projectIds: [] }) { success } }`,
      { id: projectOnlyInitiativeId },
      key,
    );
    expect(projectOnlyClear.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const missingProject = await gql(
      app,
      `mutation { initiativeCreate(input: { name: "missing-project-initiative", projectIds: ["missing-project"], teamIds: [] }) { success } }`,
      {},
      key,
    );
    expect(missingProject.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const missingTeam = await gql(
      app,
      `mutation { initiativeCreate(input: { name: "missing-team-initiative", teamIds: ["missing-team"] }) { success } }`,
      {},
      key,
    );
    expect(missingTeam.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const foreignTeamInitiative = await gql(
      app,
      `mutation($teamId: ID!) { initiativeCreate(input: { name: "foreign-team-initiative", teamIds: [$teamId] }) { success } }`,
      { teamId: foreignTeamId },
      key,
    );
    expect(foreignTeamInitiative.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const foreignProjectInitiative = await gql(
      app,
      `mutation($projectId: ID!) { initiativeCreate(input: { name: "foreign-project-initiative", projectIds: [$projectId], teamIds: [] }) { success } }`,
      { projectId: foreignProjectId },
      key,
    );
    expect(foreignProjectInitiative.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const mixedInitiative = await gql(
      app,
      `mutation($projectId: ID!, $teamId: ID!) { initiativeCreate(input: { name: "mixed-scope-initiative", projectIds: [$projectId], teamIds: [$teamId] }) { initiative { id } } }`,
      { projectId: foreignProjectId, teamId },
    );
    expect(mixedInitiative.errors).toBeUndefined();
    const mixedInitiativeId = mixedInitiative.data!.initiativeCreate.initiative.id as string;
    const mixedRescope = await gql(
      app,
      `mutation($id: ID!) { initiativeUpdate(id: $id, input: { projectIds: [] }) { success } }`,
      { id: mixedInitiativeId },
      key,
    );
    expect(mixedRescope.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    expect(
      app.db
        .query(
          "SELECT count(*) AS count FROM initiative_projects WHERE initiative_id = ?1 AND project_id = ?2",
        )
        .get(mixedInitiativeId, foreignProjectId),
    ).toEqual({ count: 1 });

    const missingInitiativeUpdate = await gql(
      app,
      `mutation { initiativeUpdate(id: "missing-initiative", input: { projectIds: [], teamIds: [] }) { success } }`,
      {},
      key,
    );
    expect(missingInitiativeUpdate.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const projectCreate = await gql(
      app,
      `mutation { projectCreate(input: { name: "invalid-empty-project", teamIds: [] }) { success } }`,
      {},
      key,
    );
    expect(projectCreate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const projectUpdate = await gql(
      app,
      `mutation($id: ID!) { projectUpdate(id: $id, input: { teamIds: [] }) { success } }`,
      { id: projectId },
      key,
    );
    expect(projectUpdate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const initiativeCreate = await gql(
      app,
      `mutation { initiativeCreate(input: { name: "empty-list-initiative", teamIds: [] }) { success } }`,
      {},
      key,
    );
    expect(initiativeCreate.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const initiative = await gql(
      app,
      `mutation($teamId: ID!) { initiativeCreate(input: { name: "scoped-empty-list-initiative", teamIds: [$teamId] }) { initiative { id } } }`,
      { teamId },
    );
    const initiativeId = initiative.data!.initiativeCreate.initiative.id as string;
    const initiativeUpdate = await gql(
      app,
      `mutation($id: ID!) { initiativeUpdate(id: $id, input: { teamIds: [] }) { success } }`,
      { id: initiativeId },
      key,
    );
    expect(initiativeUpdate.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });
});
