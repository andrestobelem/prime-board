// Vista guardada (PRB-201): abre el filtro/orden/agrupación persistidos.
import { useState } from "react";
import { GqlError, mutate, useQuery } from "../api.ts";
import { ConfirmModal } from "../components/EntityModal.tsx";
import {
  IssueList,
  IssueListLimitNotice,
  type GroupBy,
  type IssueListItem,
} from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";

interface SavedViewData {
  id: string;
  name: string;
  scope: string;
  filter: Record<string, unknown>;
  orderBy: string;
  groupBy: string;
  team: { id: string; key: string; name: string } | null;
}

const META_QUERY = `query($id: ID!) {
  savedView(id: $id) {
    id name scope filter orderBy groupBy
    team { id key name }
  }
}`;

const ISSUES_QUERY = `query($filter: IssueFilter, $orderBy: IssueOrder) {
  issues(filter: $filter, first: 250, orderBy: $orderBy) {
    nodes { ${ISSUE_LIST_FIELDS} }
    pageInfo { hasNextPage }
  }
}`;

const GROUP_OPTIONS: GroupBy[] = ["state", "milestone", "assignee", "priority"];

export function SavedViewPage({ viewId }: { viewId: string }) {
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const meta = useQuery<{ savedView: SavedViewData | null }>(META_QUERY, { id: viewId });
  const view = meta.data?.savedView ?? null;

  const list = useQuery<{
    issues: { nodes: IssueListItem[]; pageInfo: { hasNextPage: boolean } };
  }>(
    ISSUES_QUERY,
    view
      ? { filter: view.filter ?? {}, orderBy: view.orderBy }
      : { filter: { search: "__no_view__" } },
  );

  async function saveMeta() {
    if (!view) return;
    const next = name.trim();
    if (!next) {
      setError("Name is required");
      return;
    }
    setError(null);
    try {
      await mutate(
        `mutation($id: ID!, $input: SavedViewUpdateInput!) {
        savedViewUpdate(id: $id, input: $input) { savedView { id name } }
      }`,
        { id: view.id, input: { name: next } },
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
    window.location.hash = "#/";
  }

  if (meta.loading && !meta.data) return <div className="loading">Loading…</div>;
  if (meta.error) return <div className="error-banner">{meta.error.message}</div>;
  if (!view) return <div className="empty">View not found.</div>;

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
          <>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && saveMeta()}
              autoFocus
            />
            <button className="btn" onClick={saveMeta}>
              Save
            </button>
            <button className="btn secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
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
                  window.location.hash = `#/view/${data.savedViewDuplicate.savedView.id}`;
                }}
              >
                Duplicate
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
                  window.location.hash = "#/";
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
        <div className="loading">Loading…</div>
      ) : list.error ? (
        <div className="error-banner">{list.error.message}</div>
      ) : (
        <>
          <IssueListLimitNotice hasNextPage={list.data?.issues.pageInfo.hasNextPage ?? false} />
          <IssueList issues={list.data?.issues.nodes ?? []} groupBy={groupBy} />
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
