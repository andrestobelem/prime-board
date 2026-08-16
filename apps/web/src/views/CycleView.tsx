// Vista de ciclo (PRB-203): issues asignados al ciclo.
import { useState } from "react";
import { GqlError, mutate, useQuery } from "../api.ts";
import { IssueList, type GroupBy, type IssueListItem } from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";

const META_QUERY = `query($id: ID!) {
  cycle(id: $id) {
    id name number state startsAt endsAt progress completedIssues totalIssues
    team { id key name }
  }
}`;

const ISSUES_QUERY = `query($filter: IssueFilter) {
  issues(filter: $filter, first: 250, orderBy: UPDATED_DESC) {
    nodes { ${ISSUE_LIST_FIELDS} }
  }
}`;

export function CycleView({ cycleId, groupBy = "state" }: { cycleId: string; groupBy?: GroupBy }) {
  const [error, setError] = useState<string | null>(null);
  const meta = useQuery<{
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
      team: { id: string; key: string; name: string };
    } | null;
  }>(META_QUERY, { id: cycleId });

  const cycle = meta.data?.cycle ?? null;
  const list = useQuery<{ issues: { nodes: IssueListItem[] } }>(
    ISSUES_QUERY,
    cycle ? { filter: { cycle: { eq: cycle.id } } } : { filter: { search: "__no_cycle__" } },
  );

  async function setState(state: string) {
    if (!cycle) return;
    setError(null);
    try {
      await mutate(
        `mutation($id: ID!, $state: CycleState!) {
        cycleUpdate(id: $id, input: { state: $state }) { cycle { id state } }
      }`,
        { id: cycle.id, state },
      );
    } catch (err) {
      setError(err instanceof GqlError ? err.message : String(err));
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
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {cycle.state !== "ACTIVE" && (
            <button className="btn secondary" onClick={() => setState("ACTIVE")}>
              Start
            </button>
          )}
          {cycle.state !== "COMPLETED" && (
            <button className="btn secondary" onClick={() => setState("COMPLETED")}>
              Complete
            </button>
          )}
        </span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {list.loading && !list.data ? (
        <div className="loading">Loading…</div>
      ) : list.error ? (
        <div className="error-banner">{list.error.message}</div>
      ) : (list.data?.issues.nodes.length ?? 0) === 0 ? (
        <div className="empty">No issues in this cycle.</div>
      ) : (
        <IssueList issues={list.data?.issues.nodes ?? []} groupBy={groupBy} />
      )}
    </div>
  );
}
