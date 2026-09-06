import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import type {
  ViewSubscription,
  ViewSubscriptionInput,
  ViewSubscriptionRow,
} from "./view-subscriptions.ts";

function bool(value: number | boolean): boolean {
  return value === true || value === 1;
}

async function assertActiveMembership(
  persistence: Persistence | PersistenceTransaction,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const membership = await persistence.one(
    `SELECT 1 FROM workspace_memberships
     WHERE workspace_id = $1 AND actor_id = $2 AND status = 'active'`,
    [workspaceId, actorId],
  );
  if (!membership) {
    throw apiError("UNAUTHORIZED", "View subscriptions require an active Workspace membership");
  }
}

async function getSubscription(
  persistence: Persistence | PersistenceTransaction,
  workspaceId: string,
  viewId: string,
  actorId: string,
): Promise<ViewSubscriptionRow | null> {
  return persistence.one<ViewSubscriptionRow>(
    `SELECT * FROM view_subscriptions
     WHERE workspace_id = $1 AND view_id = $2 AND actor_id = $3`,
    [workspaceId, viewId, actorId],
  );
}

export async function listPostgresViewSubscriptions(
  persistence: Persistence,
  workspaceId: string,
  viewId: string,
): Promise<ViewSubscriptionRow[]> {
  return (await persistence.many<ViewSubscriptionRow>(
    `SELECT * FROM view_subscriptions
     WHERE workspace_id = $1 AND view_id = $2
     ORDER BY created_at, id`,
    [workspaceId, viewId],
  )) as ViewSubscriptionRow[];
}

export async function updatePostgresViewSubscription(
  persistence: Persistence,
  workspaceId: string,
  viewId: string,
  actorId: string,
  input: ViewSubscriptionInput,
): Promise<ViewSubscriptionRow> {
  await assertActiveMembership(persistence, workspaceId, actorId);
  const existing = await getSubscription(persistence, workspaceId, viewId, actorId);
  const issueChanges = input.issueChanges ?? (existing ? bool(existing.issue_changes) : true);
  const slack = input.slack ?? (existing ? bool(existing.slack) : false);
  if (!issueChanges && !slack) {
    throw apiError("VALIDATION_FAILED", "A view subscription requires at least one channel");
  }
  const timestamp = now();
  if (existing) {
    const updated = await persistence.one<ViewSubscriptionRow>(
      `UPDATE view_subscriptions
       SET issue_changes = $1, slack = $2, updated_at = $3
       WHERE workspace_id = $4 AND id = $5
       RETURNING *`,
      [issueChanges, slack, timestamp, workspaceId, existing.id],
    );
    if (!updated) throw new Error("View subscription update returned no row");
    return updated;
  }
  await persistence.execute(
    `INSERT INTO view_subscriptions
     (id, workspace_id, view_id, actor_id, issue_changes, slack, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [newId(), workspaceId, viewId, actorId, issueChanges, slack, timestamp],
  );
  const result = await getSubscription(persistence, workspaceId, viewId, actorId);
  if (!result) throw new Error("View subscription insert returned no row");
  return result;
}

export async function deletePostgresViewSubscription(
  persistence: Persistence,
  workspaceId: string,
  viewId: string,
  actorId: string,
): Promise<boolean> {
  await assertActiveMembership(persistence, workspaceId, actorId);
  await persistence.execute(
    `DELETE FROM view_subscriptions
     WHERE workspace_id = $1 AND view_id = $2 AND actor_id = $3`,
    [workspaceId, viewId, actorId],
  );
  return true;
}

export function mapPostgresViewSubscription(row: ViewSubscriptionRow): ViewSubscription {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    viewId: row.view_id,
    actorId: row.actor_id,
    issueChanges: bool(row.issue_changes),
    slack: bool(row.slack),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
