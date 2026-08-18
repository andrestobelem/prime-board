// PRB-372: archivado reversible de Teams sin perder identidad ni recursos.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql } from "../test-helpers.ts";
import { openDatabase } from "../db/database.ts";
import { exportBoard } from "../export/exporter.ts";
import { rebuildFromRepo } from "../export/importer.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("team archive", () => {
  it("excluye el Team archivado de la operación normal y permite restaurarlo", async () => {
    const created = await gql(
      app,
      `mutation {
        teamCreate(input: { name: "Archived history", key: "AR" }) {
          team { id key states { id name } }
        }
      }`,
    );
    expect(created.errors).toBeUndefined();
    const team = created.data!.teamCreate.team;
    const initialStateId = team.states[0].id as string;
    const issueCreated = await gql(
      app,
      `mutation($teamId: ID!) { issueCreate(input: { teamId: $teamId, title: "Retained issue" }) { issue { id identifier } } }`,
      { teamId: team.id },
    );
    expect(issueCreated.errors).toBeUndefined();
    const issueId = issueCreated.data!.issueCreate.issue.id as string;
    const labelCreated = await gql(
      app,
      `mutation($teamId: ID!) { labelCreate(input: { teamId: $teamId, name: "Retained label" }) { label { id } } }`,
      { teamId: team.id },
    );
    expect(labelCreated.errors).toBeUndefined();
    const labelId = labelCreated.data!.labelCreate.label.id as string;
    const cycleCreated = await gql(
      app,
      `mutation($teamId: ID!) {
        cycleCreate(input: { teamId: $teamId, name: "Retained cycle", startsAt: "2030-01-01", endsAt: "2030-01-14" }) { cycle { id } }
      }`,
      { teamId: team.id },
    );
    expect(cycleCreated.errors).toBeUndefined();
    const cycleId = cycleCreated.data!.cycleCreate.cycle.id as string;

    const archived = await gql(
      app,
      `mutation($id: ID!) { teamArchive(id: $id) { success team { id key archivedAt } } }`,
      { id: team.id },
    );
    expect(archived.errors).toBeUndefined();
    const archivedAt = archived.data!.teamArchive.team.archivedAt as string;
    expect(archived.data!.teamArchive.team).toMatchObject({ id: team.id, key: "AR" });
    expect(archivedAt).toBeTruthy();

    const hidden = await gql(app, `{ teams { key } team(key: "AR") { id } }`);
    expect(hidden.errors).toBeUndefined();
    expect(hidden.data!.teams.map((item: { key: string }) => item.key)).not.toContain("AR");
    expect(hidden.data!.team).toBeNull();

    const history = await gql(
      app,
      `query($teamId: ID!) {
        teams(includeArchived: true) { id key archivedAt }
        team(id: $teamId, includeArchived: true) {
          id key archivedAt
          states { id }
          labels { id }
          cycles { id }
        }
        issues(filter: { team: { eq: $teamId } }) { nodes { id } }
        archivedIssues: issues(filter: { team: { eq: $teamId }, includeArchived: true }) {
          nodes { id identifier }
        }
      }`,
      { teamId: team.id },
    );
    expect(history.errors).toBeUndefined();
    expect(history.data!.teams).toContainEqual(
      expect.objectContaining({ id: team.id, key: "AR", archivedAt }),
    );
    expect(history.data!.team).toMatchObject({
      id: team.id,
      key: "AR",
      archivedAt,
      states: expect.arrayContaining([{ id: initialStateId }]),
      labels: expect.arrayContaining([{ id: labelId }]),
      cycles: expect.arrayContaining([{ id: cycleId }]),
    });
    expect(history.data!.issues.nodes).toEqual([]);
    expect(history.data!.archivedIssues.nodes).toEqual([{ id: issueId, identifier: "AR-1" }]);

    const archivedMutation = await gql(
      app,
      `mutation($teamId: ID!, $issueId: ID!) {
        teamUpdate(id: $teamId, input: { name: "Should fail" }) { success }
        issueCreate(input: { teamId: $teamId, title: "Should fail" }) { success }
        issueUpdate(id: $issueId, input: { title: "Should fail" }) { success }
        workflowStateCreate(input: { teamId: $teamId, name: "Should fail", type: UNSTARTED }) { success }
        labelCreate(input: { teamId: $teamId, name: "Should fail" }) { success }
        cycleCreate(input: { teamId: $teamId, name: "Should fail", startsAt: "2030-02-01", endsAt: "2030-02-14" }) { success }
      }`,
      { teamId: team.id, issueId },
    );
    expect(archivedMutation.errors).toBeDefined();
    expect(
      archivedMutation.errors!.every((error) => error.extensions?.code === "VALIDATION_FAILED"),
    ).toBe(true);

    const archivedAgain = await gql(
      app,
      `mutation($id: ID!) { teamArchive(id: $id) { team { archivedAt } } }`,
      { id: team.id },
    );
    expect(archivedAgain.errors).toBeUndefined();
    expect(archivedAgain.data!.teamArchive.team.archivedAt).toBe(archivedAt);

    const restored = await gql(
      app,
      `mutation($id: ID!) { teamUnarchive(id: $id) { success team { id key archivedAt } } }`,
      { id: team.id },
    );
    expect(restored.errors).toBeUndefined();
    expect(restored.data!.teamUnarchive.team).toEqual({ id: team.id, key: "AR", archivedAt: null });

    const visible = await gql(app, `{ team(key: "AR") { id key archivedAt } }`);
    expect(visible.data!.team).toEqual({ id: team.id, key: "AR", archivedAt: null });
    const newIssue = await gql(
      app,
      `mutation($teamId: ID!) { issueCreate(input: { teamId: $teamId, title: "After restore" }) { issue { identifier } } }`,
      { teamId: team.id },
    );
    expect(newIssue.errors).toBeUndefined();
    expect(newIssue.data!.issueCreate.issue.identifier).toBe("AR-2");
  });

  it("preserva el archivado al exportar y reconstruir la Repository Replica", async () => {
    const created = await gql(
      app,
      `mutation {
        teamCreate(input: { name: "Replica archive", key: "EX" }) { team { id } }
      }`,
    );
    const teamId = created.data!.teamCreate.team.id as string;
    const issue = await gql(
      app,
      `mutation($teamId: ID!) { issueCreate(input: { teamId: $teamId, title: "Replica issue" }) { issue { identifier } } }`,
      { teamId },
    );
    expect(issue.errors).toBeUndefined();
    const archive = await gql(app, `mutation($id: ID!) { teamArchive(id: $id) { success } }`, {
      id: teamId,
    });
    expect(archive.errors).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), "pb-team-archive-"));
    const rebuilt = openDatabase(":memory:");
    try {
      exportBoard(app.db, root);
      const teams = JSON.parse(
        readFileSync(join(root, ".prime-board", "meta", "teams.json"), "utf8"),
      ) as Array<{ key: string; archived?: boolean }>;
      expect(teams.find((team) => team.key === "EX")?.archived).toBe(true);
      rebuildFromRepo(rebuilt, root);
      const row = rebuilt.query("SELECT archived_at FROM teams WHERE key = 'EX'").get() as {
        archived_at: string | null;
      };
      expect(row.archived_at).not.toBeNull();
      const exportedIssue = rebuilt
        .query("SELECT number FROM issues WHERE team_id = (SELECT id FROM teams WHERE key = 'EX')")
        .get() as { number: number };
      expect(exportedIssue.number).toBe(1);
    } finally {
      rebuilt.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("solo un Workspace Admin puede archivar y restaurar Teams", async () => {
    const created = await gql(
      app,
      `mutation { teamCreate(input: { name: "Authorization archive", key: "AA" }) { team { id } } }`,
    );
    const teamId = created.data!.teamCreate.team.id as string;
    const actor = await gql(
      app,
      `mutation { actorCreate(input: { name: "archive-member", type: AGENT }) { actor { id } } }`,
    );
    const actorId = actor.data!.actorCreate.actor.id as string;
    const keyResult = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "archive member key" }) { key } }`,
      { actorId },
    );
    const memberKey = keyResult.data!.apiKeyCreate.key as string;

    const deniedArchive = await gql(
      app,
      `mutation($id: ID!) { teamArchive(id: $id) { success } }`,
      { id: teamId },
      memberKey,
    );
    expect(deniedArchive.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const archived = await gql(app, `mutation($id: ID!) { teamArchive(id: $id) { success } }`, {
      id: teamId,
    });
    expect(archived.errors).toBeUndefined();
    const deniedRestore = await gql(
      app,
      `mutation($id: ID!) { teamUnarchive(id: $id) { success } }`,
      { id: teamId },
      memberKey,
    );
    expect(deniedRestore.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });
});
