import { describe, expect, it } from "bun:test";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import {
  listPostgresComments,
  mapPostgresComment,
  type PostgresCommentRow,
} from "./postgres-comments.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const workspaceA: WorkspaceContext = { workspaceId: "workspace-a" };
const workspaceB: WorkspaceContext = { workspaceId: "workspace-b" };

const row: PostgresCommentRow = {
  id: "comment-a",
  issue_id: "issue-a",
  actor_id: "actor-a",
  body: "Visible in Workspace A",
  created_at: "2026-09-08T00:00:00.000Z",
  edited_at: null,
  workspace_id: "workspace-a",
};

function fakePersistence(rows: readonly PostgresCommentRow[]) {
  const calls: Array<{ sql: string; params: SqlParameters | undefined }> = [];
  const persistence: Persistence = {
    one: async <Row extends object>() => null as Row | null,
    many: async <Row extends object>(sql: string, params?: SqlParameters) => {
      calls.push({ sql, params });
      return rows as readonly Row[];
    },
    execute: async <Row extends object>(): Promise<PersistenceResult<Row>> => ({
      rows: [],
      rowCount: 0,
    }),
    transaction: async <Result>(callback: (tx: PersistenceTransaction) => Promise<Result>) =>
      callback(persistence),
    close: async () => undefined,
  };
  return { persistence, calls };
}

describe("PostgreSQL comments", () => {
  it("maps the GraphQL shape without dropping the Workspace scope", () => {
    expect(mapPostgresComment(row)).toEqual({
      id: "comment-a",
      body: "Visible in Workspace A",
      actorId: "actor-a",
      issueId: "issue-a",
      createdAt: "2026-09-08T00:00:00.000Z",
      editedAt: null,
      _workspaceId: "workspace-a",
    });
  });

  it("binds the effective Workspace to the Issue, Comment, and author Membership", async () => {
    const { persistence, calls } = fakePersistence([row]);
    const comments = await listPostgresComments(persistence, "issue-a", workspaceA);

    expect(comments).toEqual([row]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(["issue-a", "workspace-a"]);
    expect(calls[0]?.sql).toContain("issues.workspace_id = $2");
    expect(calls[0]?.sql).toContain("comments.workspace_id = $2");
    expect(calls[0]?.sql).toContain("memberships.workspace_id = $2");
  });

  it("does not use a global Actor lookup for nested comments", async () => {
    const { persistence, calls } = fakePersistence([]);
    await listPostgresComments(persistence, "issue-a", workspaceB);

    expect(calls[0]?.sql).toContain("JOIN workspace_memberships AS memberships");
    expect(calls[0]?.sql).not.toContain("SELECT actors.*");
  });
});
