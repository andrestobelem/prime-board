// Vista guardada (PRB-201): abre el filtro/orden/agrupación persistidos.
import { useEffect, useRef, useState } from "react";
import { ErrorState, LoadingState, EmptyState } from "../components/AsyncState.tsx";
import {
  DisplayOptions,
  ISSUE_COLUMNS,
  type IssueColumn,
  type IssueOrder,
} from "../components/DisplayOptions.tsx";
import { Avatar, LabelChip, PriorityIcon, StateIcon } from "../components/bits.tsx";
import { getVisibleBoardMetadata } from "../board-columns.ts";
import { gql, GqlError, mutate, useQuery } from "../api.ts";
import {
  defaultViewPreferences,
  normalizeViewPreferences,
  viewPreferencesInput,
  type ViewPreferenceState,
} from "../view-preferences.ts";
import { navigate } from "../router.tsx";
import { ConfirmModal } from "../components/EntityModal.tsx";
import { ArchiveConfirmModal } from "../components/ArchiveConfirmModal.tsx";
import {
  IssueList,
  IssueListLimitNotice,
  type GroupBy,
  type IssueListItem,
} from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";
import { appendUniqueById } from "../pagination.ts";

interface ViewPreferencesData {
  layout: string;
  orderBy: string;
  groupBy: string;
  columns: string[];
}

interface SavedViewData {
  id: string;
  name: string;
  scope: string;
  filter: Record<string, unknown>;
  orderBy: string;
  groupBy: string;
  columns: string[];
  preferences: ViewPreferencesData;
  team: { id: string; key: string; name: string } | null;
}

const META_QUERY = `query($id: ID!) {
  savedView(id: $id) {
    id name scope filter orderBy groupBy columns
    preferences { layout orderBy groupBy columns }
    team { id key name }
  }
}`;

const ISSUES_QUERY = `query($filter: IssueFilter, $orderBy: IssueOrder, $after: String) {
  issues(filter: $filter, first: 250, after: $after, orderBy: $orderBy) {
    nodes { ${ISSUE_LIST_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const GROUP_OPTIONS: GroupBy[] = ["state", "milestone", "assignee", "priority"];
const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIssueOrder(value: string): value is IssueOrder {
  return (
    value === "CREATED_ASC" ||
    value === "CREATED_DESC" ||
    value === "UPDATED_ASC" ||
    value === "UPDATED_DESC"
  );
}

function isGroupBy(value: string): value is GroupBy {
  return GROUP_OPTIONS.some((option) => option === value);
}

interface SavedViewBoardGroup {
  key: string;
  label: string;
  order: number;
  state?: IssueListItem["state"];
  issues: IssueListItem[];
}

function boardGroupOf(issue: IssueListItem, groupBy: GroupBy): Omit<SavedViewBoardGroup, "issues"> {
  if (groupBy === "milestone") {
    return issue.milestone
      ? { key: issue.milestone.id, label: issue.milestone.name, order: 0 }
      : { key: "none", label: "No milestone", order: 1 };
  }
  if (groupBy === "assignee") {
    return issue.assignee
      ? { key: issue.assignee.id, label: issue.assignee.name, order: 0 }
      : { key: "none", label: "No assignee", order: 1 };
  }
  if (groupBy === "priority") {
    return {
      key: String(issue.priority),
      label: PRIORITY_LABELS[issue.priority] ?? "No priority",
      order: issue.priority === 0 ? 5 : issue.priority,
    };
  }
  return {
    key: issue.state.id,
    label: issue.state.name,
    order: issue.state.position,
    state: issue.state,
  };
}

function SavedViewBoard({
  issues,
  groupBy,
  visibleColumns,
}: {
  issues: IssueListItem[];
  groupBy: GroupBy;
  visibleColumns: IssueColumn[];
}) {
  const groups = new Map<string, SavedViewBoardGroup>();
  for (const issue of issues) {
    const descriptor = boardGroupOf(issue, groupBy);
    const group = groups.get(descriptor.key) ?? { ...descriptor, issues: [] };
    group.issues.push(issue);
    groups.set(descriptor.key, group);
  }
  const orderedGroups = [...groups.values()].sort(
    (left, right) => left.order - right.order || left.label.localeCompare(right.label),
  );

  return (
    <div className="board" data-saved-view-layout="board" aria-label="Saved view board">
      {orderedGroups.length === 0 ? (
        <div className="empty">No issues yet</div>
      ) : (
        orderedGroups.map((group) => (
          <div className="board-column" key={group.key} aria-label={group.label}>
            <div className="col-header">
              {group.state && <StateIcon state={group.state} />}
              {group.label}
              <span className="count" style={{ color: "var(--text-faint)", fontWeight: 400 }}>
                {group.issues.length}
              </span>
            </div>
            {group.issues
              .slice()
              .sort(
                (left, right) =>
                  (left.priority === 0 ? 5 : left.priority) -
                  (right.priority === 0 ? 5 : right.priority),
              )
              .map((issue) => {
                const metadata = getVisibleBoardMetadata(issue, visibleColumns);
                return (
                  <div
                    className="board-card"
                    key={issue.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/issue/${issue.identifier}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate(`/issue/${issue.identifier}`);
                      }
                    }}
                  >
                    <span className="board-card-topline">
                      <span className="identifier">{issue.identifier}</span>
                    </span>
                    <span className="card-title">{issue.title}</span>
                    <span className="card-footer">
                      {visibleColumns.includes("priority") && (
                        <PriorityIcon priority={issue.priority} />
                      )}
                      {visibleColumns.includes("labels") &&
                        issue.labels.map((label) => <LabelChip key={label.id} label={label} />)}
                      {metadata.project && <span className="label-chip">{metadata.project}</span>}
                      {metadata.cycle && <span className="label-chip">{metadata.cycle}</span>}
                      <span style={{ marginLeft: "auto" }}>
                        {visibleColumns.includes("assignee") && <Avatar actor={issue.assignee} />}
                      </span>
                    </span>
                  </div>
                );
              })}
          </div>
        ))
      )}
    </div>
  );
}

export function SavedViewPage({ viewId }: { viewId: string }) {
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [name, setName] = useState("");
  const [filterText, setFilterText] = useState("{}");
  const [orderBy, setOrderBy] = useState<IssueOrder>("UPDATED_DESC");
  const [groupByDraft, setGroupByDraft] = useState<GroupBy>("state");
  const [columns, setColumns] = useState<IssueColumn[]>(["priority", "labels", "assignee"]);
  const [displayPreferences, setDisplayPreferences] = useState<ViewPreferenceState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const meta = useQuery<{ savedView: SavedViewData | null }>(META_QUERY, { id: viewId });
  const view = meta.data?.savedView ?? null;
  const serverPreferences = view
    ? normalizeViewPreferences(view.preferences, defaultViewPreferences())
    : defaultViewPreferences();
  const effectivePreferences = displayPreferences ?? serverPreferences;

  useEffect(() => {
    if (!view) {
      setDisplayPreferences(null);
      return;
    }
    setDisplayPreferences(serverPreferences);
  }, [
    view?.id,
    view?.preferences?.layout,
    view?.preferences?.orderBy,
    view?.preferences?.groupBy,
    view?.preferences?.columns,
  ]);

  const listVariables = view
    ? { filter: view.filter ?? {}, orderBy: effectivePreferences.orderBy }
    : { filter: { search: "__no_view__" } };
  const pageKey = JSON.stringify(listVariables);
  const pageKeyRef = useRef(pageKey);
  if (pageKeyRef.current !== pageKey) pageKeyRef.current = pageKey;
  const [extraIssues, setExtraIssues] = useState<IssueListItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageInfo, setPageInfo] = useState<{
    hasNextPage: boolean;
    endCursor: string | null;
  }>({
    hasNextPage: false,
    endCursor: null,
  });
  const list = useQuery<{
    issues: {
      nodes: IssueListItem[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(ISSUES_QUERY, listVariables);

  useEffect(() => {
    setExtraIssues([]);
    setLoadingMore(false);
    setPageError(null);
    setPageInfo({ hasNextPage: false, endCursor: null });
  }, [pageKey, list.data?.issues]);

  useEffect(() => {
    if (list.data?.issues.pageInfo) setPageInfo(list.data.issues.pageInfo);
  }, [list.data?.issues.pageInfo]);

  async function loadMore(): Promise<void> {
    if (loadingMore || !pageInfo.hasNextPage || !pageInfo.endCursor) return;
    const requestKey = pageKey;
    setLoadingMore(true);
    setPageError(null);
    try {
      const next = await gql<typeof list.data>(ISSUES_QUERY, {
        ...listVariables,
        after: pageInfo.endCursor,
      });
      if (pageKeyRef.current !== requestKey || !next) return;
      setExtraIssues((current) => appendUniqueById(current, next.issues.nodes));
      setPageInfo(next.issues.pageInfo);
    } catch (err) {
      if (pageKeyRef.current === requestKey) {
        setPageError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (pageKeyRef.current === requestKey) setLoadingMore(false);
    }
  }

  async function saveDisplayPreferences(next: ViewPreferenceState): Promise<void> {
    const previous = effectivePreferences;
    setDisplayPreferences(next);
    setError(null);
    try {
      await mutate(
        `mutation($input: ViewPreferencesUpdateInput!) {
          viewPreferencesUpdate(input: $input) { success }
        }`,
        { input: viewPreferencesInput(next, viewId) },
      );
    } catch (err) {
      setDisplayPreferences(previous);
      setError(err instanceof GqlError ? err.message : String(err));
    }
  }

  async function saveMeta() {
    if (!view) return;
    const next = name.trim();
    if (!next) {
      setError("Name is required");
      return;
    }
    setError(null);
    try {
      let parsedFilter: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(filterText);
        if (!isRecord(parsed)) throw new Error("Filter must be an object.");
        parsedFilter = parsed;
      } catch {
        throw new Error("Filter must be valid JSON.");
      }
      const nextPreferences: ViewPreferenceState = {
        ...effectivePreferences,
        orderBy,
        groupBy: groupByDraft,
        columns: [...columns],
      };
      await mutate(
        `mutation($id: ID!, $input: SavedViewUpdateInput!) {
        savedViewUpdate(id: $id, input: $input) { savedView { id name } }
      }`,
        {
          id: view.id,
          input: { name: next, filter: parsedFilter, orderBy, groupBy: groupByDraft, columns },
        },
      );
      await mutate(
        `mutation($input: ViewPreferencesUpdateInput!) {
          viewPreferencesUpdate(input: $input) { success }
        }`,
        { input: viewPreferencesInput(nextPreferences, view.id) },
      );
      setDisplayPreferences(nextPreferences);
      setEditing(false);
    } catch (err) {
      setError(err instanceof GqlError ? err.message : String(err));
    }
  }

  async function remove() {
    if (!view) return;
    await mutate(`mutation($id: ID!) { savedViewDelete(id: $id) { success } }`, { id: view.id });
    setDeleteOpen(false);
    navigate("/");
  }

  async function archiveView(): Promise<void> {
    if (!view) return;
    setError(null);
    try {
      const response = await mutate<{ savedViewUpdate: { success: boolean } }>(
        `mutation($id: ID!) {
          savedViewUpdate(id: $id, input: { archived: true }) { success }
        }`,
        { id: view.id },
      );
      if (!response.savedViewUpdate.success)
        throw new Error("The saved view could not be archived.");
      setArchiveOpen(false);
      navigate("/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "The saved view could not be archived.");
      throw error;
    }
  }

  if (meta.loading && !meta.data) return <LoadingState />;
  if (meta.error) return <ErrorState message={meta.error.message} onRetry={meta.refetch} />;
  if (!view) return <EmptyState title="View not found" />;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {editing ? (
          <div className="saved-view-editor">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              placeholder="View name"
            />
            <textarea
              aria-label="Saved view filter JSON"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              rows={3}
            />
            <select
              value={orderBy}
              onChange={(event) => {
                const value = event.target.value;
                if (isIssueOrder(value)) setOrderBy(value);
              }}
            >
              <option value="UPDATED_DESC">Recently updated</option>
              <option value="CREATED_DESC">Recently created</option>
              <option value="UPDATED_ASC">Least recently updated</option>
              <option value="CREATED_ASC">Oldest first</option>
            </select>
            <select
              value={groupByDraft}
              onChange={(event) => {
                const value = event.target.value;
                if (isGroupBy(value)) setGroupByDraft(value);
              }}
            >
              {GROUP_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  Group by {value}
                </option>
              ))}
            </select>
            <fieldset>
              <legend>Visible properties</legend>
              {ISSUE_COLUMNS.map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={columns.includes(key)}
                    onChange={(event) =>
                      setColumns(
                        event.target.checked
                          ? [...columns, key]
                          : columns.filter((item) => item !== key),
                      )
                    }
                  />{" "}
                  {label}
                </label>
              ))}
            </fieldset>
            <div>
              <button className="btn" onClick={() => void saveMeta()}>
                Save
              </button>{" "}
              <button className="btn secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <strong style={{ fontSize: 15 }}>{view.name}</strong>
            <span className="label-chip">{view.scope.toLowerCase()}</span>
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
              {effectivePreferences.orderBy} · group by {effectivePreferences.groupBy} ·{" "}
              {effectivePreferences.layout.toLowerCase()}
            </span>
            <DisplayOptions
              layout={effectivePreferences.layout}
              groupBy={effectivePreferences.groupBy}
              orderBy={effectivePreferences.orderBy}
              columns={effectivePreferences.columns}
              onLayout={(value) =>
                void saveDisplayPreferences({ ...effectivePreferences, layout: value })
              }
              onGroupBy={(value) =>
                void saveDisplayPreferences({ ...effectivePreferences, groupBy: value })
              }
              onOrderBy={(value) =>
                void saveDisplayPreferences({ ...effectivePreferences, orderBy: value })
              }
              onColumns={(value) =>
                void saveDisplayPreferences({ ...effectivePreferences, columns: value })
              }
            />
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button
                className="btn secondary"
                onClick={() => {
                  setName(view.name);
                  setFilterText(JSON.stringify(view.filter ?? {}, null, 2));
                  setOrderBy(effectivePreferences.orderBy);
                  setGroupByDraft(effectivePreferences.groupBy);
                  setColumns([...effectivePreferences.columns]);
                  setEditing(true);
                  setError(null);
                }}
              >
                Edit
              </button>
              <button
                className="btn secondary"
                onClick={async () => {
                  const data = await mutate<{ savedViewDuplicate: { savedView: { id: string } } }>(
                    `mutation($id: ID!) {
                      savedViewDuplicate(id: $id) { savedView { id } }
                    }`,
                    { id: view.id },
                  );
                  navigate(`/view/${data.savedViewDuplicate.savedView.id}`);
                }}
              >
                Save as new
              </button>
              <button className="btn secondary" onClick={() => setArchiveOpen(true)}>
                Archive
              </button>
              <button
                className="btn secondary"
                style={{ color: "var(--danger)" }}
                onClick={() => setDeleteOpen(true)}
              >
                Delete
              </button>
            </span>
          </>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {list.loading && !list.data ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState message={list.error.message} onRetry={list.refetch} />
      ) : (
        <>
          {pageError && (
            <div className="error-banner" role="alert">
              {pageError}{" "}
              <button className="btn secondary" onClick={() => void loadMore()}>
                Retry
              </button>
            </div>
          )}
          <IssueListLimitNotice
            hasNextPage={pageInfo.hasNextPage}
            loading={loadingMore}
            onLoadMore={() => void loadMore()}
          />
          {effectivePreferences.layout === "BOARD" ? (
            <SavedViewBoard
              issues={appendUniqueById(list.data?.issues.nodes ?? [], extraIssues)}
              groupBy={effectivePreferences.groupBy}
              visibleColumns={effectivePreferences.columns}
            />
          ) : (
            <IssueList
              issues={appendUniqueById(list.data?.issues.nodes ?? [], extraIssues)}
              groupBy={effectivePreferences.groupBy}
              visibleColumns={effectivePreferences.columns}
            />
          )}
        </>
      )}
      {archiveOpen && (
        <ArchiveConfirmModal
          target={{ kind: "saved-view", name: view.name }}
          onClose={() => setArchiveOpen(false)}
          onConfirm={archiveView}
        />
      )}
      {deleteOpen && (
        <ConfirmModal
          title="Delete view"
          message={`Delete view “${view.name}”?`}
          confirmLabel="Delete"
          onClose={() => setDeleteOpen(false)}
          onConfirm={remove}
        />
      )}
    </div>
  );
}
