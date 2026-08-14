// Detalle de issue (AT-147): edición inline de título/descripción (markdown),
// panel de propiedades, sub-issues, comentarios e historial de actividad.
import { marked } from "marked";
import { useEffect, useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { Avatar, LabelChip, PRIORITY_NAMES, StateDot } from "../components/bits.tsx";
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
    project { id name }
    comments { id body actor { name type } createdAt }
    activity { id type actor { name type } payload createdAt }
  }
  actors { id name type }
}`;

function Markdown({ text }: { text: string }) {
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: marked.parse(text, { async: false }) }}
    />
  );
}

const ACTIVITY_TEXT: Record<string, (payload: any) => string> = {
  created: () => "created the issue",
  title_changed: () => "changed the title",
  description_changed: () => "updated the description",
  state_changed: () => "changed the state",
  priority_changed: (payload) =>
    `set priority to ${PRIORITY_NAMES[payload.to] ?? payload.to}`,
  assigned: () => "changed the assignee",
  parent_changed: () => "changed the parent",
  project_changed: () => "changed the project",
  labeled: (payload) => `added label "${payload.label}"`,
  unlabeled: (payload) => `removed label "${payload.label}"`,
  commented: () => "commented",
  archived: () => "archived the issue",
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
    mutate(`mutation($id: ID!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`, { id: issue.id, input });

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
    await mutate(`mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { comment { id } }
    }`, { input: { issueId: issue.id, body } });
  }

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
                <button className="btn" onClick={saveDescription}>Save</button>
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
                <StateDot state={child.state} />
                <Link to={`/issue/${child.identifier}`}>
                  <span style={{ color: "var(--text-faint)", marginRight: 6 }}>{child.identifier}</span>
                  {child.title}
                </Link>
              </div>
            ))}
          </>
        )}

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
            <button className="btn" onClick={submitComment}>Comment</button>
          </div>
        </div>

        <div className="section-title">Activity</div>
        {issue.activity.map((entry: any) => (
          <div className="activity-item" key={entry.id}>
            <span className="who">{entry.actor.name}{entry.actor.type === "AGENT" ? " 🤖" : ""}</span>
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
              <option key={state.id} value={state.id}>{state.name}</option>
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
              <option key={name} value={index}>{name}</option>
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
                {actor.name}{actor.type === "AGENT" ? " 🤖" : ""}
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
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </div>
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
