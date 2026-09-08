// Dominio PostgreSQL de suscriptores de issues (PRB-529).
import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { getPostgresIssueByRef } from "./postgres-issues.ts";
import type { IssueRow } from "./issues.ts";

export interface PostgresIssueSubscriptionResult {
  row: IssueRow;
  changed: boolean;
}

export async function listPostgresIssueSubscribers(
  persistence: Persistence | PersistenceTransaction,
  issueId: string,
  workspaceId?: string,
): Promise<ActorRow[]> {
  return [
    ...(await persistence.many<ActorRow>(
      `SELECT actors.*
         FROM issue_subscribers
         JOIN actors ON actors.id = issue_subscribers.actor_id
        WHERE issue_subscribers.issue_id = $1
          ${workspaceId ? "AND issue_subscribers.workspace_id = $2" : ""}
        ORDER BY actors.name, actors.id`,
      workspaceId ? [issueId, workspaceId] : [issueId],
    )),
  ];
}

async function changeSubscription(
  persistence: Persistence,
  actorId: string,
  ref: string,
  action: "subscribe" | "unsubscribe",
  workspaceId: string,
): Promise<PostgresIssueSubscriptionResult> {
  return persistence.transaction(async (tx) => {
    const issue = await getPostgresIssueByRef(tx, ref, { workspaceId });
    if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${ref}`);
    if (action === "subscribe" && issue.archived_at) {
      throw apiError("VALIDATION_FAILED", "Archived issues cannot be followed");
    }
    const timestamp = now();
    let changed = false;
    if (action === "subscribe") {
      const result = await tx.execute(
        `INSERT INTO issue_subscribers (issue_id, actor_id, workspace_id, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (issue_id, actor_id) DO NOTHING`,
        [issue.id, actorId, workspaceId, timestamp],
      );
      changed = result.rowCount > 0;
    } else {
      const result = await tx.execute(
        "DELETE FROM issue_subscribers WHERE issue_id = $1 AND actor_id = $2 AND workspace_id = $3",
        [issue.id, actorId, workspaceId],
      );
      changed = result.rowCount > 0;
    }
    if (changed) {
      await tx.execute("UPDATE issues SET updated_at = $1 WHERE id = $2", [timestamp, issue.id]);
      await tx.execute(
        `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          newId(),
          issue.id,
          actorId,
          action === "subscribe" ? "subscribed" : "unsubscribed",
          JSON.stringify({ actorId }),
          timestamp,
        ],
      );
    }
    const row = await getPostgresIssueByRef(tx, issue.id, { workspaceId });
    if (!row) throw apiError("NOT_FOUND", `Issue not found: ${ref}`);
    return { row, changed };
  });
}

export function subscribeToPostgresIssue(
  persistence: Persistence,
  actorId: string,
  ref: string,
  workspaceId: string,
): Promise<PostgresIssueSubscriptionResult> {
  return changeSubscription(persistence, actorId, ref, "subscribe", workspaceId);
}

export function unsubscribeFromPostgresIssue(
  persistence: Persistence,
  actorId: string,
  ref: string,
  workspaceId: string,
): Promise<PostgresIssueSubscriptionResult> {
  return changeSubscription(persistence, actorId, ref, "unsubscribe", workspaceId);
}
