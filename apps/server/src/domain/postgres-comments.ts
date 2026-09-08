import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import type { WorkspaceContext } from "./workspace-context.ts";
import type { CommentRow } from "./comments.ts";

/** A PostgreSQL comment row scoped to the Workspace that owns its Issue. */
export interface PostgresCommentRow extends CommentRow {
  workspace_id: string;
}

/** GraphQL shape for a comment, retaining its scope for nested guards. */
export interface PostgresCommentView {
  id: string;
  body: string;
  actorId: string;
  issueId: string;
  createdAt: string;
  editedAt: string | null;
  _workspaceId: string;
}

export function mapPostgresComment(row: PostgresCommentRow): PostgresCommentView {
  return {
    id: row.id,
    body: row.body,
    actorId: row.actor_id,
    issueId: row.issue_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    _workspaceId: row.workspace_id,
  };
}

/**
 * Lists comments only when both the Issue and its Comment belong to the
 * effective Workspace. The author Membership join prevents a global Actor
 * row from becoming visible through this nested field.
 */
export async function listPostgresComments(
  persistence: Persistence | PersistenceTransaction,
  issueId: string,
  context: WorkspaceContext,
): Promise<readonly PostgresCommentRow[]> {
  const workspaceId = context.workspaceId;
  return persistence.many<PostgresCommentRow>(
    `SELECT comments.*
       FROM comments
       JOIN issues
         ON issues.id = comments.issue_id
        AND issues.workspace_id = $2
       JOIN workspace_memberships AS memberships
         ON memberships.actor_id = comments.actor_id
        AND memberships.workspace_id = $2
      WHERE comments.issue_id = $1
        AND comments.workspace_id = $2
      ORDER BY comments.created_at, comments.id`,
    [issueId, workspaceId],
  );
}
