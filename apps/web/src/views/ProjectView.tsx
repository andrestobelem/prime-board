// Vista de proyecto (AT-149): header con estado/lead/fecha y la lista de issues.
import { useEffect, useState } from "react";
import { gql, mutate, useQuery } from "../api.ts";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState.tsx";
import { navigate } from "../router.tsx";
import { Avatar } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { ConfirmModal, EntityModal } from "../components/EntityModal.tsx";
import { IssueList, IssueListLimitNotice, type IssueListItem } from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";

const PROJECT_QUERY = `query($id: ID!, $filter: IssueFilter, $after: String) {
  project(id: $id) {
    id name description state targetDate
    lead { id name type }
    teams { id name }
    milestones { id name description targetDate progress position }
    updates { id health body risks createdAt author { id name type } }
  }
  actors { id name type }
  issues(filter: $filter, first: 250, after: $after) {
    nodes { ${ISSUE_LIST_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

function formatProjectDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

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
  const [editProjectOpen, setEditProjectOpen] = useState(false);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [milestoneTarget, setMilestoneTarget] = useState<any | null>(null);
  const [milestoneDelete, setMilestoneDelete] = useState<any | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
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
      teams: Array<{ id: string; name: string }>;
      milestones: Array<{
        id: string;
        name: string;
        description: string | null;
        targetDate: string | null;
        progress: number;
        position: number;
      }>;
      updates: Array<{
        id: string;
        health: string;
        body: string;
        risks: string | null;
        createdAt: string;
        author: { id: string; name: string; type: string };
      }>;
    } | null;
    actors: Array<{ id: string; name: string; type: string }>;
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

  async function updateProject(values: Record<string, string>) {
    const name = values.name?.trim();
    if (!name) throw new Error("Name is required");
    await mutate(
      `mutation($id: ID!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success } }`,
      {
        id: projectId,
        input: {
          name,
          description: values.description ?? "",
          state: values.state,
          leadId: values.leadId || null,
          targetDate: values.targetDate ? new Date(values.targetDate).toISOString() : null,
        },
      },
    );
    setEditProjectOpen(false);
  }

  async function saveMilestone(values: Record<string, string>) {
    const name = values.name?.trim();
    if (!name) throw new Error("Milestone name is required");
    const input = {
      name,
      description: values.description ?? "",
      targetDate: values.targetDate ? new Date(values.targetDate).toISOString() : null,
    };
    if (milestoneTarget) {
      await mutate(
        `mutation($id: ID!, $input: MilestoneUpdateInput!) { milestoneUpdate(id: $id, input: $input) { success } }`,
        { id: milestoneTarget.id, input },
      );
    } else {
      await mutate(
        `mutation($input: MilestoneCreateInput!) { milestoneCreate(input: $input) { success } }`,
        { input: { ...input, projectId } },
      );
    }
    setMilestoneOpen(false);
    setMilestoneTarget(null);
  }

  async function deleteMilestone() {
    if (!milestoneDelete) return;
    await mutate(`mutation($id: ID!) { milestoneDelete(id: $id) { success } }`, {
      id: milestoneDelete.id,
    });
    setMilestoneDelete(null);
  }

  async function moveMilestone(milestone: any, direction: -1 | 1) {
    const index = project?.milestones.findIndex((item: any) => item.id === milestone.id) ?? -1;
    const target = project?.milestones[index + direction];
    if (!target) return;
    await Promise.all([
      mutate(
        `mutation($id: ID!, $input: MilestoneUpdateInput!) { milestoneUpdate(id: $id, input: $input) { success } }`,
        { id: milestone.id, input: { position: target.position } },
      ),
      mutate(
        `mutation($id: ID!, $input: MilestoneUpdateInput!) { milestoneUpdate(id: $id, input: $input) { success } }`,
        { id: target.id, input: { position: milestone.position } },
      ),
    ]);
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
  const projectTargetDate = formatProjectDate(project.targetDate);

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
            onClick={() => setEditProjectOpen(true)}
          >
            Edit overview
          </button>
          <button className="btn secondary" onClick={() => setUpdateOpen(true)}>
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
          {projectTargetDate && <span>Target: {projectTargetDate}</span>}
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
                  {formatProjectDate(update.createdAt)}
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
                    <span className="milestone-actions">
                      <button
                        className="icon-action"
                        aria-label={`Edit milestone ${milestone.name}`}
                        onClick={() => {
                          setMilestoneTarget(milestone);
                          setMilestoneOpen(true);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="icon-action"
                        aria-label={`Move ${milestone.name} up`}
                        onClick={() => void moveMilestone(milestone, -1)}
                      >
                        ↑
                      </button>
                      <button
                        className="icon-action"
                        aria-label={`Move ${milestone.name} down`}
                        onClick={() => void moveMilestone(milestone, 1)}
                      >
                        ↓
                      </button>
                      <button
                        className="icon-action danger"
                        aria-label={`Delete milestone ${milestone.name}`}
                        onClick={() => setMilestoneDelete(milestone)}
                      >
                        ×
                      </button>
                    </span>
                    {formatProjectDate(milestone.targetDate) && (
                      <span className="count" style={{ marginLeft: "auto" }}>
                        {formatProjectDate(milestone.targetDate)}
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
      {editProjectOpen && (
        <EntityModal
          title="Edit project overview"
          submitLabel="Save"
          fields={[
            { key: "name", label: "Name", value: project.name },
            {
              key: "description",
              label: "Description",
              type: "textarea",
              value: project.description ?? "",
            },
            {
              key: "state",
              label: "State",
              type: "select",
              value: project.state,
              options: ["BACKLOG", "PLANNED", "STARTED", "PAUSED", "COMPLETED", "CANCELED"].map(
                (value) => ({ value, label: value.toLowerCase() }),
              ),
            },
            {
              key: "leadId",
              label: "Lead",
              type: "select",
              value: project.lead?.id ?? "",
              options: [
                { value: "", label: "No lead" },
                ...(result.data?.actors ?? []).map((actor) => ({
                  value: actor.id,
                  label: actor.name,
                })),
              ],
            },
            {
              key: "targetDate",
              label: "Target date",
              type: "date",
              value: project.targetDate?.slice(0, 10) ?? "",
            },
          ]}
          onClose={() => setEditProjectOpen(false)}
          onSubmit={updateProject}
        />
      )}
      {milestoneOpen && (
        <EntityModal
          title={milestoneTarget ? "Edit milestone" : "New milestone"}
          submitLabel="Save"
          fields={[
            { key: "name", label: "Name", value: milestoneTarget?.name ?? "" },
            {
              key: "description",
              label: "Description",
              type: "textarea",
              value: milestoneTarget?.description ?? "",
            },
            {
              key: "targetDate",
              label: "Target date",
              type: "date",
              value: milestoneTarget?.targetDate?.slice(0, 10) ?? "",
            },
          ]}
          onClose={() => {
            setMilestoneOpen(false);
            setMilestoneTarget(null);
          }}
          onSubmit={saveMilestone}
        />
      )}
      {milestoneDelete && (
        <ConfirmModal
          title="Delete milestone"
          message={`Delete milestone “${milestoneDelete.name}”? Issues will become unassigned.`}
          confirmLabel="Delete"
          onClose={() => setMilestoneDelete(null)}
          onConfirm={deleteMilestone}
        />
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
