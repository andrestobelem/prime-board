// Inbox del actor autenticado (PRB-202/210).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { now } from "../db/util.ts";
import type { ActivityRow } from "./activity.ts";

export interface InboxActivityRow extends ActivityRow {
  is_read: number;
  is_archived: number;
}

/**
 * Eventos relevantes para el viewer:
 * - created/assigned donde quedó assignee
 * - commented / state_changed / priority_changed en issues que tiene asignados
 * Excluye actividad generada por el propio viewer.
 */
export function listInboxActivity(
  db: Database,
  viewerId: string,
  opts: { first?: number; includeArchived?: boolean } = {},
): InboxActivityRow[] {
  const limit = Math.min(Math.max(opts.first ?? 50, 1), 100);
  const includeArchived = Boolean(opts.includeArchived);
  return db
    .query(
      `SELECT a.*,
              CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END AS is_read,
              CASE WHEN r.archived_at IS NOT NULL THEN 1 ELSE 0 END AS is_archived
       FROM activity a
       JOIN issues i ON i.id = a.issue_id
       LEFT JOIN inbox_receipts r ON r.activity_id = a.id AND r.actor_id = ?1
       WHERE a.actor_id <> ?1
         AND (
           (a.type = 'assigned' AND json_extract(a.payload, '$.to') = ?1)
           OR (a.type = 'created' AND json_extract(a.payload, '$.assigneeId') = ?1)
           OR (
             a.type IN ('commented', 'state_changed', 'priority_changed')
             AND i.assignee_id = ?1
           )
         )
         AND (?3 = 1 OR r.archived_at IS NULL)
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?2`,
    )
    .all(viewerId, limit, includeArchived ? 1 : 0) as InboxActivityRow[];
}

function ensureReceipt(db: Database, activityId: string, actorId: string): void {
  const activity = db.query("SELECT id FROM activity WHERE id = ?1").get(activityId);
  if (!activity) throw apiError("NOT_FOUND", "Inbox item not found");
  db.query(
    `INSERT INTO inbox_receipts (activity_id, actor_id, read_at, archived_at)
     VALUES (?1, ?2, NULL, NULL)
     ON CONFLICT(activity_id, actor_id) DO NOTHING`,
  ).run(activityId, actorId);
}

export function markInboxRead(db: Database, activityId: string, actorId: string): InboxActivityRow {
  ensureReceipt(db, activityId, actorId);
  db.query(
    `UPDATE inbox_receipts SET read_at = COALESCE(read_at, ?3)
     WHERE activity_id = ?1 AND actor_id = ?2`,
  ).run(activityId, actorId, now());
  const rows = listInboxActivity(db, actorId, { first: 100, includeArchived: true });
  const row = rows.find((item) => item.id === activityId);
  if (!row) throw apiError("NOT_FOUND", "Inbox item not found");
  return row;
}

export function archiveInboxItem(
  db: Database,
  activityId: string,
  actorId: string,
): InboxActivityRow {
  ensureReceipt(db, activityId, actorId);
  const timestamp = now();
  db.query(
    `UPDATE inbox_receipts
     SET archived_at = ?3, read_at = COALESCE(read_at, ?3)
     WHERE activity_id = ?1 AND actor_id = ?2`,
  ).run(activityId, actorId, timestamp);
  const rows = listInboxActivity(db, actorId, { first: 100, includeArchived: true });
  const row = rows.find((item) => item.id === activityId);
  if (!row) throw apiError("NOT_FOUND", "Inbox item not found");
  return row;
}
