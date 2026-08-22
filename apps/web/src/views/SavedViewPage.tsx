// Vista guardada (PRB-201): abre el filtro/orden/agrupación persistidos.
import { useEffect, useRef, useState } from "react";
import { ErrorState, LoadingState, EmptyState } from "../components/AsyncState.tsx";
import { ISSUE_COLUMNS, type IssueColumn, type IssueOrder } from "../components/DisplayOptions.tsx";
import { gql, GqlError, mutate, useQuery } from "../api.ts";
import { navigate } from "../router.tsx";
import { ConfirmModal } from "../components/EntityModal.tsx";
import {
  IssueList,
  IssueListLimitNotice,
  type GroupBy,
  type IssueListItem,
} from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";
import { appendUniqueById } from "../pagination.ts";

interface SavedViewData {
  id: string;
  name: string;
  scope: string;
  filter: Record<string, unknown>;
  orderBy: string;
  groupBy: string;
  columns: string[];
  team: { id: string; key: string; name: string } | null;
}

const META_QUERY = `query($id: ID!) {
  savedView(id: $id) {
    id name scope filter orderBy groupBy columns
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

export function SavedViewPage({ viewId }: { viewId: string }) {
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState("");
  const [filterText, setFilterText] = useState("{}");
  const [orderBy, setOrderBy] = useState<IssueOrder>("UPDATED_DESC");
  const [groupByDraft, setGroupByDraft] = useState<GroupBy>("state");
  const [columns, setColumns] = useState<IssueColumn[]>(["priority", "labels", "assignee"]);
  const [error, setError] = useState<string | null>(null);

  const meta = useQuery<{ savedView: SavedViewData | null }>(META_QUERY, { id: viewId });
  const view = meta.data?.savedView ?? null;

  const listVariables = view
    ? { filter: view.filter ?? {}, orderBy: view.orderBy }
    : { filter: { search: "__no_view__" } };
  const pageKey = JSON.stringify(listVariables);
  const pageKeyRef = useRef(pageKey);
  if (pageKeyRef.current !== pageKey) pageKeyRef.current = pageKey;
  const [extraIssues, setExtraIssues] = useState<IssueListItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    endCursor: null as string | null,
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
        parsedFilter = JSON.parse(filterText) as Record<string, unknown>;
      } catch {
        throw new Error("Filter must be valid JSON.");
      }
      await mutate(
        `mutation($id: ID!, $input: SavedViewUpdateInput!) {
        savedViewUpdate(id: $id, input: $input) { savedView { id name } }
      }`,
        {
          id: view.id,
          input: { name: next, filter: parsedFilter, orderBy, groupBy: groupByDraft, columns },
        },
      );
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

  if (meta.loading && !meta.data) return <LoadingState />;
  if (meta.error) return <ErrorState message={meta.error.message} onRetry={meta.refetch} />;
  if (!view) return <EmptyState title="View not found" />;

  const groupBy = (
    GROUP_OPTIONS.includes(view.groupBy as GroupBy) ? view.groupBy : "state"
  ) as GroupBy;

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
              onChange={(event) => setOrderBy(event.target.value as IssueOrder)}
            >
              <option value="UPDATED_DESC">Recently updated</option>
              <option value="CREATED_DESC">Recently created</option>
              <option value="UPDATED_ASC">Least recently updated</option>
              <option value="CREATED_ASC">Oldest first</option>
            </select>
            <select
              value={groupByDraft}
              onChange={(event) => setGroupByDraft(event.target.value as GroupBy)}
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
              {view.orderBy} · group by {groupBy}
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button
                className="btn secondary"
                onClick={() => {
                  setName(view.name);
                  setFilterText(JSON.stringify(view.filter ?? {}, null, 2));
                  setOrderBy(view.orderBy as IssueOrder);
                  setGroupByDraft(groupBy);
                  setColumns((view.columns ?? ["priority", "labels", "assignee"]) as IssueColumn[]);
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
              <button
                className="btn secondary"
                onClick={async () => {
                  await mutate(
                    `mutation($id: ID!) {
                    savedViewUpdate(id: $id, input: { archived: true }) { success }
                  }`,
                    { id: view.id },
                  );
                  navigate("/");
                }}
              >
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
          <IssueList
            issues={appendUniqueById(list.data?.issues.nodes ?? [], extraIssues)}
            groupBy={groupBy}
            visibleColumns={(view.columns ?? ["priority", "labels", "assignee"]) as IssueColumn[]}
          />
        </>
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
