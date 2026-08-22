// Inbox del actor autenticado (PRB-202/210).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { now } from "../db/util.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { canAccessTeam } from "../auth/permissions.ts";
import type { ActivityRow } from "./activity.ts";

export interface InboxActivityRow extends ActivityRow {
  workspace_id?: string | null;
  is_read: number;
  is_archived: number;
  issue_assignee_id: string | null;
  issue_team_id: string;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A mention is the actor name prefixed by @ and delimited from the surrounding
 * mention token. Hyphens and dots are included in the token so @agent-extra
 * does not notify the actor named @agent.
 */
function mentionsActor(body: string, actorName: string): boolean {
  const name = actorName.trim();
  if (!name) return false;
  const tokenBoundary = "[^\\p{L}\\p{N}_.-]";
  return new RegExp(`(^|${tokenBoundary})@${escapedRegExp(name)}(?=$|${tokenBoundary})`, "iu").test(
    body,
  );
}

function activityBody(row: ActivityRow): string {
  const payload = JSON.parse(row.payload) as { body?: unknown };
  return typeof payload.body === "string" ? payload.body : "";
}

/**
 * Eventos relevantes para el viewer:
 * - created/assigned donde quedó assignee
 * - commented / state_changed / priority_changed en issues que tiene asignados
 * - comentarios que mencionan al viewer con @nombre
 * Excluye actividad generada por el propio viewer.
 */
type InboxListOptions = { first?: number; includeArchived?: boolean };
type ViewerRef = string | ActorRow;

function resolveViewer(db: Database, viewer: ViewerRef): ActorRow | null {
  if (typeof viewer !== "string") return viewer;
  return db.query("SELECT * FROM actors WHERE id = ?1").get(viewer) as ActorRow | null;
}

function viewerId(viewer: ViewerRef): string {
  return typeof viewer === "string" ? viewer : viewer.id;
}

function listInboxActivityInternal(
  db: Database,
  viewerRef: ViewerRef,
  opts: InboxListOptions,
  limit: number | null,
  workspaceId?: string,
): InboxActivityRow[] {
  const includeArchived = Boolean(opts.includeArchived);
  const viewer = resolveViewer(db, viewerRef);
  if (!viewer) return [];
  const actorId = viewer.id;

  // La asignación efectiva del issue no alcanza para decidir la relevancia de
  // un evento histórico: una transferencia posterior no debe borrar una
  // notificación que todavía no fue leída. Recuperamos todos los eventos que
  // pueden alimentar el inbox y reconstruimos el assignee al momento de cada
  // evento a partir del log append-only.
  const workspaceCondition = workspaceId ? "AND i.workspace_id = ?3" : "";
  const rowsQuery = `SELECT a.*,
              i.assignee_id AS issue_assignee_id,
              i.team_id AS issue_team_id,
              i.workspace_id AS workspace_id,
              CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END AS is_read,
              CASE WHEN r.archived_at IS NOT NULL THEN 1 ELSE 0 END AS is_archived
       FROM activity a
       JOIN issues i ON i.id = a.issue_id
       LEFT JOIN inbox_receipts r ON r.activity_id = a.id AND r.actor_id = ?1
       WHERE (?2 = 1 OR r.archived_at IS NULL)
         ${workspaceCondition}
         AND a.type IN ('created', 'assigned', 'commented', 'state_changed', 'priority_changed')
       ORDER BY a.created_at DESC, a.id DESC`;
  const rows = (
    workspaceId
      ? db.query(rowsQuery).all(actorId, includeArchived ? 1 : 0, workspaceId)
      : db.query(rowsQuery).all(actorId, includeArchived ? 1 : 0)
  ) as InboxActivityRow[];
  const visibleRows = rows.filter((row) => canAccessTeam(db, viewer, row.issue_team_id));

  const historicalAssignee = new Map<string, string | null>();
  const byIssue = new Map<string, InboxActivityRow[]>();
  for (const row of visibleRows) {
    const issueRows = byIssue.get(row.issue_id) ?? [];
    issueRows.push(row);
    byIssue.set(row.issue_id, issueRows);
  }
  for (const issueRows of byIssue.values()) {
    issueRows.sort((a, b) =>
      a.created_at === b.created_at
        ? a.id.localeCompare(b.id)
        : a.created_at.localeCompare(b.created_at),
    );
    let assignee: string | null = null;
    let sawCreated = false;
    for (const row of issueRows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (!sawCreated && row.type !== "created") {
        // Imports anteriores a la actividad `created` no tienen snapshot
        // inicial; el estado actual es el mejor fallback disponible.
        assignee = row.issue_assignee_id;
      }
      if (row.type === "created") {
        assignee = typeof payload.assigneeId === "string" ? payload.assigneeId : null;
        sawCreated = true;
        historicalAssignee.set(row.id, assignee);
      } else if (row.type === "assigned") {
        historicalAssignee.set(row.id, typeof payload.to === "string" ? payload.to : null);
        assignee = typeof payload.to === "string" ? payload.to : null;
      } else if (
        row.type === "state_changed" ||
        row.type === "priority_changed" ||
        row.type === "commented"
      ) {
        historicalAssignee.set(row.id, assignee);
      }
    }
  }

  const relevant = visibleRows.filter((row) => {
    if (row.actor_id === actorId) return false;
    const recipient = historicalAssignee.get(row.id);
    if (row.type === "created" || row.type === "assigned") return recipient === actorId;
    if (row.type === "state_changed" || row.type === "priority_changed") {
      return recipient === actorId;
    }
    return recipient === actorId || mentionsActor(activityBody(row), viewer.name);
  });
  return limit === null ? relevant : relevant.slice(0, limit);
}

export function listInboxActivity(
  db: Database,
  viewer: ViewerRef,
  opts: InboxListOptions = {},
  workspaceId?: string,
): InboxActivityRow[] {
  const limit = Math.min(Math.max(opts.first ?? 50, 1), 100);
  return listInboxActivityInternal(db, viewer, opts, limit, workspaceId);
}

export interface InboxActivityPage {
  rows: InboxActivityRow[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function encodeInboxCursor(row: InboxActivityRow): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id])).toString("base64url");
}

function decodeInboxCursor(cursor: string): [string, string] | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

/** Cursor pagination for the inbox without the legacy 100-item list cap. */
export function listInboxActivityPage(
  db: Database,
  viewer: ViewerRef,
  opts: { first?: number; after?: string | null; includeArchived?: boolean } = {},
  workspaceId?: string,
): InboxActivityPage {
  const first = Math.min(Math.max(opts.first ?? 50, 1), 250);
  const all = listInboxActivityInternal(db, viewer, opts, null, workspaceId);
  let start = 0;
  if (opts.after) {
    const cursor = decodeInboxCursor(opts.after);
    if (!cursor) throw apiError("VALIDATION_FAILED", "Invalid inbox cursor");
    const index = all.findIndex((row) => row.created_at === cursor[0] && row.id === cursor[1]);
    if (index < 0) throw apiError("VALIDATION_FAILED", "Invalid inbox cursor");
    start = index + 1;
  }
  const rows = all.slice(start, start + first);
  return {
    rows,
    hasNextPage: start + rows.length < all.length,
    endCursor: rows.length ? encodeInboxCursor(rows[rows.length - 1]!) : null,
  };
}

export function countUnreadInboxActivity(
  db: Database,
  viewer: ViewerRef,
  workspaceId?: string,
): number {
  return listInboxActivityInternal(
    db,
    viewer,
    { includeArchived: false },
    null,
    workspaceId,
  ).filter((row) => !row.is_read).length;
}

function findInboxActivity(
  db: Database,
  viewer: ViewerRef,
  activityId: string,
  workspaceId?: string,
): InboxActivityRow | undefined {
  return listInboxActivityInternal(db, viewer, { includeArchived: true }, null, workspaceId).find(
    (row) => row.id === activityId,
  );
}

function ensureReceipt(
  db: Database,
  activityId: string,
  actorId: string,
  workspaceId?: string,
): void {
  const activity = db.query("SELECT id FROM activity WHERE id = ?1").get(activityId);
  if (!activity) throw apiError("NOT_FOUND", "Inbox item not found");
  db.query(
    `INSERT INTO inbox_receipts (activity_id, actor_id, read_at, archived_at, workspace_id)
     VALUES (?1, ?2, NULL, NULL, ?3)
     ON CONFLICT(activity_id, actor_id) DO NOTHING`,
  ).run(activityId, actorId, workspaceId ?? null);
}

export function markInboxRead(
  db: Database,
  activityId: string,
  viewer: ViewerRef,
  workspaceId?: string,
): InboxActivityRow {
  const actorId = viewerId(viewer);
  // Validar pertenencia/relevancia antes de crear el receipt evita escrituras
  // huérfanas cuando el id es una actividad ajena o ya no corresponde al inbox.
  if (!findInboxActivity(db, viewer, activityId, workspaceId)) {
    throw apiError("NOT_FOUND", "Inbox item not found");
  }
  db.transaction(() => {
    ensureReceipt(db, activityId, actorId, workspaceId);
    db.query(
      `UPDATE inbox_receipts SET read_at = COALESCE(read_at, ?3)
       WHERE activity_id = ?1 AND actor_id = ?2${workspaceId ? " AND workspace_id = ?4" : ""}`,
    ).run(
      ...(workspaceId ? [activityId, actorId, now(), workspaceId] : [activityId, actorId, now()]),
    );
  })();
  const row = findInboxActivity(db, viewer, activityId, workspaceId);
  if (!row) throw apiError("NOT_FOUND", "Inbox item not found");
  return row;
}

export function archiveInboxItem(
  db: Database,
  activityId: string,
  viewer: ViewerRef,
  workspaceId?: string,
): InboxActivityRow {
  const actorId = viewerId(viewer);
  if (!findInboxActivity(db, viewer, activityId, workspaceId)) {
    throw apiError("NOT_FOUND", "Inbox item not found");
  }
  db.transaction(() => {
    ensureReceipt(db, activityId, actorId, workspaceId);
    const timestamp = now();
    db.query(
      `UPDATE inbox_receipts
       SET archived_at = ?3, read_at = COALESCE(read_at, ?3)
       WHERE activity_id = ?1 AND actor_id = ?2${workspaceId ? " AND workspace_id = ?4" : ""}`,
    ).run(
      ...(workspaceId
        ? [activityId, actorId, timestamp, workspaceId]
        : [activityId, actorId, timestamp]),
    );
  })();
  const row = findInboxActivity(db, viewer, activityId, workspaceId);
  if (!row) throw apiError("NOT_FOUND", "Inbox item not found");
  return row;
}
