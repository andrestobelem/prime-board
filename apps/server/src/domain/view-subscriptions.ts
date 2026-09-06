import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";

export interface ViewSubscriptionRow {
  id: string;
  workspace_id: string;
  view_id: string;
  actor_id: string;
  issue_changes: number | boolean;
  slack: number | boolean;
  created_at: string;
  updated_at: string;
}

function bool(value: number | boolean): boolean {
  return value === true || value === 1;
}

function assertActiveMembership(db: Database, workspaceId: string, actorId: string): void {
  const membership = db
    .query(
      `SELECT 1 FROM workspace_memberships
       WHERE workspace_id = ?1 AND actor_id = ?2 AND status = 'active'`,
    )
    .get(workspaceId, actorId);
  if (!membership)
    throw apiError("UNAUTHORIZED", "View subscriptions require an active Workspace membership");
}

function getSubscription(
  db: Database,
  workspaceId: string,
  viewId: string,
  actorId: string,
): ViewSubscriptionRow | null {
  return db
    .query(
      `SELECT * FROM view_subscriptions
       WHERE workspace_id = ?1 AND view_id = ?2 AND actor_id = ?3`,
    )
    .get(workspaceId, viewId, actorId) as ViewSubscriptionRow | null;
}

export function listViewSubscriptions(
  db: Database,
  workspaceId: string,
  viewId: string,
): ViewSubscriptionRow[] {
  return db
    .query(
      `SELECT * FROM view_subscriptions
       WHERE workspace_id = ?1 AND view_id = ?2
       ORDER BY created_at, id`,
    )
    .all(workspaceId, viewId) as ViewSubscriptionRow[];
}

export interface ViewSubscriptionInput {
  issueChanges?: boolean | null;
  slack?: boolean | null;
}

/** Persists channel intent. Delivery is owned by the Notifications integration. */
export function updateViewSubscription(
  db: Database,
  workspaceId: string,
  viewId: string,
  actorId: string,
  input: ViewSubscriptionInput,
): ViewSubscriptionRow {
  assertActiveMembership(db, workspaceId, actorId);
  const existing = getSubscription(db, workspaceId, viewId, actorId);
  const issueChanges = input.issueChanges ?? (existing ? bool(existing.issue_changes) : true);
  const slack = input.slack ?? (existing ? bool(existing.slack) : false);
  if (!issueChanges && !slack) {
    throw apiError("VALIDATION_FAILED", "A view subscription requires at least one channel");
  }
  const timestamp = now();
  if (existing) {
    db.query(
      `UPDATE view_subscriptions
       SET issue_changes = ?1, slack = ?2, updated_at = ?3
       WHERE workspace_id = ?4 AND id = ?5`,
    ).run(issueChanges ? 1 : 0, slack ? 1 : 0, timestamp, workspaceId, existing.id);
  } else {
    db.query(
      `INSERT INTO view_subscriptions
       (id, workspace_id, view_id, actor_id, issue_changes, slack, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).run(newId(), workspaceId, viewId, actorId, issueChanges ? 1 : 0, slack ? 1 : 0, timestamp);
  }
  const result = getSubscription(db, workspaceId, viewId, actorId);
  if (!result) throw new Error("View subscription upsert returned no row");
  return result;
}

export function deleteViewSubscription(
  db: Database,
  workspaceId: string,
  viewId: string,
  actorId: string,
): boolean {
  assertActiveMembership(db, workspaceId, actorId);
  db.query(
    `DELETE FROM view_subscriptions
     WHERE workspace_id = ?1 AND view_id = ?2 AND actor_id = ?3`,
  ).run(workspaceId, viewId, actorId);
  return true;
}

export interface ViewSubscription {
  id: string;
  workspaceId: string;
  viewId: string;
  actorId: string;
  issueChanges: boolean;
  slack: boolean;
  createdAt: string;
  updatedAt: string;
}

export function mapViewSubscription(row: ViewSubscriptionRow): ViewSubscription {
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
