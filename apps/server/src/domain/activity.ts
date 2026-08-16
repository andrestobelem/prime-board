// Historial de actividad append-only por issue (spec §3, tabla activity).
import type { Database } from "bun:sqlite";
import { newId, now } from "../db/util.ts";

export type ActivityType =
  | "created"
  | "title_changed"
  | "description_changed"
  | "state_changed"
  | "priority_changed"
  | "assigned"
  | "parent_changed"
  | "project_changed"
  | "milestone_changed"
  | "cycle_changed"
  | "sort_order_changed"
  | "labeled"
  | "unlabeled"
  | "relation_added"
  | "relation_removed"
  | "commented"
  | "archived";

export interface ActivityRow {
  id: string;
  issue_id: string;
  actor_id: string;
  type: ActivityType;
  payload: string;
  created_at: string;
}

export function mapActivity(row: ActivityRow) {
  return {
    id: row.id,
    type: row.type,
    actorId: row.actor_id,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

export function listActivity(db: Database, issueId: string): ActivityRow[] {
  return db
    .query("SELECT * FROM activity WHERE issue_id = ?1 ORDER BY created_at, id")
    .all(issueId) as ActivityRow[];
}

export function recordActivity(
  db: Database,
  issueId: string,
  actorId: string,
  type: ActivityType,
  payload: Record<string, unknown> = {},
  /** Timestamp explícito (imports); default: ahora. */
  createdAt?: string,
): void {
  db.query(
    "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(newId(), issueId, actorId, type, JSON.stringify(payload), createdAt ?? now());
}
