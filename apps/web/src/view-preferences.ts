import type { GroupBy } from "./components/IssueList.tsx";
import type { IssueColumn, IssueOrder } from "./components/DisplayOptions.tsx";

export type ViewLayout = "LIST" | "BOARD";

export interface ViewPreferenceState {
  layout: ViewLayout;
  orderBy: IssueOrder;
  groupBy: GroupBy;
  columns: IssueColumn[];
}

export interface RawViewPreferences {
  layout?: unknown;
  orderBy?: unknown;
  groupBy?: unknown;
  columns?: unknown;
}

export const DEFAULT_VIEW_PREFERENCES: ViewPreferenceState = {
  layout: "LIST",
  orderBy: "UPDATED_DESC",
  groupBy: "state",
  columns: ["priority", "labels", "assignee"],
};

export function isIssueColumn(value: unknown): value is IssueColumn {
  return (
    value === "priority" ||
    value === "labels" ||
    value === "assignee" ||
    value === "project" ||
    value === "cycle"
  );
}

function isLayout(value: unknown): value is ViewLayout {
  return value === "LIST" || value === "BOARD";
}

function isIssueOrder(value: unknown): value is IssueOrder {
  return (
    value === "CREATED_ASC" ||
    value === "CREATED_DESC" ||
    value === "UPDATED_ASC" ||
    value === "UPDATED_DESC"
  );
}

function isGroupBy(value: unknown): value is GroupBy {
  return value === "state" || value === "milestone" || value === "assignee" || value === "priority";
}

function copyDefaults(): ViewPreferenceState {
  return { ...DEFAULT_VIEW_PREFERENCES, columns: [...DEFAULT_VIEW_PREFERENCES.columns] };
}

export function normalizeViewPreferences(
  value: RawViewPreferences | null | undefined,
  fallback: ViewPreferenceState = DEFAULT_VIEW_PREFERENCES,
): ViewPreferenceState {
  const columns = Array.isArray(value?.columns)
    ? value.columns.filter(isIssueColumn)
    : [...fallback.columns];
  return {
    layout: isLayout(value?.layout) ? value.layout : fallback.layout,
    orderBy: isIssueOrder(value?.orderBy) ? value.orderBy : fallback.orderBy,
    groupBy: isGroupBy(value?.groupBy) ? value.groupBy : fallback.groupBy,
    columns,
  };
}

export function viewPreferencesInput(
  preferences: ViewPreferenceState,
  viewId?: string | null,
): Record<string, unknown> {
  return {
    ...(viewId ? { viewId } : {}),
    viewType: "ISSUE",
    scope: "ACTOR",
    layout: preferences.layout,
    orderBy: preferences.orderBy,
    groupBy: preferences.groupBy,
    columns: [...preferences.columns],
  };
}

export function sameViewPreferences(
  left: ViewPreferenceState,
  right: ViewPreferenceState,
): boolean {
  return (
    left.layout === right.layout &&
    left.orderBy === right.orderBy &&
    left.groupBy === right.groupBy &&
    left.columns.length === right.columns.length &&
    left.columns.every((column, index) => column === right.columns[index])
  );
}

export function defaultViewPreferences(): ViewPreferenceState {
  return copyDefaults();
}
