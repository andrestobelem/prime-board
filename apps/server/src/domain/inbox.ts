// Inbox del actor autenticado (PRB-202/210).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { now } from "../db/util.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { canAccessTeam } from "../auth/permissions.ts";
import type { ActivityRow } from "./activity.ts";

export interface InboxActivityRow extends ActivityRow {
  workspace_id: string | null;
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

/** Las filas legacy con NULL solo son visibles con un único Workspace. */
function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

/** Resuelve el scope de Inbox antes de leer o escribir cualquier receipt. */
function resolveWorkspaceScope(db: Database, workspaceId?: string): string | undefined {
  const workspaces = (db.query("SELECT id FROM workspace ORDER BY id").values() as unknown[][]).map(
    (row) => row[0] as string,
  );
  if (workspaceId) {
    if (!workspaces.includes(workspaceId)) {
      throw apiError("NOT_FOUND", "Workspace is not initialized");
    }
    return workspaceId;
  }
  if (workspaces.length > 1) {
    throw apiError("NOT_FOUND", "Inbox requires a Workspace context");
  }
  return workspaces[0];
}

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
  const scope = resolveWorkspaceScope(db, workspaceId);
  const viewer = resolveViewer(db, viewerRef);
  if (!viewer) return [];
  const actorId = viewer.id;

  // La asignación efectiva del issue no alcanza para decidir la relevancia de
  // un evento histórico: una transferencia posterior no debe borrar una
  // notificación que todavía no fue leída. Recuperamos todos los eventos que
  // pueden alimentar el inbox y reconstruimos el assignee al momento de cada
  // evento a partir del log append-only.
  const workspaceCondition = scope
    ? `AND ${workspaceClause("a.workspace_id", "?3")}
         AND ${workspaceClause("i.workspace_id", "?3")}`
    : "";
  const receiptCondition = scope ? `AND ${workspaceClause("r.workspace_id", "?3")}` : "";
  const rowsQuery = `SELECT a.*,
              i.assignee_id AS issue_assignee_id,
              i.team_id AS issue_team_id,
              i.workspace_id AS workspace_id,
              CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END AS is_read,
              CASE WHEN r.archived_at IS NOT NULL THEN 1 ELSE 0 END AS is_archived
       FROM activity a
       JOIN issues i ON i.id = a.issue_id
       LEFT JOIN inbox_receipts r
         ON r.activity_id = a.id AND r.actor_id = ?1 ${receiptCondition}
       WHERE (?2 = 1 OR r.archived_at IS NULL)
         ${workspaceCondition}
         AND a.type IN ('created', 'assigned', 'commented', 'state_changed', 'priority_changed', 'subscribed', 'unsubscribed')
       ORDER BY a.created_at DESC, a.id DESC`;
  const rows = (
    scope
      ? db.query(rowsQuery).all(actorId, includeArchived ? 1 : 0, scope)
      : db.query(rowsQuery).all(actorId, includeArchived ? 1 : 0)
  ) as InboxActivityRow[];
  const visibleRows = rows.filter((row) => canAccessTeam(db, viewer, row.issue_team_id));

  const historicalAssignee = new Map<string, string | null>();
  const historicalSubscribers = new Map<string, Set<string>>();
  const byIssue = new Map<string, InboxActivityRow[]>();
  for (const row of visibleRows) {
    const issueRows = byIssue.get(row.issue_id) ?? [];
    issueRows.push(row);
    byIssue.set(row.issue_id, issueRows);
  }
  const currentSubscribers = new Map<string, Set<string>>();
  const subscriberQuery = scope
    ? `SELECT issue_id, actor_id FROM issue_subscribers WHERE ${workspaceClause("workspace_id", "?1")}`
    : "SELECT issue_id, actor_id FROM issue_subscribers";
  for (const row of db.query(subscriberQuery).all(...(scope ? [scope] : [])) as Array<{
    issue_id: string;
    actor_id: string;
  }>) {
    const subscribers = currentSubscribers.get(row.issue_id) ?? new Set<string>();
    subscribers.add(row.actor_id);
    currentSubscribers.set(row.issue_id, subscribers);
  }
  for (const issueRows of byIssue.values()) {
    issueRows.sort((a, b) =>
      a.created_at === b.created_at
        ? a.id.localeCompare(b.id)
        : a.created_at.localeCompare(b.created_at),
    );
    let assignee: string | null = null;
    let sawCreated = false;
    const hasSubscriptionHistory = issueRows.some(
      (row) => row.type === "subscribed" || row.type === "unsubscribed",
    );
    const subscribers = hasSubscriptionHistory
      ? new Set<string>()
      : new Set(currentSubscribers.get(issueRows[0]!.issue_id) ?? []);
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
      if (row.type === "subscribed" || row.type === "unsubscribed") {
        const subscriber = payload.actorId;
        if (typeof subscriber === "string") {
          if (row.type === "subscribed") subscribers.add(subscriber);
          else subscribers.delete(subscriber);
        }
      } else {
        historicalSubscribers.set(row.id, new Set(subscribers));
      }
    }
  }

  const relevant = visibleRows.filter((row) => {
    if (row.actor_id === actorId) return false;
    if (row.type === "subscribed" || row.type === "unsubscribed") return false;
    const recipient = historicalAssignee.get(row.id);
    const subscribed = historicalSubscribers.get(row.id)?.has(actorId) ?? false;
    if (row.type === "created" || row.type === "assigned") {
      return recipient === actorId || subscribed;
    }
    if (row.type === "state_changed" || row.type === "priority_changed") {
      return recipient === actorId || subscribed;
    }
    return recipient === actorId || subscribed || mentionsActor(activityBody(row), viewer.name);
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
  const query = workspaceId
    ? `SELECT id FROM activity WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT id FROM activity WHERE id = ?1";
  const activity = workspaceId
    ? db.query(query).get(activityId, workspaceId)
    : db.query(query).get(activityId);
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
  const scope = resolveWorkspaceScope(db, workspaceId);
  // Validar pertenencia/relevancia antes de crear el receipt evita escrituras
  // huérfanas cuando el id es una actividad ajena o ya no corresponde al inbox.
  if (!findInboxActivity(db, viewer, activityId, scope)) {
    throw apiError("NOT_FOUND", "Inbox item not found");
  }
  db.transaction(() => {
    ensureReceipt(db, activityId, actorId, scope);
    const query = scope
      ? `UPDATE inbox_receipts SET read_at = COALESCE(read_at, ?3)
         WHERE activity_id = ?1 AND actor_id = ?2 AND ${workspaceClause("workspace_id", "?4")}`
      : `UPDATE inbox_receipts SET read_at = COALESCE(read_at, ?3)
         WHERE activity_id = ?1 AND actor_id = ?2`;
    if (scope) db.query(query).run(activityId, actorId, now(), scope);
    else db.query(query).run(activityId, actorId, now());
  })();
  const row = findInboxActivity(db, viewer, activityId, scope);
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
  const scope = resolveWorkspaceScope(db, workspaceId);
  if (!findInboxActivity(db, viewer, activityId, scope)) {
    throw apiError("NOT_FOUND", "Inbox item not found");
  }
  db.transaction(() => {
    ensureReceipt(db, activityId, actorId, scope);
    const timestamp = now();
    const query = scope
      ? `UPDATE inbox_receipts
         SET archived_at = ?3, read_at = COALESCE(read_at, ?3)
         WHERE activity_id = ?1 AND actor_id = ?2 AND ${workspaceClause("workspace_id", "?4")}`
      : `UPDATE inbox_receipts
         SET archived_at = ?3, read_at = COALESCE(read_at, ?3)
         WHERE activity_id = ?1 AND actor_id = ?2`;
    if (scope) db.query(query).run(activityId, actorId, timestamp, scope);
    else db.query(query).run(activityId, actorId, timestamp);
  })();
  const row = findInboxActivity(db, viewer, activityId, scope);
  if (!row) throw apiError("NOT_FOUND", "Inbox item not found");
  return row;
}
