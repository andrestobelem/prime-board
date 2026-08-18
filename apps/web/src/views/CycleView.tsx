// Vista de ciclo (PRB-203): issues asignados al ciclo.
import { useEffect, useRef, useState } from "react";
import { gql, GqlError, mutate, useQuery } from "../api.ts";
import {
  IssueList,
  IssueListLimitNotice,
  type GroupBy,
  type IssueListItem,
} from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";
import { appendUniqueById } from "../pagination.ts";
import { canManageCycle } from "../permissions.ts";

const META_QUERY = `query($id: ID!) {
  cycle(id: $id) {
    id name number state startsAt endsAt progress completedIssues totalIssues
    team { id key name memberships { actorId role } }
  }
  viewer { id workspaceRole }
}`;

const ISSUES_QUERY = `query($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 250, after: $after, orderBy: UPDATED_DESC) {
    nodes { ${ISSUE_LIST_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function CycleView({ cycleId, groupBy = "state" }: { cycleId: string; groupBy?: GroupBy }) {
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [extraIssues, setExtraIssues] = useState<IssueListItem[]>([]);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    endCursor: null as string | null,
  });
  const meta = useQuery<{
    viewer: { id: string; workspaceRole: string };
    cycle: {
      id: string;
      name: string;
      number: number;
      state: string;
      startsAt: string;
      endsAt: string;
      progress: number;
      completedIssues: number;
      totalIssues: number;
      team: {
        id: string;
        key: string;
        name: string;
        memberships: Array<{ actorId: string; role: string }>;
      };
    } | null;
  }>(META_QUERY, { id: cycleId });

  const cycle = meta.data?.cycle ?? null;
  const filter = cycle ? { cycle: { eq: cycle.id } } : { search: "__no_cycle__" };
  const pageKey = JSON.stringify({ cycleId: cycle?.id ?? null, filter });
  const pageKeyRef = useRef(pageKey);
  if (pageKeyRef.current !== pageKey) pageKeyRef.current = pageKey;
  const list = useQuery<{
    issues: {
      nodes: IssueListItem[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(ISSUES_QUERY, { filter });

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
    if (loadingMore || !pageInfo.hasNextPage || !pageInfo.endCursor || !cycle) return;
    const requestKey = pageKey;
    setLoadingMore(true);
    setPageError(null);
    try {
      const next = await gql<{
        issues: {
          nodes: IssueListItem[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(ISSUES_QUERY, { filter, after: pageInfo.endCursor });
      if (pageKeyRef.current !== requestKey) return;
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

  const canManage = Boolean(
    cycle && meta.data?.viewer && canManageCycle(meta.data.viewer, cycle.team),
  );

  async function setState(state: string) {
    if (!cycle || !canManage) return;
    setError(null);
    setActionLoading(true);
    try {
      await mutate(
        `mutation($id: ID!, $state: CycleState!) {
        cycleUpdate(id: $id, input: { state: $state }) { cycle { id state } }
      }`,
        { id: cycle.id, state },
      );
    } catch (err) {
      setError(err instanceof GqlError ? err.message : String(err));
    } finally {
      setActionLoading(false);
    }
  }

  if (meta.loading && !meta.data) return <div className="loading">Loading…</div>;
  if (meta.error) return <div className="error-banner">{meta.error.message}</div>;
  if (!cycle) return <div className="empty">Cycle not found.</div>;

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
        <strong style={{ fontSize: 15 }}>{cycle.name}</strong>
        <span className="label-chip">#{cycle.number}</span>
        <span className="label-chip">{cycle.state.toLowerCase()}</span>
        <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
          {cycle.startsAt.slice(0, 10)} → {cycle.endsAt.slice(0, 10)}· {cycle.completedIssues}/
          {cycle.totalIssues}({Math.round(cycle.progress * 100)}%)
        </span>
        {canManage ? (
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {cycle.state !== "ACTIVE" && (
              <button
                className="btn secondary"
                onClick={() => void setState("ACTIVE")}
                disabled={actionLoading}
              >
                {actionLoading ? "Saving…" : "Start"}
              </button>
            )}
            {cycle.state !== "COMPLETED" && (
              <button
                className="btn secondary"
                onClick={() => void setState("COMPLETED")}
                disabled={actionLoading}
              >
                {actionLoading ? "Saving…" : "Complete"}
              </button>
            )}
          </span>
        ) : (
          <span className="label-chip" role="status">
            Read-only · team owner permission required
          </span>
        )}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
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
      {list.loading && !list.data ? (
        <div className="loading">Loading…</div>
      ) : list.error ? (
        <div className="error-banner">{list.error.message}</div>
      ) : appendUniqueById(list.data?.issues.nodes ?? [], extraIssues).length === 0 ? (
        <div className="empty">No issues in this cycle.</div>
      ) : (
        <IssueList
          issues={appendUniqueById(list.data?.issues.nodes ?? [], extraIssues)}
          groupBy={groupBy}
        />
      )}
    </div>
  );
}
