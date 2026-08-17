// Detalle de issue (AT-147): edición inline de título/descripción (markdown),
// panel de propiedades, sub-issues, comentarios e historial de actividad.
import { useEffect, useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { Avatar, LabelChip, PRIORITY_NAMES, StateIcon } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { renderMarkdown } from "../markdown.ts";
import { Link, navigate } from "../router.tsx";
import { ConfirmModal } from "../components/EntityModal.tsx";

const ISSUE_NAV_QUERY = `query($teamId: ID) {
  issues(filter: { team: { eq: $teamId } }, first: 250, orderBy: CREATED_DESC) {
    nodes { identifier }
    pageInfo { hasNextPage }
  }
}`;

const ISSUE_QUERY = `query($id: ID!) {
  issue(id: $id) {
    id identifier title description priority url branchName createdAt
    team {
      id key name
      states { id name type color position }
      labels { id name color }
      projects { id name }
      cycles { id name number state }
    }
    state { id name type }
    assignee { id name type }
    creator { id name type }
    cycle { id name number state }
    parent { identifier title }
    children { identifier title state { id name type } }
    labels { id name color }
    project { id name milestones { id name } }
    milestone { id name }
    relations { id type relatedIssue { identifier title state { id name type } } }
    comments { id body actor { name type } createdAt }
    activity { id type actor { name type } payload createdAt }
  }
  actors { id name type }
}`;

function Markdown({ text }: { text: string }) {
  // El HTML ya viene sanitizado por renderMarkdown (ver markdown.ts).
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

// AT-190: state_changed/assigned/project_changed/milestone_changed/parent_changed/cycle_changed
// llegan con nombres reales (no ids) porque el resolver de Activity.payload ya
// los tradujo con el esquema compartido (AT-187) — acá solo se arma el texto.
function fromTo(label: string, payload: { from?: string | null; to?: string | null }): string {
  const { from, to } = payload;
  if (from == null && to == null) return `changed ${label}`;
  if (from == null) return `set ${label} to ${to}`;
  if (to == null) return `cleared ${label} (was ${from})`;
  return `changed ${label} from ${from} to ${to}`;
}

const ACTIVITY_TEXT: Record<string, (payload: any) => string> = {
  created: () => "created the issue",
  title_changed: () => "changed the title",
  description_changed: () => "updated the description",
  state_changed: (payload) => fromTo("the state", payload),
  priority_changed: (payload) => `set priority to ${PRIORITY_NAMES[payload.to] ?? payload.to}`,
  assigned: (payload) => fromTo("the assignee", payload),
  parent_changed: (payload) => fromTo("the parent", payload),
  project_changed: (payload) => fromTo("the project", payload),
  milestone_changed: (payload) => fromTo("the milestone", payload),
  cycle_changed: (payload) => fromTo("the cycle", payload),
  sort_order_changed: (payload) => fromTo("the sort order", payload),
  labeled: (payload) => `added label "${payload.label}"`,
  unlabeled: (payload) => `removed label "${payload.label}"`,
  commented: () => "commented",
  archived: () => "archived the issue",
  relation_added: (payload) =>
    `added relation ${RELATION_LABELS[payload.type] ?? payload.type} ${payload.issue}`,
  relation_removed: (payload) =>
    `removed relation ${RELATION_LABELS[payload.type] ?? payload.type} ${payload.issue}`,
};

const RELATION_LABELS: Record<string, string> = {
  BLOCKS: "blocks",
  BLOCKED_BY: "blocked by",
  RELATED: "related to",
  DUPLICATE_OF: "duplicate of",
  DUPLICATED_BY: "duplicated by",
  blocks: "blocks",
  blocked_by: "blocked by",
  related: "related to",
  duplicate_of: "duplicate of",
  duplicated_by: "duplicated by",
};

function timeAgo(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function IssueView({ issueRef }: { issueRef: string }) {
  const result = useQuery<any>(ISSUE_QUERY, { id: issueRef });
  const issue = result.data?.issue;
  const navigation = useQuery<any>(ISSUE_NAV_QUERY, { teamId: issue?.team.id ?? null });
  const navigationIds: string[] =
    navigation.data?.issues.nodes.map((item: any) => item.identifier) ?? [];
  const navigationIndex = navigationIds.indexOf(issueRef);
  const previousIssue = navigationIndex > 0 ? navigationIds[navigationIndex - 1] : null;
  const nextIssue =
    navigationIndex >= 0 && navigationIndex < navigationIds.length - 1
      ? navigationIds[navigationIndex + 1]
      : null;

  const [title, setTitle] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState("");
  const [comment, setComment] = useState("");
  const [relationType, setRelationType] = useState("BLOCKED_BY");
  const [relationRef, setRelationRef] = useState("");
  const [relationError, setRelationError] = useState<string | null>(null);
  const [cycleSaving, setCycleSaving] = useState(false);
  const [cycleError, setCycleError] = useState<string | null>(null);
  const [subIssueTitle, setSubIssueTitle] = useState("");
  const [subIssueSaving, setSubIssueSaving] = useState(false);
  const [subIssueError, setSubIssueError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    if (issue) {
      setTitle(issue.title);
      setDescription(issue.description ?? "");
    }
  }, [issue?.id, issue?.title, issue?.description]);

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  if (!issue) return <div className="empty">Issue {issueRef} not found.</div>;

  async function copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  function copyIssueLink() {
    void copyText(window.location.href);
    setActionsOpen(false);
  }

  const update = (input: Record<string, unknown>) =>
    mutate<{ issueUpdate: { success: boolean } }>(
      `mutation($id: ID!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
      { id: issue.id, input },
    );

  async function runUpdate(input: Record<string, unknown>, notice = "Saved"): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    try {
      const response = await update(input);
      if (!response.issueUpdate.success) throw new Error("The issue could not be updated.");
      setSaveNotice(notice);
      window.setTimeout(() => setSaveNotice(null), 1800);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The issue could not be updated.");
    } finally {
      setSaving(false);
    }
  }

  function saveTitle() {
    const trimmed = title.trim();
    if (trimmed && trimmed !== issue.title) void runUpdate({ title: trimmed });
  }

  function saveDescription() {
    setEditingDescription(false);
    if (description !== (issue.description ?? "")) void runUpdate({ description });
  }

  async function saveCycle(cycleId: string) {
    setCycleSaving(true);
    setCycleError(null);
    try {
      await runUpdate({ cycleId: cycleId || null });
    } catch (error) {
      setCycleError((error as Error).message);
    } finally {
      setCycleSaving(false);
    }
  }

  async function createSubIssue() {
    const trimmed = subIssueTitle.trim();
    if (!trimmed) return;
    setSubIssueSaving(true);
    setSubIssueError(null);
    try {
      await mutate(
        `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { id identifier title } }
      }`,
        { input: { teamId: issue.team.id, parentId: issue.id, title: trimmed, description: "" } },
      );
      setSubIssueTitle("");
      setSaveNotice("Sub-issue created");
    } catch (error) {
      setSubIssueError((error as Error).message);
    } finally {
      setSubIssueSaving(false);
    }
  }

  async function submitComment() {
    const body = comment.trim();
    if (!body) return;
    setSaving(true);
    setSaveError(null);
    try {
      await mutate(
        `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { comment { id } }
      }`,
        { input: { issueId: issue.id, body } },
      );
      setComment("");
      setSaveNotice("Comment added");
      window.setTimeout(() => setSaveNotice(null), 1800);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The comment could not be added.");
    } finally {
      setSaving(false);
    }
  }

  async function addRelation() {
    const ref = relationRef.trim();
    if (!ref) return;
    setRelationError(null);
    try {
      await mutate(
        `mutation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) { success }
      }`,
        { input: { issueId: issue.id, relatedIssueId: ref, type: relationType } },
      );
      setRelationRef("");
      setSaveNotice("Relation added");
    } catch (error) {
      setRelationError((error as Error).message);
    }
  }

  async function removeRelation(relationId: string): Promise<void> {
    try {
      await mutate(`mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`, {
        id: relationId,
      });
      setSaveNotice("Relation removed");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The relation could not be removed.");
    }
  }

  const toggleLabel = (labelId: string, active: boolean) =>
    runUpdate(active ? { removeLabelIds: [labelId] } : { addLabelIds: [labelId] });

  async function archiveIssue(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await mutate<{ issueArchive: { success: boolean } }>(
        `mutation($id: ID!) { issueArchive(id: $id) { success } }`,
        { id: issue.id },
      );
      if (!response.issueArchive.success) throw new Error("The issue could not be archived.");
      navigate(`/team/${issue.team.key}`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The issue could not be archived.");
      throw error;
    } finally {
      setSaving(false);
      setArchiveOpen(false);
    }
  }

  const activeLabelIds = new Set(issue.labels.map((label: any) => label.id));

  return (
    <>
      <div className="issue-detail">
        <div className="issue-main">
          <div className="issue-header">
            <div className="issue-header-id">
              <span className="issue-identifier">{issue.identifier}</span>
              <div className="issue-actions">
                <button
                  className="issue-icon-button"
                  aria-label="Issue actions"
                  aria-expanded={actionsOpen}
                  onClick={() => setActionsOpen((open) => !open)}
                >
                  <Icon name="more" size={16} />
                </button>
                {actionsOpen && (
                  <div className="issue-actions-menu" role="menu">
                    <button role="menuitem" onClick={copyIssueLink}>
                      <Icon name="link" size={14} /> Copy issue link
                    </button>
                    <button role="menuitem" onClick={() => void copyText(issue.identifier)}>
                      <Icon name="copy" size={14} /> Copy identifier
                    </button>
                    <button role="menuitem" className="danger" onClick={() => setArchiveOpen(true)}>
                      <Icon name="archive" size={14} /> Archive issue
                    </button>
                    <Link to={`/team/${issue.team.key}`}>
                      <Icon name="issues" size={14} /> Open in team list
                    </Link>
                  </div>
                )}
              </div>
            </div>
            <div className="issue-header-actions">
              <button
                className="issue-icon-button"
                aria-label="Previous issue"
                disabled={!previousIssue || navigation.loading}
                onClick={() => previousIssue && navigate(`/issue/${previousIssue}`)}
              >
                ‹
              </button>
              <button
                className="issue-icon-button"
                aria-label="Next issue"
                disabled={!nextIssue || navigation.loading}
                onClick={() => nextIssue && navigate(`/issue/${nextIssue}`)}
              >
                ›
              </button>
            </div>
          </div>
          {copied && <span className="copied-hint">Link copied</span>}
          {saveNotice && (
            <div className="save-notice" role="status">
              {saveNotice}
            </div>
          )}
          {saveError && (
            <div className="error-banner" role="alert">
              {saveError}
            </div>
          )}
          {saving && <span className="prop-status">Saving…</span>}
          <input
            className="issue-title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) =>
              event.key === "Enter" && (event.target as HTMLInputElement).blur()
            }
          />

          <div style={{ marginTop: 16 }}>
            {editingDescription ? (
              <div>
                <textarea
                  className="description-editor"
                  autoFocus
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") saveDescription();
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                      saveDescription();
                  }}
                />
                <div className="composer actions" style={{ marginTop: 6 }}>
                  <button className="btn" onClick={saveDescription}>
                    Save
                  </button>
                </div>
              </div>
            ) : issue.description ? (
              <div
                role="button"
                tabIndex={0}
                onClick={() => setEditingDescription(true)}
                onKeyDown={(event) =>
                  (event.key === "Enter" || event.key === " ") && setEditingDescription(true)
                }
                style={{ cursor: "text" }}
              >
                <Markdown text={issue.description} />
              </div>
            ) : (
              <div
                className="description-placeholder"
                role="button"
                tabIndex={0}
                onClick={() => setEditingDescription(true)}
                onKeyDown={(event) =>
                  (event.key === "Enter" || event.key === " ") && setEditingDescription(true)
                }
              >
                Add a description…
              </div>
            )}
          </div>

          <div className="section-title">Sub-issues</div>
          {issue.children.map((child: any) => (
            <div className="sub-issue" key={child.identifier}>
              <StateIcon state={child.state} />
              <Link to={`/issue/${child.identifier}`}>
                <span style={{ color: "var(--text-faint)", marginRight: 6 }}>
                  {child.identifier}
                </span>
                {child.title}
              </Link>
            </div>
          ))}
          <div className="composer" style={{ marginTop: 8 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                placeholder="Create a sub-issue…"
                value={subIssueTitle}
                disabled={subIssueSaving}
                onChange={(event) => setSubIssueTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createSubIssue();
                }}
              />
              <button
                className="btn"
                disabled={subIssueSaving || !subIssueTitle.trim()}
                onClick={() => void createSubIssue()}
              >
                {subIssueSaving ? "Creating…" : "Create"}
              </button>
            </div>
            {subIssueError && <div className="error-banner">{subIssueError}</div>}
          </div>

          <div className="section-title">Relations</div>
          {issue.relations.map((relation: any) => (
            <div className="sub-issue" key={relation.id}>
              <StateIcon state={relation.relatedIssue.state} />
              <span style={{ color: "var(--text-muted)", fontSize: 12, minWidth: 72 }}>
                {RELATION_LABELS[relation.type] ?? relation.type}
              </span>
              <Link to={`/issue/${relation.relatedIssue.identifier}`}>
                <span style={{ color: "var(--text-faint)", marginRight: 6 }}>
                  {relation.relatedIssue.identifier}
                </span>
                {relation.relatedIssue.title}
              </Link>
              <button
                className="btn"
                title="Remove relation"
                aria-label="Remove relation"
                style={{ marginLeft: "auto", padding: "0 6px" }}
                onClick={() => removeRelation(relation.id)}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
            <select value={relationType} onChange={(event) => setRelationType(event.target.value)}>
              <option value="BLOCKED_BY">blocked by</option>
              <option value="BLOCKS">blocks</option>
              <option value="RELATED">related to</option>
              <option value="DUPLICATE_OF">duplicate of</option>
            </select>
            <input
              placeholder="Issue ID, e.g. PB-12"
              value={relationRef}
              onChange={(event) => setRelationRef(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && addRelation()}
              style={{ width: 140 }}
            />
            <button className="btn" onClick={addRelation}>
              Link
            </button>
            {relationError && (
              <span style={{ color: "var(--red, #eb5757)", fontSize: 12 }}>{relationError}</span>
            )}
          </div>

          <div className="section-title">Comments</div>
          {issue.comments.map((entry: any) => (
            <div className="comment" key={entry.id}>
              <div className="meta">
                <Avatar actor={entry.actor} />
                <span className="author">{entry.actor.name}</span>
                <span>{timeAgo(entry.createdAt)}</span>
              </div>
              <Markdown text={entry.body} />
            </div>
          ))}
          <div className="composer">
            <textarea
              placeholder="Leave a comment… (markdown supported, ⌘Enter to send)"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submitComment();
              }}
            />
            <div className="actions">
              <button className="btn" onClick={submitComment}>
                Comment
              </button>
            </div>
          </div>

          <div className="section-title">Activity</div>
          {issue.activity.map((entry: any) => (
            <div className="activity-item" key={entry.id}>
              <span className="who">
                {entry.actor.name}
                {entry.actor.type === "AGENT" && <Icon name="bot" size={12} />}
              </span>
              <span>{(ACTIVITY_TEXT[entry.type] ?? (() => entry.type))(entry.payload)}</span>
              <span style={{ marginLeft: "auto" }}>{timeAgo(entry.createdAt)}</span>
            </div>
          ))}
        </div>

        <div className="issue-props">
          <div className="prop">
            <span className="prop-label">
              <Icon name="check" size={13} /> State
            </span>
            <select
              value={issue.state.id}
              onChange={(event) => void runUpdate({ stateId: event.target.value })}
            >
              {issue.team.states.map((state: any) => (
                <option key={state.id} value={state.id}>
                  {state.name}
                </option>
              ))}
            </select>
          </div>
          <div className="prop">
            <span className="prop-label">
              <Icon name="sort" size={13} /> Priority
            </span>
            <select
              value={issue.priority}
              onChange={(event) => void runUpdate({ priority: Number(event.target.value) })}
            >
              {PRIORITY_NAMES.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="prop">
            <span className="prop-label">
              <Icon name="assignee" size={13} /> Assignee
            </span>
            <select
              value={issue.assignee?.id ?? ""}
              onChange={(event) => void runUpdate({ assigneeId: event.target.value || null })}
            >
              <option value="">Unassigned</option>
              {result.data.actors.map((actor: any) => (
                <option key={actor.id} value={actor.id}>
                  {actor.name}
                  {actor.type === "AGENT" ? " (agent)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="prop">
            <span className="prop-label">
              <Icon name="calendar" size={13} /> Cycle
            </span>
            <select
              value={issue.cycle?.id ?? ""}
              disabled={cycleSaving}
              onChange={(event) => void saveCycle(event.target.value)}
            >
              <option value="">No cycle</option>
              {issue.team.cycles.map((cycle: any) => (
                <option key={cycle.id} value={cycle.id}>
                  {cycle.name} (#{cycle.number})
                </option>
              ))}
            </select>
            {cycleSaving && <span className="prop-status">Saving…</span>}
            {cycleError && <span className="prop-error">{cycleError}</span>}
          </div>
          <div className="prop">
            <span className="prop-label">
              <Icon name="project" size={13} /> Project
            </span>
            <select
              value={issue.project?.id ?? ""}
              onChange={(event) => void runUpdate({ projectId: event.target.value || null })}
            >
              <option value="">No project</option>
              {issue.team.projects.map((project: any) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          {issue.project && issue.project.milestones.length > 0 && (
            <div className="prop">
              <span className="prop-label">
                <Icon name="milestone" size={13} /> Milestone
              </span>
              <select
                value={issue.milestone?.id ?? ""}
                onChange={(event) => void runUpdate({ milestoneId: event.target.value || null })}
              >
                <option value="">No milestone</option>
                {issue.project.milestones.map((milestone: any) => (
                  <option key={milestone.id} value={milestone.id}>
                    {milestone.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="prop">
            <span className="prop-label">
              <Icon name="tag" size={13} /> Labels
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {issue.team.labels.map((label: any) => {
                const active = activeLabelIds.has(label.id);
                return (
                  <button
                    key={label.id}
                    style={{ opacity: active ? 1 : 0.45 }}
                    title={active ? "Remove label" : "Add label"}
                    aria-label={`${active ? "Remove" : "Add"} label ${label.name}`}
                    aria-pressed={active}
                    onClick={() => void toggleLabel(label.id, active)}
                  >
                    <LabelChip label={label} />
                  </button>
                );
              })}
            </div>
          </div>
          {issue.parent && (
            <div className="prop">
              <span className="prop-label">
                <Icon name="link" size={13} /> Parent
              </span>
              <Link to={`/issue/${issue.parent.identifier}`}>
                <span style={{ color: "var(--text-muted)" }}>
                  {issue.parent.identifier} {issue.parent.title}
                </span>
              </Link>
            </div>
          )}
          <div className="prop">
            <span className="prop-label">
              <Icon name="link" size={13} /> Branch
            </span>
            <code style={{ fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all" }}>
              {issue.branchName}
            </code>
          </div>
          <div className="prop">
            <span className="prop-label">
              <Icon name="members" size={13} /> Created by
            </span>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Avatar actor={issue.creator} /> {issue.creator.name}
            </span>
          </div>
        </div>
      </div>
      {archiveOpen && (
        <ConfirmModal
          title="Archive issue"
          message={`Archive ${issue.identifier}? It will leave active issue lists.`}
          confirmLabel="Archive"
          onClose={() => setArchiveOpen(false)}
          onConfirm={archiveIssue}
        />
      )}
    </>
  );
}
