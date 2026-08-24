// Vista de proyecto (AT-149): header con estado/lead/fecha y la lista de issues.
import { useEffect, useMemo, useRef, useState } from "react";
import { gql, mutate, useQuery } from "../api.ts";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState.tsx";
import { Link, navigate } from "../router.tsx";
import { Avatar } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { ConfirmModal, EntityModal } from "../components/EntityModal.tsx";
import { ArchiveConfirmModal } from "../components/ArchiveConfirmModal.tsx";
import { IssueList, IssueListLimitNotice, type IssueListItem } from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";
import { archiveMutation, issueUpdateMutation, runIssueActions } from "../issue-actions.ts";
import type { IssueActionInput, IssueActionOptions } from "../components/IssueActions.tsx";
import { appendUniqueById } from "../pagination.ts";
import { createRequestGate } from "../request-generation.ts";
import { canManageProject } from "../permissions.ts";
import { IssueFilterToolbar } from "../components/IssueFilterToolbar.tsx";
import {
  buildIssueFilter,
  loadIssueFilter,
  saveIssueFilter,
  activeIssueFilterCount,
  EMPTY_ISSUE_FILTER,
  type IssueFilterDraft,
} from "../issue-filter.ts";
import { changedTeamIds, parseTeamIds, serializeTeamIds } from "../project-teams.ts";

const PROJECT_QUERY = `query($id: ID!, $filter: IssueFilter, $after: String) {
  viewer { id workspaceRole }
  project(id: $id) {
    id name description state targetDate
    lead { id name type }
    teams { id name memberships { actorId role } states { id name type color position } labels { id name color } cycles { id name number } }
    milestones { id name description targetDate progress position }
    updates { id health body risks createdAt author { id name type } }
    documents { id title updatedAt archivedAt }
  }
  actors { id name type }
  availableTeams: teams { id name }
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
  BACKLOG: "var(--status-backlog)",
  PLANNED: "var(--status-unstarted)",
  STARTED: "var(--status-started)",
  PAUSED: "var(--status-triage)",
  COMPLETED: "var(--status-completed)",
  CANCELED: "var(--status-canceled)",
};

export function ProjectView({ projectId }: { projectId: string }) {
  const [updateOpen, setUpdateOpen] = useState(false);
  const [editProjectOpen, setEditProjectOpen] = useState(false);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [milestoneTarget, setMilestoneTarget] = useState<any | null>(null);
  const [milestoneDelete, setMilestoneDelete] = useState<any | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [documentTitle, setDocumentTitle] = useState("");
  const [documentContent, setDocumentContent] = useState("");
  const [documentSaving, setDocumentSaving] = useState(false);
  const filterKey = `project-${projectId}`;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [archiveSelection, setArchiveSelection] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<IssueFilterDraft>(() => loadIssueFilter(filterKey));
  useEffect(() => setDraft(loadIssueFilter(filterKey)), [filterKey]);
  useEffect(() => saveIssueFilter(filterKey, draft), [draft, filterKey]);
  const filter = useMemo(
    () => ({ ...buildIssueFilter(null, draft), project: { eq: projectId } }),
    [draft, projectId],
  );
  const [extraIssues, setExtraIssues] = useState<IssueListItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    endCursor: null as string | null,
  });
  const pageGate = useRef(createRequestGate());
  const pageKey = JSON.stringify({ projectId, filter });

  const result = useQuery<{
    viewer: { id: string; workspaceRole: string };
    project: {
      id: string;
      name: string;
      description: string | null;
      state: string;
      targetDate: string | null;
      lead: { id: string; name: string; type: string } | null;
      teams: Array<{
        id: string;
        name: string;
        memberships: Array<{ actorId: string; role: string }>;
        states: Array<{ id: string; name: string; type: string; color: string; position: number }>;
        labels: Array<{ id: string; name: string; color: string }>;
        cycles: Array<{ id: string; name: string; number: number }>;
      }>;
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
      documents: Array<{ id: string; title: string; updatedAt: string; archivedAt: string | null }>;
    } | null;
    actors: Array<{ id: string; name: string; type: string }>;
    availableTeams: Array<{ id: string; name: string }>;
    issues: {
      nodes: IssueListItem[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(PROJECT_QUERY, { id: projectId, filter });

  useEffect(() => {
    const visible = new Set(
      [...(result.data?.issues.nodes ?? []), ...extraIssues].map((issue) => issue.id),
    );
    setSelectedIds((current) => new Set([...current].filter((id) => visible.has(id))));
  }, [extraIssues, result.data]);

  useEffect(() => {
    pageGate.current.next();
    setExtraIssues([]);
    setLoadingMore(false);
    setPageError(null);
    if (result.data?.issues.pageInfo) setPageInfo(result.data.issues.pageInfo);
  }, [pageKey, result.data]);

  async function loadMore(): Promise<void> {
    if (loadingMore || !pageInfo.hasNextPage || !pageInfo.endCursor) return;
    const generation = pageGate.current.next();
    setLoadingMore(true);
    try {
      const next = await gql<any>(PROJECT_QUERY, {
        id: projectId,
        filter,
        after: pageInfo.endCursor,
      });
      if (!pageGate.current.isCurrent(generation)) return;
      setExtraIssues((current) => appendUniqueById(current, next.issues.nodes));
      setPageInfo(next.issues.pageInfo);
    } catch (error) {
      if (pageGate.current.isCurrent(generation)) {
        setPageError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (pageGate.current.isCurrent(generation)) setLoadingMore(false);
    }
  }

  async function updateProject(values: Record<string, string>) {
    if (!canManage) throw new Error("Project team membership is required.");
    const name = values.name?.trim();
    if (!name) throw new Error("Name is required");
    const input: Record<string, unknown> = {
      name,
      description: values.description ?? "",
      state: values.state,
      leadId: values.leadId || null,
      targetDate: values.targetDate ? new Date(values.targetDate).toISOString() : null,
    };
    const nextTeamIds = parseTeamIds(values.teamIds ?? "");
    const teamIds = changedTeamIds(project?.teams.map((team) => team.id) ?? [], nextTeamIds);
    if (teamIds) input.teamIds = teamIds;
    await mutate(
      `mutation($id: ID!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success } }`,
      { id: projectId, input },
    );
    setEditProjectOpen(false);
  }

  async function saveMilestone(values: Record<string, string>) {
    if (!canManage) throw new Error("Project team membership is required.");
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
    if (!canManage || !milestoneDelete) return;
    await mutate(`mutation($id: ID!) { milestoneDelete(id: $id) { success } }`, {
      id: milestoneDelete.id,
    });
    setMilestoneDelete(null);
  }

  async function moveMilestone(milestone: any, direction: -1 | 1) {
    if (!canManage) {
      setProjectError("Project team membership is required.");
      return;
    }
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
    if (!canManage) throw new Error("Project team membership is required.");
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
  const canManage = Boolean(
    result.data?.viewer && canManageProject(result.data.viewer, project.teams),
  );
  const issues = [...result.data!.issues.nodes, ...extraIssues];
  const actors = result.data?.actors ?? [];
  const actionOptions: IssueActionOptions = {
    states: project.teams.flatMap((team) => team.states),
    actors,
    labels: project.teams.flatMap((team) => team.labels),
    projects: [],
    cycles: project.teams.flatMap((team) => team.cycles),
  };
  async function bulkAction(input: IssueActionInput): Promise<void> {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkLoading(true);
    setBulkError(null);
    try {
      await runIssueActions(
        ids,
        async (id) =>
          (
            await mutate<{ issueUpdate: { success: boolean } }>(issueUpdateMutation(), {
              id,
              input,
            })
          ).issueUpdate,
      );
      setSelectedIds(new Set());
    } catch (error) {
      setBulkError(error instanceof Error ? error.message : "Could not update selected issues.");
    } finally {
      setBulkLoading(false);
    }
  }
  async function requestBulkArchive(): Promise<void> {
    if (selectedIds.size) setArchiveSelection([...selectedIds]);
  }
  async function confirmBulkArchive(): Promise<void> {
    const ids = archiveSelection;
    if (!ids?.length) return;
    setBulkLoading(true);
    try {
      await runIssueActions(
        ids,
        async (id) =>
          (await mutate<{ issueArchive: { success: boolean } }>(archiveMutation(), { id }))
            .issueArchive,
      );
      setSelectedIds(new Set());
      setArchiveSelection(null);
    } finally {
      setBulkLoading(false);
    }
  }

  async function updateIssue(id: string, input: IssueActionInput): Promise<void> {
    const response = await mutate<{ issueUpdate: { success: boolean } }>(issueUpdateMutation(), {
      id,
      input,
    });
    if (!response.issueUpdate.success) throw new Error(`Could not update issue ${id}.`);
  }
  async function archiveIssue(id: string): Promise<void> {
    const response = await mutate<{ issueArchive: { success: boolean } }>(archiveMutation(), {
      id,
    });
    if (!response.issueArchive.success) throw new Error(`Could not archive issue ${id}.`);
  }

  async function archiveProject(): Promise<void> {
    if (!canManage) throw new Error("Project team membership is required.");
    setProjectError(null);
    try {
      const response = await mutate<{ projectArchive: { success: boolean } }>(
        `mutation($id: ID!) { projectArchive(id: $id) { success } }`,
        { id: projectId },
      );
      if (!response.projectArchive.success) throw new Error("The project could not be archived.");
      setArchiveOpen(false);
      navigate("/");
    } catch (error) {
      setProjectError(
        error instanceof Error ? error.message : "The project could not be archived.",
      );
      throw error;
    }
  }

  async function createDocument(): Promise<void> {
    const title = documentTitle.trim();
    if (!title) return;
    setDocumentSaving(true);
    try {
      await mutate(
        `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id } } }`,
        { input: { title, content: documentContent, projectId } },
      );
      await result.refetch();
      setDocumentTitle("");
      setDocumentContent("");
    } catch (error) {
      setProjectError(
        error instanceof Error ? error.message : "The document could not be created.",
      );
    } finally {
      setDocumentSaving(false);
    }
  }

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
          {canManage && (
            <>
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
              <button className="btn secondary" onClick={() => setArchiveOpen(true)}>
                Archive
              </button>
            </>
          )}
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
      {archiveOpen && (
        <ArchiveConfirmModal
          target={{ kind: "project", name: project.name }}
          onClose={() => setArchiveOpen(false)}
          onConfirm={archiveProject}
        />
      )}
      {projectError && (
        <div className="error-banner" role="alert">
          {projectError}
        </div>
      )}
      {!canManage && (
        <div className="pagination-notice" role="status">
          Read-only project · membership in an associated team is required to edit it.
        </div>
      )}
      {project.documents.length > 0 && (
        <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <div className="section" style={{ padding: "8px 24px" }}>
            Documents
          </div>
          {project.documents.map((document) => (
            <div className="sub-issue" key={document.id} style={{ padding: "10px 24px" }}>
              <Icon name="file-text" size={14} />
              <Link to={`/document/${document.id}`}>{document.title}</Link>
              <span className="hint" style={{ marginLeft: "auto" }}>
                {formatProjectDate(document.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
      {canManage && (
        <div className="composer" style={{ margin: "12px 24px" }}>
          <input
            placeholder="Document title…"
            value={documentTitle}
            disabled={documentSaving}
            onChange={(event) => setDocumentTitle(event.target.value)}
          />
          <textarea
            placeholder="Document content (markdown)…"
            value={documentContent}
            disabled={documentSaving}
            onChange={(event) => setDocumentContent(event.target.value)}
            rows={3}
          />
          <button
            className="btn"
            disabled={documentSaving || !documentTitle.trim()}
            onClick={() => void createDocument()}
          >
            {documentSaving ? "Creating…" : "Add document"}
          </button>
        </div>
      )}
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
      <IssueFilterToolbar
        draft={draft}
        states={project.teams.flatMap((team) => team.states)}
        actors={actors}
        labels={project.teams.flatMap((team) => team.labels)}
        projects={[]}
        milestones={project.milestones}
        cycles={project.teams.flatMap((team) => team.cycles)}
        parents={issues.flatMap((issue) =>
          issue.parent
            ? [{ id: issue.parent.id, name: `${issue.parent.identifier} ${issue.parent.title}` }]
            : [],
        )}
        visibleCount={issues.length}
        selectedCount={selectedIds.size}
        onChange={setDraft}
        onSelectAll={() =>
          setSelectedIds((current) =>
            current.size === issues.length ? new Set() : new Set(issues.map((issue) => issue.id)),
          )
        }
        onClearSelection={() => setSelectedIds(new Set())}
        onBulkState={(stateId) => bulkAction({ stateId })}
        actionOptions={actionOptions}
        onBulkAction={bulkAction}
        onBulkArchive={requestBulkArchive}
        bulkLoading={bulkLoading}
      />
      {archiveSelection && (
        <ArchiveConfirmModal
          target={{ kind: "issues", count: archiveSelection.length }}
          onClose={() => setArchiveSelection(null)}
          onConfirm={confirmBulkArchive}
        />
      )}
      {bulkError && (
        <div className="error-banner" role="alert">
          {bulkError}
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
      {project.milestones.length === 0 ? (
        <IssueList
          issues={issues}
          selection={{
            selectedIds,
            onToggle: (id) =>
              setSelectedIds((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              }),
            onSelectAll: () => setSelectedIds(new Set(issues.map((issue) => issue.id))),
            onClear: () => setSelectedIds(new Set()),
          }}
          actionOptions={actionOptions}
          onIssueAction={updateIssue}
          onArchiveIssue={archiveIssue}
          onArchiveSelection={requestBulkArchive}
          emptyTitle={
            activeIssueFilterCount(draft) ? "No issues match these filters" : "No issues yet"
          }
          onClearEmpty={() => setDraft(EMPTY_ISSUE_FILTER)}
        />
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
                    {canManage && (
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
                    )}
                    {formatProjectDate(milestone.targetDate) && (
                      <span className="count" style={{ marginLeft: "auto" }}>
                        {formatProjectDate(milestone.targetDate)}
                      </span>
                    )}
                  </div>
                  <IssueList
                    issues={items}
                    selection={{
                      selectedIds,
                      onToggle: (id) =>
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        }),
                      onSelectAll: () => setSelectedIds(new Set(issues.map((issue) => issue.id))),
                      onClear: () => setSelectedIds(new Set()),
                    }}
                    actionOptions={actionOptions}
                    onIssueAction={updateIssue}
                    onArchiveIssue={archiveIssue}
                  />
                </div>
              ))}
              {orphans.length > 0 && (
                <div>
                  <div className="state-group-header" style={{ background: "var(--bg-sidebar)" }}>
                    No milestone <span className="count">{orphans.length}</span>
                  </div>
                  <IssueList
                    issues={orphans}
                    selection={{
                      selectedIds,
                      onToggle: (id) =>
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        }),
                      onSelectAll: () => setSelectedIds(new Set(issues.map((issue) => issue.id))),
                      onClear: () => setSelectedIds(new Set()),
                    }}
                    actionOptions={actionOptions}
                    onIssueAction={updateIssue}
                    onArchiveIssue={archiveIssue}
                  />
                </div>
              )}
            </>
          );
        })()
      )}
      {canManage && editProjectOpen && (
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
            {
              key: "teamIds",
              label: "Teams",
              type: "select",
              multiple: true,
              value: serializeTeamIds(project.teams.map((team) => team.id)),
              options: (result.data?.availableTeams ?? []).map((team) => ({
                value: team.id,
                label: team.name,
              })),
            },
          ]}
          onClose={() => setEditProjectOpen(false)}
          onSubmit={updateProject}
        />
      )}
      {canManage && milestoneOpen && (
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
      {canManage && milestoneDelete && (
        <ConfirmModal
          title="Delete milestone"
          message={`Delete milestone “${milestoneDelete.name}”? Issues will become unassigned.`}
          confirmLabel="Delete"
          onClose={() => setMilestoneDelete(null)}
          onConfirm={deleteMilestone}
        />
      )}
      {canManage && updateOpen && (
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
