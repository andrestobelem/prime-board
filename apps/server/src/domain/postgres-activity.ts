import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import type { ActivityRow } from "./activity.ts";

/**
 * Lista Activity dentro del Workspace de la Membership del autor.
 * El estado de la Membership no se filtra: la Activity conserva autoría histórica.
 */
export async function listPostgresActivity(
  persistence: Persistence | PersistenceTransaction,
  issueId: string,
  workspaceId: string,
): Promise<readonly ActivityRow[]> {
  return persistence.many<ActivityRow>(
    `SELECT activity.*
       FROM activity
       JOIN workspace_memberships AS memberships
         ON memberships.actor_id = activity.actor_id
        AND memberships.workspace_id = $2
      WHERE activity.issue_id = $1
      ORDER BY activity.created_at, activity.id`,
    [issueId, workspaceId],
  );
}
