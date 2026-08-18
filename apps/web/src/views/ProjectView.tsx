// Vista de proyecto (AT-149): header con estado/lead/fecha y la lista de issues.
import { useEffect, useState } from "react";
import { gql, mutate, useQuery } from "../api.ts";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState.tsx";
import { navigate } from "../router.tsx";
import { Avatar } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { EntityModal } from "../components/EntityModal.tsx";
import { IssueList, IssueListLimitNotice, type IssueListItem } from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";

const PROJECT_QUERY = `query($id: ID!, $filter: IssueFilter, $after: String) {
  project(id: $id) {
    id name description state targetDate
    lead { id name type }
    milestones { id name targetDate progress }
    updates { id health body risks createdAt author { id name type } }
  }
  issues(filter: $filter, first: 250, after: $after) {
    nodes { ${ISSUE_LIST_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const STATE_COLORS: Record<string, string> = {
  BACKLOG: "#8a8f98",
  PLANNED: "#8a8f98",
  STARTED: "#f2c94c",
  PAUSED: "#fc7840",
  COMPLETED: "#5e6ad2",
  CANCELED: "#5c6067",
};

export function ProjectView({ projectId }: { projectId: string }) {
  const [updateOpen, setUpdateOpen] = useState(false);
  const [extraIssues, setExtraIssues] = useState<IssueListItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    endCursor: null as string | null,
  });

  const result = useQuery<{
    project: {
      id: string;
      name: string;
      description: string | null;
      state: string;
      targetDate: string | null;
      lead: { id: string; name: string; type: string } | null;
      milestones: Array<{ id: string; name: string; targetDate: string | null; progress: number }>;
      updates: Array<{
        id: string;
        health: string;
        body: string;
        risks: string | null;
        createdAt: string;
        author: { id: string; name: string; type: string };
      }>;
    } | null;
    issues: {
      nodes: IssueListItem[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(PROJECT_QUERY, { id: projectId, filter: { project: { eq: projectId } } });

  useEffect(() => {
    setExtraIssues([]);
    if (result.data?.issues.pageInfo) setPageInfo(result.data.issues.pageInfo);
  }, [result.data]);

  async function loadMore(): Promise<void> {
    if (loadingMore || !pageInfo.hasNextPage || !pageInfo.endCursor) return;
    setLoadingMore(true);
    try {
      const next = await gql<any>(PROJECT_QUERY, {
        id: projectId,
        filter: { project: { eq: projectId } },
        after: pageInfo.endCursor,
      });
      setExtraIssues((current) => [...current, ...next.issues.nodes]);
      setPageInfo(next.issues.pageInfo);
    } finally {
      setLoadingMore(false);
    }
  }

  async function postUpdate(values: Record<string, string>) {
    const body = values.body?.trim();
    if (!body) throw new Error("Summary is required");
    await mutate(
      `mutation($input: ProjectUpdateCreateInput!) {
      projectUpdateCreate(input: $input) { projectUpdate { id } }
    }`,
      {
        input: {
          projectId,
          health: values.health || "ON_TRACK",
          body,
          risks: values.risks?.trim() || null,
        },
      },
    );
    setUpdateOpen(false);
  }

  const milestoneSections = (project: any, issues: IssueListItem[]) => ({
    groups: project.milestones.map((milestone: any) => ({
      milestone,
      items: issues.filter((issue: any) => issue.milestone?.id === milestone.id),
    })),
    orphans: issues.filter((issue: any) => !issue.milestone),
  });

  if (result.loading && !result.data) return <LoadingState />;
  if (result.error) return <ErrorState message={result.error.message} onRetry={result.refetch} />;
  const project = result.data?.project;
  if (!project) return <EmptyState title="Project not found" />;

  const issues = [...result.data!.issues.nodes, ...extraIssues];

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
            onClick={() => setUpdateOpen(true)}
          >
            Post update
          </button>
          <button
            className="btn secondary"
            onClick={async () => {
              await mutate(`mutation($id: ID!) { projectArchive(id: $id) { success } }`, {
                id: project.id,
              });
              navigate("/");
            }}
          >
            Archive
          </button>
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: 8,
            color: "var(--text-muted)",
            fontSize: 12,
            alignItems: "center",
          }}
        >
          {project.lead && (
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Avatar actor={project.lead} /> Lead: {project.lead.name}
            </span>
          )}
          {project.targetDate && <span>Target: {project.targetDate}</span>}
          <span>{issues.length} issues</span>
        </div>
        {project.description && (
          <p style={{ color: "var(--text-muted)", margin: "10px 0 0", maxWidth: 640 }}>
            {project.description}
          </p>
        )}
      </div>
      {project.updates.length > 0 && (
        <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <div className="section" style={{ padding: "8px 24px" }}>
            Updates
          </div>
          {project.updates.map((update) => (
            <div
              key={update.id}
              style={{
                padding: "12px 24px",
                borderTop: "1px solid var(--border-subtle)",
                fontSize: 13,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <Avatar actor={update.author} />
                <strong>{update.author.name}</strong>
                <span className="label-chip">{update.health.toLowerCase().replace(/_/g, " ")}</span>
                <span style={{ marginLeft: "auto", color: "var(--text-faint)", fontSize: 12 }}>
                  {update.createdAt.slice(0, 10)}
                </span>
              </div>
              <div>{update.body}</div>
              {update.risks && (
                <div style={{ color: "var(--text-muted)", marginTop: 4 }}>
                  Risks: {update.risks}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <IssueListLimitNotice
        hasNextPage={pageInfo.hasNextPage}
        loading={loadingMore}
        onLoadMore={() => void loadMore()}
      />
      {project.milestones.length === 0 ? (
        <IssueList issues={issues} />
      ) : (
        (() => {
          const { groups, orphans } = milestoneSections(project, issues);
          return (
            <>
              {groups.map(({ milestone, items }: any) => (
                <div key={milestone.id}>
                  <div className="state-group-header" style={{ background: "var(--bg-sidebar)" }}>
                    <Icon name="milestone" title="Milestone" /> {milestone.name}
                    <span className="count">{Math.round(milestone.progress * 100)}%</span>
                    {milestone.targetDate && (
                      <span className="count" style={{ marginLeft: "auto" }}>
                        {milestone.targetDate}
                      </span>
                    )}
                  </div>
                  <IssueList issues={items} />
                </div>
              ))}
              {orphans.length > 0 && (
                <div>
                  <div className="state-group-header" style={{ background: "var(--bg-sidebar)" }}>
                    No milestone <span className="count">{orphans.length}</span>
                  </div>
                  <IssueList issues={orphans} />
                </div>
              )}
            </>
          );
        })()
      )}
      {updateOpen && (
        <EntityModal
          title="Post project update"
          submitLabel="Post update"
          fields={[
            { key: "body", label: "Summary", type: "textarea", placeholder: "What changed?" },
            {
              key: "health",
              label: "Health",
              type: "select",
              value: "ON_TRACK",
              options: [
                { value: "ON_TRACK", label: "On track" },
                { value: "AT_RISK", label: "At risk" },
                { value: "OFF_TRACK", label: "Off track" },
              ],
            },
            { key: "risks", label: "Risks", type: "textarea", placeholder: "Optional" },
          ]}
          onClose={() => setUpdateOpen(false)}
          onSubmit={postUpdate}
        />
      )}
    </div>
  );
}
