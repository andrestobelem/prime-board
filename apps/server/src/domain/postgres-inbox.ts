// Recibos del inbox sobre persistencia PostgreSQL (PRB-443).
import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { now } from "../db/util.ts";
import { apiError } from "../graphql/errors.ts";
import type { ActorRow } from "../auth/viewer.ts";
import { canDiscoverPostgresTeam, getPostgresTeam } from "./postgres-teams.ts";
import { mapActivity, type ActivityRow } from "./activity.ts";

export interface PostgresInboxActivityRow extends ActivityRow {
  is_read: number;
  is_archived: number;
  issue_assignee_id: string | null;
  issue_team_id: string;
}

export function mapPostgresInboxActivity(
  row: PostgresInboxActivityRow,
  effectiveWorkspaceId: string,
) {
  return {
    ...mapActivity(row, effectiveWorkspaceId),
    workspaceId: row.workspace_id ?? effectiveWorkspaceId,
    issueId: row.issue_id,
    isRead: Boolean(row.is_read),
    isArchived: Boolean(row.is_archived),
  };
}

type InboxListOptions = {
  first?: number;
  includeArchived?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function activityBody(row: PostgresInboxActivityRow): string {
  const body = parsePayload(row.payload).body;
  return typeof body === "string" ? body : "";
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Detecta menciones sin tratar como coincidencia el prefijo de un nombre con guion. */
function mentionsActor(body: string, actorName: string): boolean {
  const name = actorName.trim();
  if (!name) return false;
  const tokenBoundary = "[^\\p{L}\\p{N}_.-]";
  return new RegExp(`(^|${tokenBoundary})@${escapedRegExp(name)}(?=$|${tokenBoundary})`, "iu").test(
    body,
  );
}

function viewerId(viewer: ActorRow): string {
  return viewer.id;
}

function activityRecipient(
  row: PostgresInboxActivityRow,
  assignee: string | null,
  sawCreated: boolean,
): string | null {
  const payload = parsePayload(row.payload);
  const fallback = !sawCreated && row.type !== "created" ? row.issue_assignee_id : assignee;
  if (row.type === "created") {
    if (Object.hasOwn(payload, "assigneeId")) {
      return typeof payload.assigneeId === "string" ? payload.assigneeId : null;
    }
    return row.issue_assignee_id;
  }
  if (row.type === "assigned" || row.type === "assignee_changed") {
    return typeof payload.to === "string" ? payload.to : fallback;
  }
  return fallback;
}

function mapHistoricalRecipients(rows: PostgresInboxActivityRow[]): {
  assignees: Map<string, string | null>;
  subscribers: Map<string, Set<string>>;
} {
  const assignees = new Map<string, string | null>();
  const subscribersByIssue = new Map<string, Set<string>>();
  const byIssue = new Map<string, PostgresInboxActivityRow[]>();
  for (const row of rows) {
    const issueRows = byIssue.get(row.issue_id) ?? [];
    issueRows.push(row);
    byIssue.set(row.issue_id, issueRows);
  }
  for (const issueRows of byIssue.values()) {
    issueRows.sort((left, right) =>
      left.created_at === right.created_at
        ? left.id.localeCompare(right.id)
        : left.created_at.localeCompare(right.created_at),
    );
    let assignee: string | null = null;
    let sawCreated = false;
    const subscribers = new Set<string>();
    for (const row of issueRows) {
      const payload = parsePayload(row.payload);
      if (!sawCreated && row.type !== "created") assignee = row.issue_assignee_id;
      if (row.type === "created") {
        assignee =
          typeof payload.assigneeId === "string" ? payload.assigneeId : row.issue_assignee_id;
        sawCreated = true;
        assignees.set(row.id, assignee);
      } else if (row.type === "assigned" || row.type === "assignee_changed") {
        assignee = typeof payload.to === "string" ? payload.to : assignee;
        assignees.set(row.id, assignee);
      } else if (
        row.type === "state_changed" ||
        row.type === "priority_changed" ||
        row.type === "commented"
      ) {
        assignees.set(row.id, assignee);
      }
      if (row.type === "subscribed" || row.type === "unsubscribed") {
        const subscriber = payload.actorId;
        if (typeof subscriber === "string") {
          if (row.type === "subscribed") subscribers.add(subscriber);
          else subscribers.delete(subscriber);
        }
      } else {
        subscribersByIssue.set(row.id, new Set(subscribers));
      }
    }
  }
  return { assignees, subscribers: subscribersByIssue };
}

function relevantRows(
  rows: PostgresInboxActivityRow[],
  viewer: ActorRow,
): PostgresInboxActivityRow[] {
  const recipients = mapHistoricalRecipients(rows);
  return rows.filter((row) => {
    if (row.actor_id === viewerId(viewer)) return false;
    if (row.type === "subscribed" || row.type === "unsubscribed") return false;
    const assignee = recipients.assignees.get(row.id);
    const subscribed = recipients.subscribers.get(row.id)?.has(viewer.id) ?? false;
    if (
      row.type === "created" ||
      row.type === "assigned" ||
      row.type === "assignee_changed" ||
      row.type === "state_changed" ||
      row.type === "priority_changed"
    ) {
      return assignee === viewer.id || subscribed;
    }
    if (row.type === "commented") {
      return assignee === viewer.id || subscribed || mentionsActor(activityBody(row), viewer.name);
    }
    return false;
  });
}

function addTeamFilter(
  params: SqlValue[],
  allowedTeamIds: readonly string[] | null | undefined,
): string {
  if (allowedTeamIds === undefined || allowedTeamIds === null) return "";
  if (allowedTeamIds.length === 0) return " AND 1 = 0";
  const placeholders = allowedTeamIds.map((teamId) => {
    params.push(teamId);
    return `$${params.length}`;
  });
  return ` AND i.team_id IN (${placeholders.join(", ")})`;
}

async function listInboxActivityInternal(
  persistence: Persistence,
  viewer: ActorRow,
  workspaceId: string,
  opts: InboxListOptions,
  allowedTeamIds?: readonly string[] | null,
): Promise<PostgresInboxActivityRow[]> {
  const params: SqlValue[] = [viewer.id, Boolean(opts.includeArchived), workspaceId];
  const teamFilter = addTeamFilter(params, allowedTeamIds);
  const rows = [
    ...(await persistence.many<PostgresInboxActivityRow>(
      `SELECT a.*,
              i.assignee_id AS issue_assignee_id,
              i.team_id AS issue_team_id,
              CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END AS is_read,
              CASE WHEN r.archived_at IS NOT NULL THEN 1 ELSE 0 END AS is_archived
       FROM activity AS a
       JOIN workspace_memberships AS activity_memberships
         ON activity_memberships.actor_id = a.actor_id
        AND activity_memberships.workspace_id = $3
       JOIN issues AS i
         ON i.id = a.issue_id
        AND i.workspace_id = $3
       LEFT JOIN inbox_receipts AS r
         ON r.activity_id = a.id AND r.actor_id = $1
       WHERE ($2 = TRUE OR r.archived_at IS NULL)
         AND a.type IN ('created', 'assigned', 'assignee_changed', 'commented',
                        'state_changed', 'priority_changed', 'subscribed', 'unsubscribed')${teamFilter}
       ORDER BY a.created_at DESC, a.id DESC`,
      params,
    )),
  ];
  const teams = new Map<string, Awaited<ReturnType<typeof getPostgresTeam>>>();
  for (const row of rows) {
    if (!teams.has(row.issue_team_id)) {
      teams.set(row.issue_team_id, await getPostgresTeam(persistence, { id: row.issue_team_id }));
    }
  }
  const accessibleTeams = new Map<string, boolean>();
  for (const [teamId, team] of teams) {
    accessibleTeams.set(
      teamId,
      Boolean(team && (await canDiscoverPostgresTeam(persistence, viewer, team))),
    );
  }
  return relevantRows(
    rows.filter((row) => accessibleTeams.get(row.issue_team_id) === true),
    viewer,
  );
}

export function encodePostgresInboxCursor(row: PostgresInboxActivityRow): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id])).toString("base64url");
}

function decodePostgresInboxCursor(cursor: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
    return null;
  } catch {
    return null;
  }
}

export async function listPostgresInboxActivity(
  persistence: Persistence,
  viewer: ActorRow,
  workspaceId: string,
  opts: InboxListOptions = {},
  allowedTeamIds?: readonly string[] | null,
): Promise<PostgresInboxActivityRow[]> {
  const limit = Math.min(Math.max(opts.first ?? 50, 1), 100);
  const rows = await listInboxActivityInternal(
    persistence,
    viewer,
    workspaceId,
    opts,
    allowedTeamIds,
  );
  return rows.slice(0, limit);
}

export interface PostgresInboxActivityPage {
  rows: PostgresInboxActivityRow[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export async function listPostgresInboxActivityPage(
  persistence: Persistence,
  viewer: ActorRow,
  workspaceId: string,
  opts: { first?: number; after?: string | null; includeArchived?: boolean | null } = {},
  allowedTeamIds?: readonly string[] | null,
): Promise<PostgresInboxActivityPage> {
  const first = Math.min(Math.max(opts.first ?? 50, 1), 250);
  const all = await listInboxActivityInternal(
    persistence,
    viewer,
    workspaceId,
    { includeArchived: Boolean(opts.includeArchived) },
    allowedTeamIds,
  );
  let start = 0;
  if (opts.after) {
    const cursor = decodePostgresInboxCursor(opts.after);
    if (!cursor) throw apiError("VALIDATION_FAILED", "Invalid inbox cursor");
    const index = all.findIndex((row) => row.created_at === cursor[0] && row.id === cursor[1]);
    if (index < 0) throw apiError("VALIDATION_FAILED", "Invalid inbox cursor");
    start = index + 1;
  }
  const rows = all.slice(start, start + first);
  return {
    rows,
    hasNextPage: start + rows.length < all.length,
    endCursor: rows.length ? encodePostgresInboxCursor(rows[rows.length - 1]!) : null,
  };
}

export async function countPostgresUnreadInboxActivity(
  persistence: Persistence,
  viewer: ActorRow,
  workspaceId: string,
  allowedTeamIds?: readonly string[] | null,
): Promise<number> {
  const rows = await listInboxActivityInternal(
    persistence,
    viewer,
    workspaceId,
    {},
    allowedTeamIds,
  );
  return rows.filter((row) => !row.is_read).length;
}

async function findPostgresInboxActivity(
  persistence: Persistence,
  viewer: ActorRow,
  activityId: string,
  workspaceId: string,
  allowedTeamIds?: readonly string[] | null,
): Promise<PostgresInboxActivityRow | null> {
  const rows = await listInboxActivityInternal(
    persistence,
    viewer,
    workspaceId,
    { includeArchived: true },
    allowedTeamIds,
  );
  return rows.find((row) => row.id === activityId) ?? null;
}

async function ensureReceipt(
  tx: PersistenceTransaction,
  activityId: string,
  actorId: string,
): Promise<void> {
  await tx.execute(
    `INSERT INTO inbox_receipts (activity_id, actor_id, read_at, archived_at)
     SELECT $1, $2, NULL, NULL
     WHERE EXISTS (SELECT 1 FROM activity WHERE id = $1)
     ON CONFLICT (activity_id, actor_id) DO NOTHING`,
    [activityId, actorId],
  );
}

export async function markPostgresInboxRead(
  persistence: Persistence,
  activityId: string,
  viewer: ActorRow,
  workspaceId: string,
  allowedTeamIds?: readonly string[] | null,
): Promise<PostgresInboxActivityRow> {
  if (
    !(await findPostgresInboxActivity(persistence, viewer, activityId, workspaceId, allowedTeamIds))
  ) {
    throw apiError("NOT_FOUND", "Inbox item not found");
  }
  await persistence.transaction(async (tx) => {
    await ensureReceipt(tx, activityId, viewer.id);
    await tx.execute(
      `UPDATE inbox_receipts
       SET read_at = COALESCE(read_at, $3)
       WHERE activity_id = $1 AND actor_id = $2`,
      [activityId, viewer.id, now()],
    );
  });
  const row = await findPostgresInboxActivity(
    persistence,
    viewer,
    activityId,
    workspaceId,
    allowedTeamIds,
  );
  if (!row) throw apiError("NOT_FOUND", "Inbox item not found");
  return row;
}

export async function archivePostgresInboxItem(
  persistence: Persistence,
  activityId: string,
  viewer: ActorRow,
  workspaceId: string,
  allowedTeamIds?: readonly string[] | null,
): Promise<PostgresInboxActivityRow> {
  if (
    !(await findPostgresInboxActivity(persistence, viewer, activityId, workspaceId, allowedTeamIds))
  ) {
    throw apiError("NOT_FOUND", "Inbox item not found");
  }
  await persistence.transaction(async (tx) => {
    await ensureReceipt(tx, activityId, viewer.id);
    const timestamp = now();
    await tx.execute(
      `UPDATE inbox_receipts
       SET archived_at = $3, read_at = COALESCE(read_at, $3)
       WHERE activity_id = $1 AND actor_id = $2`,
      [activityId, viewer.id, timestamp],
    );
  });
  const row = await findPostgresInboxActivity(
    persistence,
    viewer,
    activityId,
    workspaceId,
    allowedTeamIds,
  );
  if (!row) throw apiError("NOT_FOUND", "Inbox item not found");
  return row;
}

export async function postgresInboxTeamId(
  persistence: Persistence | PersistenceTransaction,
  activityId: string,
): Promise<string | null> {
  const row = await persistence.one<{ team_id: string }>(
    `SELECT issues.team_id
       FROM activity
       JOIN issues ON issues.id = activity.issue_id
      WHERE activity.id = $1`,
    [activityId],
  );
  return row?.team_id ?? null;
}
