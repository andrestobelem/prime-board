// PRB-437: smoke de labels y relaciones contra PostgreSQL real.
import { afterAll, describe, expect, it } from "bun:test";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { migratePostgres } from "../db/postgres/migrator.ts";
import { newId, now } from "../db/util.ts";
import { createApp } from "../server.ts";
import type { Config } from "../config.ts";

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("PostgreSQL labels and relations", () => {
  let stop: (() => void) | undefined;
  let close: (() => Promise<void>) | undefined;

  afterAll(async () => {
    stop?.();
    await close?.();
  });

  integration("preserves label and relation semantics through GraphQL", async () => {
    const url = process.env.PRIME_BOARD_POSTGRES_URL!;
    const sql = new Bun.SQL(url);
    await migratePostgres(sql);
    const persistence = createPostgresPersistence(sql);
    const db = openDatabase(":memory:");
    const config = {
      port: 0,
      host: "127.0.0.1",
      authMode: "api-key",
      dbPath: ":memory:",
      postgresUrl: url,
      persistenceBackend: "postgres",
      dev: false,
      webDist: "/tmp/prime-board-no-web",
      repoRoot: null,
      bootstrap: resolveBootstrapIdentity({}),
    } as Config;
    await bootstrapPostgres(persistence, config.bootstrap);
    const admin = await persistence.one<{ id: string }>(
      "SELECT id FROM actors WHERE name = 'admin'",
    );
    const team = await persistence.one<{ id: string; key: string }>(
      "SELECT id, key FROM teams ORDER BY key LIMIT 1",
    );
    if (!admin || !team) throw new Error("PostgreSQL fixture is incomplete");
    const adminKey = generateApiKey();
    const adminKeyId = newId();
    const limitedKey = generateApiKey();
    const limitedKeyId = newId();
    const timestamp = now();
    await persistence.execute(
      "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ($1, $2, $3, $4, $5)",
      [adminKeyId, admin.id, "PRB-437 integration admin", hashApiKey(adminKey), timestamp],
    );
    for (const scope of ["read", "write", "admin"]) {
      await persistence.execute("INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, $2)", [
        adminKeyId,
        scope,
      ]);
    }
    await persistence.execute(
      "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ($1, $2, $3, $4, $5)",
      [limitedKeyId, admin.id, "PRB-437 integration limited", hashApiKey(limitedKey), timestamp],
    );
    for (const scope of ["read", "write"]) {
      await persistence.execute("INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, $2)", [
        limitedKeyId,
        scope,
      ]);
    }
    await persistence.execute(
      "INSERT INTO api_key_team_limits (api_key_id, team_id) VALUES ($1, $2)",
      [limitedKeyId, team.id],
    );

    const app = createApp({ db, config, persistence });
    stop = () => app.server.stop();
    close = async () => {
      db.close();
      await persistence.close();
    };
    const request = async (
      query: string,
      variables?: Record<string, unknown>,
      token = adminKey,
    ) => {
      const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
      });
      return (await response.json()) as {
        data?: Record<string, any>;
        errors?: Array<{ message: string; extensions?: { code?: string } }>;
      };
    };

    const globalLabel = await request(
      `mutation { labelCreate(input: { name: "PRB-437 global" }) { label { id teamId } } }`,
    );
    expect(globalLabel.errors).toBeUndefined();
    const globalLabelId = globalLabel.data!.labelCreate.label.id as string;
    const teamLabel = await request(
      `mutation($teamId: ID!) {
        labelCreate(input: { name: "PRB-437 team", teamId: $teamId }) { label { id teamId } }
      }`,
      { teamId: team.id },
    );
    expect(teamLabel.errors).toBeUndefined();
    const teamLabelId = teamLabel.data!.labelCreate.label.id as string;
    const otherTeam = await request(
      `mutation { teamCreate(input: { name: "PRB-437 other", key: "L437" }) { team { id } } }`,
    );
    expect(otherTeam.errors).toBeUndefined();
    const otherTeamId = otherTeam.data!.teamCreate.team.id as string;
    const foreignLabel = await request(
      `mutation($teamId: ID!) {
        labelCreate(input: { name: "PRB-437 foreign", teamId: $teamId }) { label { id } }
      }`,
      { teamId: otherTeamId },
    );
    expect(foreignLabel.errors).toBeUndefined();
    const foreignLabelId = foreignLabel.data!.labelCreate.label.id as string;

    const createIssue = async (title: string, labelIds?: string[]) => {
      const result = await request(
        `mutation($teamKey: String!, $title: String!, $labels: [ID!]) {
          issueCreate(input: { teamKey: $teamKey, title: $title, labelIds: $labels }) {
            issue { id identifier labels { id name } activity { type payload } }
          }
        }`,
        { teamKey: team.key, title, labels: labelIds },
      );
      expect(result.errors).toBeUndefined();
      return result.data!.issueCreate.issue as {
        id: string;
        identifier: string;
        labels: Array<{ id: string; name: string }>;
      };
    };
    const blocked = await createIssue("PRB-437 blocked", [globalLabelId, teamLabelId]);
    const blocker = await createIssue("PRB-437 blocker");
    const third = await createIssue("PRB-437 third");
    const foreignAssignment = await request(
      `mutation($id: ID!, $label: ID!) {
        issueUpdate(id: $id, input: { addLabelIds: [$label] }) { success }
      }`,
      { id: blocked.id, label: foreignLabelId },
    );
    expect(foreignAssignment.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const limitedTeamLabels = await request(
      `query($team: ID!) { labels(team: $team) { id } }`,
      { team: otherTeamId },
      limitedKey,
    );
    expect(limitedTeamLabels.errors).toBeUndefined();
    expect(limitedTeamLabels.data!.labels).toEqual([]);

    const labels = await request(`query($id: ID!) { issue(id: $id) { labels { name teamId } } }`, {
      id: blocked.id,
    });
    expect(labels.errors).toBeUndefined();
    expect(labels.data!.issue.labels.map((label: { name: string }) => label.name).sort()).toEqual([
      "PRB-437 global",
      "PRB-437 team",
    ]);

    const filtered = await request(
      `query($label: ID!) {
        issues(filter: { labels: { includes: $label } }) { nodes { identifier } }
      }`,
      { label: teamLabelId },
    );
    expect(filtered.errors).toBeUndefined();
    expect(filtered.data!.issues.nodes).toEqual([{ identifier: blocked.identifier }]);

    const created = await request(
      `mutation($issue: ID!, $related: ID!) {
        issueRelationCreate(input: { issueId: $issue, relatedIssueId: $related, type: BLOCKED_BY }) {
          relation { id type relatedIssue { identifier } }
        }
      }`,
      { issue: blocked.id, related: blocker.id },
    );
    expect(created.errors).toBeUndefined();
    expect(created.data!.issueRelationCreate.relation).toMatchObject({
      type: "BLOCKED_BY",
      relatedIssue: { identifier: blocker.identifier },
    });
    const relationId = created.data!.issueRelationCreate.relation.id as string;

    const bothEnds = await request(
      `query($blocked: ID!, $blocker: ID!) {
        blocked: issue(id: $blocked) { relations { type relatedIssue { identifier } } activity { type payload } }
        blocker: issue(id: $blocker) { relations { type relatedIssue { identifier } } activity { type payload } }
      }`,
      { blocked: blocked.id, blocker: blocker.id },
    );
    expect(bothEnds.errors).toBeUndefined();
    expect(bothEnds.data!.blocked.relations).toEqual([
      { type: "BLOCKED_BY", relatedIssue: { identifier: blocker.identifier } },
    ]);
    expect(bothEnds.data!.blocker.relations).toEqual([
      { type: "BLOCKS", relatedIssue: { identifier: blocked.identifier } },
    ]);
    expect(bothEnds.data!.blocked.activity).toContainEqual({
      type: "relation_added",
      payload: { type: "blocked_by", issue: blocker.identifier },
    });
    expect(bothEnds.data!.blocker.activity).toContainEqual({
      type: "relation_added",
      payload: { type: "blocks", issue: blocked.identifier },
    });

    const blockedFilter = await request(
      `query { issues(filter: { unblocked: false }) { nodes { identifier } } }`,
    );
    expect(blockedFilter.errors).toBeUndefined();
    expect(blockedFilter.data!.issues.nodes).toContainEqual({ identifier: blocked.identifier });

    const cycle = await request(
      `mutation($issue: ID!, $related: ID!) {
        issueRelationCreate(input: { issueId: $issue, relatedIssueId: $related, type: BLOCKED_BY }) {
          success
        }
      }`,
      { issue: blocker.id, related: blocked.id },
    );
    expect(cycle.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    expect(cycle.errors?.[0]?.message).toContain("cycle");

    const self = await request(
      `mutation($id: ID!) {
        issueRelationCreate(input: { issueId: $id, relatedIssueId: $id, type: RELATED }) { success }
      }`,
      { id: third.id },
    );
    expect(self.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");

    const related = await request(
      `mutation($issue: ID!, $related: ID!) {
        issueRelationCreate(input: { issueId: $issue, relatedIssueId: $related, type: RELATED }) {
          relation { id type relatedIssue { identifier } }
        }
      }`,
      { issue: blocker.id, related: third.id },
    );
    expect(related.errors).toBeUndefined();
    expect(related.data!.issueRelationCreate.relation).toMatchObject({
      type: "RELATED",
      relatedIssue: { identifier: third.identifier },
    });
    const relatedId = related.data!.issueRelationCreate.relation.id as string;
    const duplicate = await request(
      `mutation($issue: ID!, $related: ID!) {
        issueRelationCreate(input: { issueId: $issue, relatedIssueId: $related, type: DUPLICATE_OF }) {
          relation { id type relatedIssue { identifier } }
        }
      }`,
      { issue: third.id, related: blocker.id },
    );
    expect(duplicate.errors).toBeUndefined();
    expect(duplicate.data!.issueRelationCreate.relation).toMatchObject({
      type: "DUPLICATE_OF",
      relatedIssue: { identifier: blocker.identifier },
    });
    const duplicateId = duplicate.data!.issueRelationCreate.relation.id as string;
    const inverseRelations = await request(
      `query($id: ID!) { issue(id: $id) { relations { type relatedIssue { identifier } } } }`,
      { id: blocker.id },
    );
    expect(inverseRelations.data!.issue.relations).toHaveLength(3);
    expect(inverseRelations.data!.issue.relations).toContainEqual({
      type: "RELATED",
      relatedIssue: { identifier: third.identifier },
    });
    expect(inverseRelations.data!.issue.relations).toContainEqual({
      type: "DUPLICATED_BY",
      relatedIssue: { identifier: third.identifier },
    });
    expect(inverseRelations.data!.issue.relations).toContainEqual({
      type: "BLOCKS",
      relatedIssue: { identifier: blocked.identifier },
    });

    for (const extraId of [relatedId, duplicateId]) {
      const extraDelete = await request(
        `mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`,
        { id: extraId },
      );
      expect(extraDelete.errors).toBeUndefined();
    }
    const deleted = await request(
      `mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`,
      { id: relationId },
    );
    expect(deleted.errors).toBeUndefined();
    const afterDelete = await request(
      `query($id: ID!) { issue(id: $id) { relations { id } activity { type payload } } }`,
      { id: blocked.id },
    );
    expect(afterDelete.errors).toBeUndefined();
    expect(afterDelete.data!.issue.relations).toEqual([]);
    expect(afterDelete.data!.issue.activity).toContainEqual({
      type: "relation_removed",
      payload: { type: "blocked_by", issue: blocker.identifier },
    });

    const labelDeleted = await request(
      `mutation($id: ID!) { labelDelete(id: $id) { success affectedIssues } }`,
      { id: teamLabelId },
    );
    expect(labelDeleted.errors).toBeUndefined();
    expect(labelDeleted.data!.labelDelete).toEqual({ success: true, affectedIssues: 1 });
    const afterLabelDelete = await request(
      `query($id: ID!) { issue(id: $id) { labels { id } activity { type payload } } }`,
      { id: blocked.id },
    );
    expect(afterLabelDelete.errors).toBeUndefined();
    expect(afterLabelDelete.data!.issue.labels).toEqual([{ id: globalLabelId }]);
    expect(afterLabelDelete.data!.issue.activity).toContainEqual({
      type: "unlabeled",
      payload: { label: "PRB-437 team", reason: "label_deleted" },
    });

    const relationConstraints = await persistence.many<{ constraint_name: string }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE table_name = 'issue_relations' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(relationConstraints.map((row) => row.constraint_name).sort()).toEqual([
      "issue_relations_issue_fkey",
      "issue_relations_related_fkey",
    ]);
    const labelConstraints = await persistence.many<{ constraint_name: string }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE table_name = 'issue_labels' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(labelConstraints.map((row) => row.constraint_name).sort()).toEqual([
      "issue_labels_issue_fkey",
      "issue_labels_label_fkey",
    ]);
    const relationIndexes = await persistence.many<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'issue_relations'`,
    );
    expect(relationIndexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(["idx_issue_relations_issue", "idx_issue_relations_related"]),
    );
    const labelIndexes = await persistence.many<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'issue_labels'`,
    );
    expect(labelIndexes.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(["idx_issue_labels_label"]),
    );

    const issueIds = [blocked.id, blocker.id, third.id];
    const issueParams = issueIds.map((_, index) => `$${index + 1}`).join(", ");
    await persistence.execute(
      `DELETE FROM issue_relations WHERE issue_id IN (${issueParams}) OR related_id IN (${issueParams})`,
      issueIds,
    );
    await persistence.execute(
      `DELETE FROM issue_labels WHERE issue_id IN (${issueParams})`,
      issueIds,
    );
    await persistence.execute(`DELETE FROM activity WHERE issue_id IN (${issueParams})`, issueIds);
    await persistence.execute(`DELETE FROM issues WHERE id IN (${issueParams})`, issueIds);
    await persistence.execute("DELETE FROM labels WHERE id IN ($1, $2, $3)", [
      globalLabelId,
      teamLabelId,
      foreignLabelId,
    ]);
    await persistence.execute("DELETE FROM api_key_team_limits WHERE api_key_id = $1", [
      limitedKeyId,
    ]);
    await persistence.execute("DELETE FROM api_key_scopes WHERE api_key_id IN ($1, $2)", [
      adminKeyId,
      limitedKeyId,
    ]);
    await persistence.execute("DELETE FROM api_keys WHERE id IN ($1, $2)", [
      adminKeyId,
      limitedKeyId,
    ]);
    await persistence.execute("UPDATE teams SET default_state_id = NULL WHERE id = $1", [
      otherTeamId,
    ]);
    await persistence.execute("DELETE FROM workflow_states WHERE team_id = $1", [otherTeamId]);
    await persistence.execute("DELETE FROM team_memberships WHERE team_id = $1", [otherTeamId]);
    await persistence.execute("DELETE FROM teams WHERE id = $1", [otherTeamId]);
  });
});
