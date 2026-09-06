import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";

export type ViewPreferenceScope = "actor" | "workspace";
export type ViewType = "issue" | "project" | "initiative" | "feed";
export type ViewLayout = "list" | "board";

export interface ViewPreferencesRow {
  id: string | null;
  workspace_id: string;
  view_id: string | null;
  actor_id: string | null;
  view_type: ViewType;
  scope: ViewPreferenceScope;
  layout: ViewLayout;
  order_by: string;
  group_by: string;
  columns_json: string;
  created_at: string;
  updated_at: string;
}

export const DEFAULT_VIEW_COLUMNS = ["priority", "labels", "assignee"] as const;
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

function scope(value: unknown): ViewPreferenceScope {
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

function assertActiveMembership(db: Database, workspaceId: string, actorId: string): void {
  const membership = db
    .query(
      `SELECT 1 FROM workspace_memberships
       WHERE workspace_id = ?1 AND actor_id = ?2 AND status = 'active'`,
    )
    .get(workspaceId, actorId);
  if (!membership) {
    throw apiError("UNAUTHORIZED", "View preferences require an active Workspace membership");
  }
}

function rows(db: Database, workspaceId: string): ViewPreferencesRow[] {
  return db
    .query("SELECT * FROM view_preferences WHERE workspace_id = ?1")
    .all(workspaceId) as ViewPreferencesRow[];
}

function persisted(
  db: Database,
  workspaceId: string,
  actorId: string,
  viewId: string | null,
  type: ViewType,
  preferenceScope: ViewPreferenceScope,
): ViewPreferencesRow | null {
  return (
    rows(db, workspaceId).find(
      (row) =>
        row.view_type === type &&
        row.view_id === viewId &&
        row.scope === preferenceScope &&
        (preferenceScope === "workspace" ? row.actor_id === null : row.actor_id === actorId),
    ) ?? null
  );
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

/** Returns the most specific persisted preference without applying Account/UserSettings. */
export function getEffectiveViewPreferences(
  db: Database,
  workspaceId: string,
  actorId: string,
  viewId: string | null = null,
  typeValue: unknown = "issue",
): ViewPreferencesRow {
  assertActiveMembership(db, workspaceId, actorId);
  const type = viewType(typeValue);
  const candidates: Array<ViewPreferencesRow | null> = [];
  if (viewId !== null) {
    candidates.push(persisted(db, workspaceId, actorId, viewId, type, "actor"));
    candidates.push(persisted(db, workspaceId, actorId, viewId, type, "workspace"));
  }
  candidates.push(persisted(db, workspaceId, actorId, null, type, "actor"));
  candidates.push(persisted(db, workspaceId, actorId, null, type, "workspace"));
  return (
    candidates.find((candidate): candidate is ViewPreferencesRow => candidate !== null) ??
    fallbackRow(workspaceId, viewId, type)
  );
}

export interface ViewPreferencesInput {
  viewId?: string | null;
  viewType?: unknown;
  scope?: unknown;
  layout?: unknown;
  orderBy?: unknown;
  groupBy?: unknown;
  columns?: unknown;
}

/** Upserts either the current Actor override or the Workspace default. */
export function updateViewPreferences(
  db: Database,
  workspaceId: string,
  actorId: string,
  input: ViewPreferencesInput,
): ViewPreferencesRow {
  assertActiveMembership(db, workspaceId, actorId);
  const type = viewType(input.viewType);
  const preferenceScope = scope(input.scope);
  if (preferenceScope === "workspace") {
    const membership = db
      .query(
        `SELECT role FROM workspace_memberships
         WHERE workspace_id = ?1 AND actor_id = ?2 AND status = 'active'`,
      )
      .get(workspaceId, actorId) as { role: string } | null;
    if (membership?.role !== "admin") {
      throw apiError("UNAUTHORIZED", "Workspace admin permission is required");
    }
  }
  const viewId = input.viewId ?? null;
  const existing = persisted(db, workspaceId, actorId, viewId, type, preferenceScope);
  const current = existing ?? fallbackRow(workspaceId, viewId, type);
  const next = {
    layout: layout(input.layout, current.layout),
    orderBy: orderBy(input.orderBy, current.order_by),
    groupBy: groupBy(input.groupBy, current.group_by),
    columnsJson: parseColumns(input.columns, JSON.parse(current.columns_json) as string[]),
  };
  const timestamp = now();
  if (existing) {
    db.query(
      `UPDATE view_preferences
       SET layout = ?1, order_by = ?2, group_by = ?3, columns_json = ?4, updated_at = ?5
       WHERE workspace_id = ?6 AND id = ?7`,
    ).run(
      next.layout,
      next.orderBy,
      next.groupBy,
      next.columnsJson,
      timestamp,
      workspaceId,
      existing.id,
    );
  } else {
    const id = newId();
    db.query(
      `INSERT INTO view_preferences
       (id, workspace_id, view_id, actor_id, view_type, scope, layout, order_by, group_by, columns_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    ).run(
      id,
      workspaceId,
      viewId,
      preferenceScope === "actor" ? actorId : null,
      type,
      preferenceScope,
      next.layout,
      next.orderBy,
      next.groupBy,
      next.columnsJson,
      timestamp,
    );
  }
  const result = persisted(db, workspaceId, actorId, viewId, type, preferenceScope);
  if (!result) throw new Error("View preference upsert returned no row");
  return result;
}

export interface ViewPreferences {
  id: string | null;
  workspaceId: string;
  viewId: string | null;
  actorId: string | null;
  viewType: ViewType;
  scope: ViewPreferenceScope;
  layout: ViewLayout;
  orderBy: string;
  groupBy: string;
  columns: string[];
  createdAt: string;
  updatedAt: string;
}

export function mapViewPreferences(row: ViewPreferencesRow): ViewPreferences {
  const parsed = JSON.parse(row.columns_json || "[]");
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    viewId: row.view_id,
    actorId: row.actor_id,
    viewType: row.view_type,
    scope: row.scope,
    layout: row.layout,
    orderBy: row.order_by,
    groupBy: row.group_by,
    columns: Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
