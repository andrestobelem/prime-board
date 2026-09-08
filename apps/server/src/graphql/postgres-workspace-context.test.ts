// PRB-679: matriz de aislamiento GraphQL para dos Workspaces PostgreSQL.
import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { openDatabase } from "../db/database.ts";
import { resolveBootstrapIdentity } from "../db/bootstrap-config.ts";
import { bootstrapPostgres } from "../db/postgres/bootstrap.ts";
import { createPostgresHarness } from "../db/postgres/test-harness.ts";
import { createPostgresPersistence } from "../db/postgres/persistence.ts";
import { newId, now } from "../db/util.ts";
import type { Config } from "../config.ts";

type GraphqlResponse = {
  data?: Record<string, any>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

const integration = process.env.PRIME_BOARD_POSTGRES_URL ? it : it.skip;

describe("PostgreSQL WorkspaceContext GraphQL matrix", () => {
  let stop: (() => void) | undefined;
  let close: (() => Promise<void>) | undefined;

  afterAll(async () => {
    stop?.();
    await close?.();
  });

  integration("aísla roots, nested, mutaciones, roles y API keys", async () => {
    const harness = await createPostgresHarness({
      url: process.env.PRIME_BOARD_POSTGRES_URL!,
      schemaPrefix: "prb679_workspace_context",
      lockKey: `prb679-workspace-context-${randomUUID()}`,
    });
    const persistence = createPostgresPersistence(harness.sql as unknown as Bun.SQL, {
      close: false,
    });
    const db = openDatabase(":memory:");
    try {
      const seeded = await bootstrapPostgres(persistence);
      if (!seeded.adminApiKey) throw new Error("PostgreSQL bootstrap did not issue an API key");
      const workspaceA = await persistence.one<{ id: string; url_key: string }>(
        "SELECT id, url_key FROM workspace ORDER BY id LIMIT 1",
      );
      const admin = await persistence.one<{ id: string }>(
        "SELECT id FROM actors WHERE name = 'admin'",
      );
      const teamA = await persistence.one<{ id: string; key: string }>(
        "SELECT id, key FROM teams ORDER BY created_at, id LIMIT 1",
      );
      if (!workspaceA || !admin || !teamA) throw new Error("PostgreSQL fixture is incomplete");

      // Create the second tenant and grant the bootstrap key access to it.
      await persistence.execute("DROP INDEX IF EXISTS workspace_singleton_idx");
      const workspaceBId = newId();
      const timestamp = now();
      await persistence.execute(
        `INSERT INTO workspace (id, name, url_key, created_at, updated_at)
         VALUES ($1, 'PRB-679 Workspace B', 'prb679-b', $2, $2)`,
        [workspaceBId, timestamp],
      );
      await persistence.execute(
        `INSERT INTO workspace_memberships
         (id, workspace_id, actor_id, role, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
        [newId(), workspaceBId, admin.id, timestamp],
      );
      const bootstrapKey = await persistence.one<{ id: string }>(
        "SELECT id FROM api_keys WHERE actor_id = $1 ORDER BY created_at, id LIMIT 1",
        [admin.id],
      );
      if (!bootstrapKey) throw new Error("Bootstrap API key fixture is incomplete");
      await persistence.execute(
        `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
         VALUES ($1, $2, 0, $3)`,
        [bootstrapKey.id, workspaceBId, timestamp],
      );

      // Use the same Team key in both Workspaces. Composite keys make the ids
      // independent while the GraphQL reference remains intentionally ambiguous.
      const teamBId = newId();
      const defaultStateBId = newId();
      await persistence.execute(
        `INSERT INTO teams
         (workspace_id, id, name, key, description, created_at, updated_at, visibility, access_policy)
         VALUES ($1, $2, 'PRB-679 Team B', $3, 'Workspace B team', $4, $4, 'public', 'team_members')`,
        [workspaceBId, teamBId, teamA.key, timestamp],
      );
      await persistence.execute(
        `INSERT INTO workflow_states
         (workspace_id, id, team_id, name, type, color, position, created_at, updated_at)
         VALUES ($1, $2, $3, 'B backlog', 'backlog', '#95a2b3', 0, $4, $4)`,
        [workspaceBId, defaultStateBId, teamBId, timestamp],
      );
      await persistence.execute(
        "UPDATE teams SET default_state_id = $1 WHERE workspace_id = $2 AND id = $3",
        [defaultStateBId, workspaceBId, teamBId],
      );
      await persistence.execute(
        `INSERT INTO team_memberships (workspace_id, id, team_id, actor_id, role, created_at)
         VALUES ($1, $2, $3, $4, 'owner', $5)`,
        [workspaceBId, newId(), teamBId, admin.id, timestamp],
      );

      const { createApp } = await import("../server.ts");
      const config = {
        port: 0,
        host: "127.0.0.1",
        authMode: "api-key",
        dbPath: ":memory:",
        postgresUrl: process.env.PRIME_BOARD_POSTGRES_URL,
        persistenceBackend: "postgres",
        dev: false,
        webDist: "/tmp/prime-board-no-web",
        repoRoot: null,
        bootstrap: resolveBootstrapIdentity({}),
      } as Config;
      const app = createApp({ db, config, persistence });
      stop = () => app.server.stop();
      close = async () => {
        db.close();
        await persistence.close();
      };

      const request = async (
        query: string,
        variables?: Record<string, unknown>,
        token = seeded.adminApiKey!,
        workspaceSelector?: string,
      ): Promise<GraphqlResponse> => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        };
        if (workspaceSelector) headers["x-workspace-id"] = workspaceSelector;
        const response = await fetch(`http://127.0.0.1:${app.server.port}/graphql`, {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables }),
        });
        return (await response.json()) as GraphqlResponse;
      };

      const issueA = await request(
        `mutation($key: String!) {
          issueCreate(input: { teamKey: $key, title: "A issue" }) { issue { id identifier } }
        }`,
        { key: teamA.key },
        seeded.adminApiKey,
        workspaceA.url_key,
      );
      expect(issueA.errors).toBeUndefined();
      const issueAId = issueA.data!.issueCreate.issue.id as string;
      const issueAIdentifier = issueA.data!.issueCreate.issue.identifier as string;

      const projectB = await request(
        `mutation($team: ID!) {
          projectCreate(input: { name: "B project", teamIds: [$team] }) { project { id } }
        }`,
        { team: teamBId },
        seeded.adminApiKey,
        workspaceBId,
      );
      expect(projectB.errors).toBeUndefined();
      const projectBId = projectB.data!.projectCreate.project.id as string;

      const labelB = await request(
        `mutation($team: ID!) { labelCreate(input: { name: "B label", teamId: $team }) { label { id } } }`,
        { team: teamBId },
        seeded.adminApiKey,
        workspaceBId,
      );
      expect(labelB.errors).toBeUndefined();
      const labelBId = labelB.data!.labelCreate.label.id as string;
      const stateB = await request(
        `mutation($team: ID!) {
          workflowStateCreate(input: { teamId: $team, name: "B started", type: STARTED }) {
            workflowState { id }
          }
        }`,
        { team: teamBId },
        seeded.adminApiKey,
        workspaceBId,
      );
      expect(stateB.errors).toBeUndefined();
      const stateBId = stateB.data!.workflowStateCreate.workflowState.id as string;

      const issueB = await request(
        `mutation($key: String!, $project: ID!, $actor: ID!, $label: ID!) {
          issueCreate(input: { teamKey: $key, title: "B issue", projectId: $project, assigneeId: $actor, labelIds: [$label] }) {
            issue { id identifier }
          }
        }`,
        { key: teamA.key, project: projectBId, actor: admin.id, label: labelBId },
        seeded.adminApiKey,
        workspaceBId,
      );
      expect(issueB.errors).toBeUndefined();
      const issueBId = issueB.data!.issueCreate.issue.id as string;
      const issueBIdentifier = issueB.data!.issueCreate.issue.identifier as string;

      const nestedB = await request(
        `query($id: ID!) {
          issue(id: $id) {
            id identifier branchName
            assignee { id }
            creator { id }
            project { id }
            labels { id }
            activity { type payload actor { id } }
          }
        }`,
        { id: issueBId },
        seeded.adminApiKey,
        workspaceBId,
      );
      expect(nestedB.errors).toBeUndefined();
      expect(nestedB.data!.issue).toMatchObject({
        id: issueBId,
        identifier: issueBIdentifier,
        project: { id: projectBId },
        labels: [{ id: labelBId }],
        creator: { id: admin.id },
        assignee: { id: admin.id },
      });
      expect(nestedB.data!.issue.branchName).toContain(issueBIdentifier.toLowerCase());
      expect(nestedB.data!.issue.activity).toEqual(
        expect.arrayContaining([expect.objectContaining({ actor: { id: admin.id } })]),
      );
      for (const activity of nestedB.data!.issue.activity as Array<{ payload: unknown }>) {
        expect(activity.payload).toEqual(expect.any(Object));
      }

      const rootsA = await request(
        `query($issue: ID!, $project: ID!, $key: String!) {
          issue(id: $issue) { id }
          project(id: $project) { id }
          team(key: $key) { id }
          issues { nodes { id identifier } }
        }`,
        { issue: issueBId, project: projectBId, key: teamA.key },
        seeded.adminApiKey,
        workspaceA.url_key,
      );
      expect(rootsA.errors).toBeUndefined();
      expect(rootsA.data!.issue).toBeNull();
      expect(rootsA.data!.project).toBeNull();
      expect(rootsA.data!.team).toMatchObject({ id: teamA.id });
      expect(rootsA.data!.issues.nodes).toEqual([{ id: issueAId, identifier: issueAIdentifier }]);

      const rootsB = await request(
        `query($issue: ID!, $project: ID!, $key: String!) {
          issue(id: $issue) { id }
          project(id: $project) { id }
          team(key: $key) { id }
          issues { nodes { id identifier } }
        }`,
        { issue: issueBId, project: projectBId, key: teamA.key },
        seeded.adminApiKey,
        workspaceBId,
      );
      expect(rootsB.errors).toBeUndefined();
      expect(rootsB.data!.issue).toMatchObject({ id: issueBId });
      expect(rootsB.data!.project).toMatchObject({ id: projectBId });
      expect(rootsB.data!.team).toMatchObject({ id: teamBId });
      expect(rootsB.data!.issues.nodes).toEqual([{ id: issueBId, identifier: issueBIdentifier }]);

      const crossWorkspaceMutation = await request(
        `mutation($id: ID!) { issueUpdate(id: $id, input: { title: "hijacked" }) { success } }`,
        { id: issueBId },
        seeded.adminApiKey,
        workspaceA.url_key,
      );
      expect(crossWorkspaceMutation.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

      const crossProjectMutation = await request(
        `mutation($id: ID!) { projectArchive(id: $id) { success } }`,
        { id: projectBId },
        seeded.adminApiKey,
        workspaceA.url_key,
      );
      expect(crossProjectMutation.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

      const crossLabelMutation = await request(
        `mutation($id: ID!) { labelDelete(id: $id) { success } }`,
        { id: labelBId },
        seeded.adminApiKey,
        workspaceA.url_key,
      );
      expect(crossLabelMutation.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
      const crossStateMutation = await request(
        `mutation($id: ID!) { workflowStateDelete(id: $id) { success } }`,
        { id: stateBId },
        seeded.adminApiKey,
        workspaceA.url_key,
      );
      expect(crossStateMutation.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

      const memberView = await request(
        "{ viewer { workspaceRole } workspace { role } }",
        undefined,
        seeded.adminApiKey,
        workspaceBId,
      );
      expect(memberView.errors).toBeUndefined();
      expect(memberView.data!.viewer.workspaceRole).toBe("MEMBER");
      expect(memberView.data!.workspace.role).toBe("MEMBER");

      const memberMutation = await request(
        `mutation($id: ID!) { issueUpdate(id: $id, input: { title: "B updated" }) { success } }`,
        { id: issueBId },
        seeded.adminApiKey,
        workspaceBId,
      );
      expect(memberMutation.errors).toBeUndefined();
      expect(memberMutation.data!.issueUpdate.success).toBe(true);

      const aOnlyToken = generateApiKey();
      const aOnlyKeyId = newId();
      await persistence.execute(
        `INSERT INTO api_keys (id, actor_id, name, hash, created_at)
         VALUES ($1, $2, 'PRB-679 A-only key', $3, $4)`,
        [aOnlyKeyId, admin.id, hashApiKey(aOnlyToken), timestamp],
      );
      await persistence.execute(
        `INSERT INTO api_key_scopes (api_key_id, scope) VALUES ($1, 'read'), ($1, 'write')`,
        [aOnlyKeyId],
      );
      await persistence.execute(
        `INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
         VALUES ($1, $2, 1, $3)`,
        [aOnlyKeyId, workspaceA.id, timestamp],
      );
      const limitedSelector = await request(
        "{ teams { id } }",
        undefined,
        aOnlyToken,
        workspaceBId,
      );
      expect(limitedSelector.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    } finally {
      stop?.();
      db.close();
      await persistence.close();
      await harness.close();
    }
  });
});
