// Dominio de suscriptores de issues (PRB-529).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { recordActivity } from "./activity.ts";
import { getIssueByRef, type IssueRow } from "./issues.ts";
import type { ActorRow } from "../auth/viewer.ts";

export interface IssueSubscriptionResult {
  row: IssueRow;
  changed: boolean;
}

export function listIssueSubscribers(
  db: Database,
  issueId: string,
  workspaceId?: string,
): ActorRow[] {
  const query = `
    SELECT actors.id, actors.name, actors.email, actors.type,
           memberships.role AS workspace_role, memberships.status AS status,
           actors.avatar_url, actors.created_at, actors.updated_at
      FROM issue_subscribers
      JOIN actors ON actors.id = issue_subscribers.actor_id
      JOIN workspace_memberships AS memberships
        ON memberships.actor_id = actors.id
       AND memberships.workspace_id = issue_subscribers.workspace_id
     WHERE issue_subscribers.issue_id = ?1
       ${workspaceId ? "AND issue_subscribers.workspace_id = ?2" : ""}
     ORDER BY actors.name, actors.id`;
  return (
    workspaceId ? db.query(query).all(issueId, workspaceId) : db.query(query).all(issueId)
  ) as ActorRow[];
}

function changeSubscription(
  db: Database,
  actorId: string,
  ref: string,
  action: "subscribe" | "unsubscribe",
  workspaceId?: string,
): IssueSubscriptionResult {
  const issue = getIssueByRef(db, ref);
  if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${ref}`);
  if (action === "subscribe" && issue.archived_at) {
    throw apiError("VALIDATION_FAILED", "Archived issues cannot be followed");
  }
  const timestamp = now();
  let changed = false;
  db.transaction(() => {
    if (action === "subscribe") {
      const result = db
        .query(
          `INSERT INTO issue_subscribers (issue_id, actor_id, created_at, workspace_id)
           VALUES (?1, ?2, ?3, ?4) ON CONFLICT(issue_id, actor_id) DO NOTHING`,
        )
        .run(issue.id, actorId, timestamp, workspaceId ?? null);
      changed = result.changes > 0;
    } else {
      const result = workspaceId
        ? db
            .query(
              "DELETE FROM issue_subscribers WHERE issue_id = ?1 AND actor_id = ?2 AND workspace_id = ?3",
            )
            .run(issue.id, actorId, workspaceId)
        : db
            .query("DELETE FROM issue_subscribers WHERE issue_id = ?1 AND actor_id = ?2")
            .run(issue.id, actorId);
      changed = result.changes > 0;
    }
    if (changed) {
      db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2").run(timestamp, issue.id);
      recordActivity(
        db,
        issue.id,
        actorId,
        action === "subscribe" ? "subscribed" : "unsubscribed",
        { actorId },
        timestamp,
        workspaceId,
      );
    }
  })();
  const row = getIssueByRef(db, issue.id);
  if (!row) throw apiError("NOT_FOUND", `Issue not found: ${ref}`);
  return { row, changed };
}

export function subscribeToIssue(
  db: Database,
  actorId: string,
  ref: string,
  workspaceId?: string,
): IssueSubscriptionResult {
  return changeSubscription(db, actorId, ref, "subscribe", workspaceId);
}

export function unsubscribeFromIssue(
  db: Database,
  actorId: string,
  ref: string,
  workspaceId?: string,
): IssueSubscriptionResult {
  return changeSubscription(db, actorId, ref, "unsubscribe", workspaceId);
}
