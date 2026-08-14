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
  | "labeled"
  | "unlabeled"
  | "commented"
  | "archived";

export function recordActivity(
  db: Database,
  issueId: string,
  actorId: string,
  type: ActivityType,
  payload: Record<string, unknown> = {},
): void {
  db.query(
    "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(newId(), issueId, actorId, type, JSON.stringify(payload), now());
}
