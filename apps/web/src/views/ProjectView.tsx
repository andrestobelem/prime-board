// Vista de proyecto (AT-149): header con estado/lead/fecha y la lista de issues.
import { useQuery } from "../api.ts";
import { Avatar } from "../components/bits.tsx";
import { IssueList, type IssueListItem } from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";

const PROJECT_QUERY = `query($id: ID!, $filter: IssueFilter) {
  project(id: $id) {
    id name description state targetDate
    lead { id name type }
  }
  issues(filter: $filter, first: 250) {
    nodes { ${ISSUE_LIST_FIELDS} }
  }
}`;

const STATE_COLORS: Record<string, string> = {
  BACKLOG: "#8a8f98", PLANNED: "#8a8f98", STARTED: "#f2c94c",
  PAUSED: "#fc7840", COMPLETED: "#5e6ad2", CANCELED: "#5c6067",
};

export function ProjectView({ projectId }: { projectId: string }) {
  const result = useQuery<{
    project: {
      id: string; name: string; description: string | null; state: string;
      targetDate: string | null; lead: { id: string; name: string; type: string } | null;
    } | null;
    issues: { nodes: IssueListItem[] };
  }>(PROJECT_QUERY, { id: projectId, filter: { project: { eq: projectId } } });

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  const project = result.data?.project;
  if (!project) return <div className="empty">Project not found.</div>;

  return (
    <div>
      <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border-subtle)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>{project.name}</h2>
          <span
            className="label-chip"
            style={{ borderColor: STATE_COLORS[project.state], color: STATE_COLORS[project.state] }}
          >
            {project.state.toLowerCase()}
          </span>
        </div>
        <div style={{
          display: "flex", gap: 16, marginTop: 8,
          color: "var(--text-muted)", fontSize: 12, alignItems: "center",
        }}>
          {project.lead && (
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Avatar actor={project.lead} /> Lead: {project.lead.name}
            </span>
          )}
          {project.targetDate && <span>Target: {project.targetDate}</span>}
          <span>{result.data!.issues.nodes.length} issues</span>
        </div>
        {project.description && (
          <p style={{ color: "var(--text-muted)", margin: "10px 0 0", maxWidth: 640 }}>
            {project.description}
          </p>
        )}
      </div>
      <IssueList issues={result.data!.issues.nodes} />
    </div>
  );
}
