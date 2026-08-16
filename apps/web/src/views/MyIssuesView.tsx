// My issues (PRB-202/218): issues del viewer con filtros estado/proyecto.
import { useState } from "react";
import { useQuery } from "../api.ts";
import {
  IssueList,
  IssueListLimitNotice,
  type GroupBy,
  type IssueListItem,
} from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";

const QUERY = `query($filter: IssueFilter) {
  viewer { id name }
  issues(filter: $filter, first: 250, orderBy: UPDATED_DESC) {
    nodes { ${ISSUE_LIST_FIELDS} }
    pageInfo { hasNextPage }
  }
}`;

const STATE_TYPES = [
  { value: "", label: "All states" },
  { value: "TRIAGE", label: "Triage" },
  { value: "BACKLOG", label: "Backlog" },
  { value: "UNSTARTED", label: "Unstarted" },
  { value: "STARTED", label: "Started" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELED", label: "Canceled" },
] as const;

export function MyIssuesView({ groupBy = "state" }: { groupBy?: GroupBy }) {
  const [stateType, setStateType] = useState("");
  const [projectId, setProjectId] = useState("");

  const viewer = useQuery<{ viewer: { id: string; name: string } }>(`{ viewer { id name } }`);
  const meta = useQuery<{ projects: Array<{ id: string; name: string }> }>(
    `{ projects { id name } }`,
  );
  const assigneeId = viewer.data?.viewer.id ?? null;

  const filter: Record<string, unknown> = assigneeId
    ? { assignee: { eq: assigneeId } }
    : { search: "__pending__" };
  if (assigneeId && stateType) filter.stateType = { eq: stateType };
  if (assigneeId && projectId) filter.project = { eq: projectId };

  const result = useQuery<{
    viewer: { id: string; name: string };
    issues: { nodes: IssueListItem[]; pageInfo: { hasNextPage: boolean } };
  }>(QUERY, { filter });

  if (viewer.loading && !viewer.data) return <div className="loading">Loading…</div>;
  if (viewer.error) return <div className="error-banner">{viewer.error.message}</div>;
  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;

  const nodes = result.data?.issues.nodes ?? [];
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
          color: "var(--text-muted)",
          fontSize: 13,
        }}
      >
        <span style={{ flex: 1 }}>Issues assigned to {viewer.data?.viewer.name}</span>
        <select
          value={stateType}
          onChange={(event) => setStateType(event.target.value)}
          style={{ fontSize: 12 }}
        >
          {STATE_TYPES.map((option) => (
            <option key={option.value || "all"} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          style={{ fontSize: 12, maxWidth: 180 }}
        >
          <option value="">All projects</option>
          {(meta.data?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>
      <IssueListLimitNotice hasNextPage={result.data?.issues.pageInfo.hasNextPage ?? false} />
      {nodes.length === 0 ? (
        <div className="empty">No issues assigned to you.</div>
      ) : (
        <IssueList issues={nodes} groupBy={groupBy} />
      )}
    </div>
  );
}
