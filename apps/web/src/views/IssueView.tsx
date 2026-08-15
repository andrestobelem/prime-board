// Detalle de issue (AT-147): edición inline de título/descripción (markdown),
// panel de propiedades, sub-issues, comentarios e historial de actividad.
import { useEffect, useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { Avatar, LabelChip, PRIORITY_NAMES, StateIcon } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";
import { renderMarkdown } from "../markdown.ts";
import { Link } from "../router.tsx";

const ISSUE_QUERY = `query($id: ID!) {
  issue(id: $id) {
    id identifier title description priority url branchName createdAt
    team { id key name states { id name type color position } labels { id name color } projects { id name } }
    state { id name type }
    assignee { id name type }
    creator { id name type }
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

// AT-190: state_changed/assigned/project_changed/milestone_changed/parent_changed
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

  const [title, setTitle] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState("");
  const [comment, setComment] = useState("");
  const [relationType, setRelationType] = useState("BLOCKED_BY");
  const [relationRef, setRelationRef] = useState("");
  const [relationError, setRelationError] = useState<string | null>(null);

  useEffect(() => {
    if (issue) {
      setTitle(issue.title);
      setDescription(issue.description ?? "");
    }
  }, [issue?.id, issue?.title, issue?.description]);

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  if (!issue) return <div className="empty">Issue {issueRef} not found.</div>;

  const update = (input: Record<string, unknown>) =>
    mutate(
      `mutation($id: ID!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
      { id: issue.id, input },
    );

  function saveTitle() {
    const trimmed = title.trim();
    if (trimmed && trimmed !== issue.title) update({ title: trimmed });
  }

  function saveDescription() {
    setEditingDescription(false);
    if (description !== (issue.description ?? "")) update({ description });
  }

  async function submitComment() {
    const body = comment.trim();
    if (!body) return;
    setComment("");
    await mutate(
      `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { comment { id } }
    }`,
      { input: { issueId: issue.id, body } },
    );
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
    } catch (error) {
      setRelationError((error as Error).message);
    }
  }

  const removeRelation = (relationId: string) =>
    mutate(`mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`, { id: relationId });

  const toggleLabel = (labelId: string, active: boolean) =>
    update(active ? { removeLabelIds: [labelId] } : { addLabelIds: [labelId] });

  const activeLabelIds = new Set(issue.labels.map((label: any) => label.id));

  return (
    <div className="issue-detail">
      <div className="issue-main">
        <input
          className="issue-title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
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
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) saveDescription();
                }}
              />
              <div className="composer actions" style={{ marginTop: 6 }}>
                <button className="btn" onClick={saveDescription}>
                  Save
                </button>
              </div>
            </div>
          ) : issue.description ? (
            <div onClick={() => setEditingDescription(true)} style={{ cursor: "text" }}>
              <Markdown text={issue.description} />
            </div>
          ) : (
            <div className="description-placeholder" onClick={() => setEditingDescription(true)}>
              Add a description…
            </div>
          )}
        </div>

        {issue.children.length > 0 && (
          <>
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
          </>
        )}

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
          <span>State</span>
          <select
            value={issue.state.id}
            onChange={(event) => update({ stateId: event.target.value })}
          >
            {issue.team.states.map((state: any) => (
              <option key={state.id} value={state.id}>
                {state.name}
              </option>
            ))}
          </select>
        </div>
        <div className="prop">
          <span>Priority</span>
          <select
            value={issue.priority}
            onChange={(event) => update({ priority: Number(event.target.value) })}
          >
            {PRIORITY_NAMES.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="prop">
          <span>Assignee</span>
          <select
            value={issue.assignee?.id ?? ""}
            onChange={(event) => update({ assigneeId: event.target.value || null })}
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
          <span>Project</span>
          <select
            value={issue.project?.id ?? ""}
            onChange={(event) => update({ projectId: event.target.value || null })}
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
            <span>Milestone</span>
            <select
              value={issue.milestone?.id ?? ""}
              onChange={(event) => update({ milestoneId: event.target.value || null })}
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
          <span>Labels</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {issue.team.labels.map((label: any) => {
              const active = activeLabelIds.has(label.id);
              return (
                <button
                  key={label.id}
                  style={{ opacity: active ? 1 : 0.45 }}
                  title={active ? "Remove label" : "Add label"}
                  onClick={() => toggleLabel(label.id, active)}
                >
                  <LabelChip label={label} />
                </button>
              );
            })}
          </div>
        </div>
        {issue.parent && (
          <div className="prop">
            <span>Parent</span>
            <Link to={`/issue/${issue.parent.identifier}`}>
              <span style={{ color: "var(--text-muted)" }}>
                {issue.parent.identifier} {issue.parent.title}
              </span>
            </Link>
          </div>
        )}
        <div className="prop">
          <span>Branch</span>
          <code style={{ fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all" }}>
            {issue.branchName}
          </code>
        </div>
        <div className="prop">
          <span>Created by</span>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Avatar actor={issue.creator} /> {issue.creator.name}
          </span>
        </div>
      </div>
    </div>
  );
}
