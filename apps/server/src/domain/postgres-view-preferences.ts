import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import {
  DEFAULT_VIEW_COLUMNS,
  type ViewLayout,
  type ViewPreferenceScope,
  type ViewPreferences,
  type ViewPreferencesInput,
  type ViewPreferencesRow,
  type ViewType,
  mapViewPreferences,
} from "./view-preferences.ts";

const VIEW_TYPES = new Set<ViewType>(["issue", "project", "initiative", "feed"]);
const LAYOUTS = new Set<ViewLayout>(["list", "board"]);
const ORDER_BY_VALUES = new Set(["CREATED_ASC", "CREATED_DESC", "UPDATED_ASC", "UPDATED_DESC"]);
const GROUP_BY_VALUES = new Set(["state", "milestone", "assignee", "priority"]);

function parseColumns(
  columns: unknown,
  fallback: readonly string[] = DEFAULT_VIEW_COLUMNS,
): string {
  if (columns === undefined || columns === null) return JSON.stringify(fallback);
  if (!Array.isArray(columns) || columns.some((column) => typeof column !== "string")) {
    throw apiError("VALIDATION_FAILED", "View preference columns must be a string array");
  }
  return JSON.stringify(columns);
}

function viewType(value: unknown): ViewType {
  const normalized = value === undefined || value === null ? "issue" : String(value).toLowerCase();
  if (!VIEW_TYPES.has(normalized as ViewType)) {
    throw apiError("VALIDATION_FAILED", `Invalid view type: ${String(value)}`);
  }
  return normalized as ViewType;
}

function preferenceScope(value: unknown): ViewPreferenceScope {
  const normalized = value === undefined || value === null ? "actor" : String(value).toLowerCase();
  if (normalized !== "actor" && normalized !== "workspace") {
    throw apiError("VALIDATION_FAILED", `Invalid view preference scope: ${String(value)}`);
  }
  return normalized;
}

function layout(value: unknown, fallback: ViewLayout = "list"): ViewLayout {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).toLowerCase();
  if (!LAYOUTS.has(normalized as ViewLayout)) {
    throw apiError("VALIDATION_FAILED", `Invalid view layout: ${String(value)}`);
  }
  return normalized as ViewLayout;
}

function orderBy(value: unknown, fallback = "UPDATED_DESC"): string {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).toUpperCase();
  if (!ORDER_BY_VALUES.has(normalized)) {
    throw apiError("VALIDATION_FAILED", `Invalid view orderBy: ${String(value)}`);
  }
  return normalized;
}

function groupBy(value: unknown, fallback = "state"): string {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).toLowerCase();
  if (!GROUP_BY_VALUES.has(normalized)) {
    throw apiError("VALIDATION_FAILED", `Invalid view groupBy: ${String(value)}`);
  }
  return normalized;
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
    throw apiError("UNAUTHORIZED", "View preferences require an active Workspace membership");
  }
}

async function rows(
  persistence: Persistence | PersistenceTransaction,
  workspaceId: string,
): Promise<ViewPreferencesRow[]> {
  return (await persistence.many<ViewPreferencesRow>(
    "SELECT * FROM view_preferences WHERE workspace_id = $1",
    [workspaceId],
  )) as ViewPreferencesRow[];
}

function matches(
  row: ViewPreferencesRow,
  actorId: string,
  viewId: string | null,
  type: ViewType,
  scope: ViewPreferenceScope,
): boolean {
  return (
    row.view_type === type &&
    row.view_id === viewId &&
    row.scope === scope &&
    (scope === "workspace" ? row.actor_id === null : row.actor_id === actorId)
  );
}

async function persisted(
  persistence: Persistence | PersistenceTransaction,
  workspaceId: string,
  actorId: string,
  viewId: string | null,
  type: ViewType,
  scope: ViewPreferenceScope,
): Promise<ViewPreferencesRow | null> {
  const all = await rows(persistence, workspaceId);
  return all.find((row) => matches(row, actorId, viewId, type, scope)) ?? null;
}

function fallbackRow(
  workspaceId: string,
  viewId: string | null,
  type: ViewType,
): ViewPreferencesRow {
  const timestamp = now();
  return {
    id: null,
    workspace_id: workspaceId,
    view_id: viewId,
    actor_id: null,
    view_type: type,
    scope: "workspace",
    layout: "list",
    order_by: "UPDATED_DESC",
    group_by: "state",
    columns_json: JSON.stringify(DEFAULT_VIEW_COLUMNS),
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function getEffectivePostgresViewPreferences(
  persistence: Persistence,
  workspaceId: string,
  actorId: string,
  viewId: string | null = null,
  typeValue: unknown = "issue",
): Promise<ViewPreferencesRow> {
  await assertActiveMembership(persistence, workspaceId, actorId);
  const type = viewType(typeValue);
  const candidates: Array<ViewPreferencesRow | null> = [];
  if (viewId !== null) {
    candidates.push(await persisted(persistence, workspaceId, actorId, viewId, type, "actor"));
    candidates.push(await persisted(persistence, workspaceId, actorId, viewId, type, "workspace"));
  }
  candidates.push(await persisted(persistence, workspaceId, actorId, null, type, "actor"));
  candidates.push(await persisted(persistence, workspaceId, actorId, null, type, "workspace"));
  return (
    candidates.find((candidate): candidate is ViewPreferencesRow => candidate !== null) ??
    fallbackRow(workspaceId, viewId, type)
  );
}

export async function updatePostgresViewPreferences(
  persistence: Persistence,
  workspaceId: string,
  actorId: string,
  input: ViewPreferencesInput,
): Promise<ViewPreferencesRow> {
  await assertActiveMembership(persistence, workspaceId, actorId);
  const type = viewType(input.viewType);
  const scope = preferenceScope(input.scope);
  if (scope === "workspace") {
    const membership = await persistence.one<{ role: string }>(
      `SELECT role FROM workspace_memberships
       WHERE workspace_id = $1 AND actor_id = $2 AND status = 'active'`,
      [workspaceId, actorId],
    );
    if (membership?.role !== "admin") {
      throw apiError("UNAUTHORIZED", "Workspace admin permission is required");
    }
  }
  const viewId = input.viewId ?? null;
  const existing = await persisted(persistence, workspaceId, actorId, viewId, type, scope);
  const current = existing ?? fallbackRow(workspaceId, viewId, type);
  const columnsJson = parseColumns(input.columns, JSON.parse(current.columns_json) as string[]);
  const values: SqlValue[] = [
    layout(input.layout, current.layout),
    orderBy(input.orderBy, current.order_by),
    groupBy(input.groupBy, current.group_by),
    columnsJson,
    now(),
  ];
  if (existing) {
    const updated = await persistence.one<ViewPreferencesRow>(
      `UPDATE view_preferences
       SET layout = $1, order_by = $2, group_by = $3, columns_json = $4, updated_at = $5
       WHERE workspace_id = $6 AND id = $7
       RETURNING *`,
      [...values, workspaceId, existing.id],
    );
    if (!updated) throw new Error("View preference update returned no row");
    return updated;
  }
  const id = newId();
  const timestamp = now();
  await persistence.execute(
    `INSERT INTO view_preferences
     (id, workspace_id, view_id, actor_id, view_type, scope, layout, order_by, group_by, columns_json, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
    [
      id,
      workspaceId,
      viewId,
      scope === "actor" ? actorId : null,
      type,
      scope,
      values[0]!,
      values[1]!,
      values[2]!,
      values[3]!,
      timestamp,
    ],
  );
  const result = await persisted(persistence, workspaceId, actorId, viewId, type, scope);
  if (!result) throw new Error("View preference insert returned no row");
  return result;
}

export function mapPostgresViewPreferences(row: ViewPreferencesRow): ViewPreferences {
  return mapViewPreferences(row);
}
