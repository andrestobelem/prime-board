// Vista de proyecto (AT-149): header con estado/lead/fecha y la lista de issues.
import { mutate, useQuery } from "../api.ts";
import { navigate } from "../router.tsx";
import { Avatar } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { IssueList, type IssueListItem } from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";

const PROJECT_QUERY = `query($id: ID!, $filter: IssueFilter) {
  project(id: $id) {
    id name description state targetDate
    lead { id name type }
    milestones { id name targetDate progress }
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
      milestones: Array<{ id: string; name: string; targetDate: string | null; progress: number }>;
    } | null;
    issues: { nodes: IssueListItem[] };
  }>(PROJECT_QUERY, { id: projectId, filter: { project: { eq: projectId } } });

  const milestoneSections = (project: any, issues: IssueListItem[]) => ({
    groups: project.milestones.map((milestone: any) => ({
      milestone,
      items: issues.filter((issue: any) => issue.milestone?.id === milestone.id),
    })),
    orphans: issues.filter((issue: any) => !issue.milestone),
  });

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
          <button
            className="btn secondary"
            style={{ marginLeft: "auto" }}
            onClick={async () => {
              await mutate(`mutation($id: ID!) { projectArchive(id: $id) { success } }`, { id: project.id });
              navigate("/");
            }}
          >
            Archive
          </button>
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
      {project.milestones.length === 0 ? (
        <IssueList issues={result.data!.issues.nodes} />
      ) : (
        (() => {
          const { groups, orphans } = milestoneSections(project, result.data!.issues.nodes);
          return (
            <>
              {groups.map(({ milestone, items }: any) => (
                <div key={milestone.id}>
                  <div className="state-group-header" style={{ background: "var(--bg-sidebar)" }}>
                    <Icon name="milestone" title="Milestone" /> {milestone.name}
                    <span className="count">{Math.round(milestone.progress * 100)}%</span>
                    {milestone.targetDate && (
                      <span className="count" style={{ marginLeft: "auto" }}>{milestone.targetDate}</span>
                    )}
                  </div>
                  <IssueList issues={items} />
                </div>
              ))}
              {orphans.length > 0 && (
                <div>
                  <div className="state-group-header" style={{ background: "var(--bg-sidebar)" }}>
                    Sin milestone <span className="count">{orphans.length}</span>
                  </div>
                  <IssueList issues={orphans} />
                </div>
              )}
            </>
          );
        })()
      )}
    </div>
  );
}
