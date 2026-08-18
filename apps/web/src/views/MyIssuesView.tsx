// My issues: cola del actor autenticado con filtros de handoff.
import { useState } from "react";
import { useQuery } from "../api.ts";
import { ErrorState, LoadingState } from "../components/AsyncState.tsx";
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
    pageInfo { hasNextPage endCursor }
  }
}`;
const STATE_TYPES = [
  "",
  "TRIAGE",
  "BACKLOG",
  "UNSTARTED",
  "STARTED",
  "COMPLETED",
  "CANCELED",
] as const;
type Mode = "assigned" | "created" | "subscribed";

export function MyIssuesView({ groupBy = "state" }: { groupBy?: GroupBy }) {
  const [stateType, setStateType] = useState("");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<Mode>("assigned");
  const viewer = useQuery<{ viewer: { id: string; name: string } }>(`{ viewer { id name } }`);
  const meta = useQuery<{ projects: Array<{ id: string; name: string }> }>(
    `{ projects { id name } }`,
  );
  const assigneeId = viewer.data?.viewer.id;
  const ownerFilter = assigneeId
    ? mode === "assigned"
      ? { assignee: { eq: assigneeId } }
      : mode === "created"
        ? { creator: { eq: assigneeId } }
        : { or: [{ assignee: { eq: assigneeId } }, { creator: { eq: assigneeId } }] }
    : { search: "__pending__" };
  const filter: Record<string, unknown> = { ...ownerFilter };
  if (stateType) filter.stateType = { eq: stateType };
  if (projectId) filter.project = { eq: projectId };
  if (priority) filter.priority = { eq: Number(priority) };
  if (search.trim()) filter.search = search.trim();
  const result = useQuery<{
    viewer: { id: string; name: string };
    issues: { nodes: IssueListItem[]; pageInfo: { hasNextPage: boolean } };
  }>(QUERY, { filter });

  if (viewer.loading && !viewer.data) return <LoadingState />;
  if (viewer.error) return <ErrorState message={viewer.error.message} onRetry={viewer.refetch} />;
  if (result.loading && !result.data) return <LoadingState />;
  if (result.error) return <ErrorState message={result.error.message} onRetry={result.refetch} />;
  const nodes = result.data?.issues.nodes ?? [];
  return (
    <div>
      <div className="my-issues-toolbar" aria-label="My issues filters">
        <span style={{ flex: 1 }}>Work queue for {viewer.data?.viewer.name}</span>
        <select
          aria-label="My issues scope"
          value={mode}
          onChange={(event) => setMode(event.target.value as Mode)}
        >
          <option value="assigned">Assigned</option>
          <option value="created">Created</option>
          <option value="subscribed">Subscribed / handoff</option>
        </select>
        <input
          aria-label="Search my issues"
          placeholder="Search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Filter my issues by state"
          value={stateType}
          onChange={(event) => setStateType(event.target.value)}
        >
          <option value="">All states</option>
          {STATE_TYPES.slice(1).map((value) => (
            <option key={value} value={value}>
              {value.toLowerCase()}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter my issues by priority"
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
        >
          <option value="">Any priority</option>
          <option value="1">Urgent</option>
          <option value="2">High</option>
          <option value="3">Medium</option>
          <option value="4">Low</option>
        </select>
        <select
          aria-label="Filter my issues by project"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
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
        <div className="empty">No issues match this work queue.</div>
      ) : (
        <IssueList issues={nodes} groupBy={groupBy} />
      )}
    </div>
  );
}
