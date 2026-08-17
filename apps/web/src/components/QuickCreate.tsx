// Modal para crear issues rápidamente (C).
import { useEffect, useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { PRIORITY_NAMES } from "./bits.tsx";
import { navigate } from "../router.tsx";

interface QuickCreateProps {
  teams: Array<{ id: string; key: string; name: string }>;
  defaultTeamKey?: string;
  onClose: () => void;
}

export function QuickCreate({ teams, defaultTeamKey, onClose }: QuickCreateProps) {
  const [teamId, setTeamId] = useState(
    teams.find((team) => team.key === defaultTeamKey)?.id ?? teams[0]?.id ?? "",
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [assigneeId, setAssigneeId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actors = useQuery<{ actors: Array<{ id: string; name: string; type: string }> }>(
    "{ actors { id name type } }",
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  async function submit(): Promise<void> {
    if (!title.trim() || !teamId || submitting) return;
    setSubmitting(true);
    setError(null);
    const input: Record<string, unknown> = { teamId, title: title.trim(), priority };
    if (description.trim()) input.description = description;
    if (assigneeId) input.assigneeId = assigneeId;
    try {
      const data = await mutate<{ issueCreate: { issue: { identifier: string } } }>(
        `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) { issue { identifier } }
        }`,
        { input },
      );
      onClose();
      navigate(`/issue/${data.issueCreate.issue.identifier}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the issue.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose()}
    >
      <div
        className="modal quick-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-create-title"
        aria-busy={submitting}
      >
        <div className="modal-body">
          <div className="quick-create-heading">
            <div>
              <strong id="quick-create-title">Create issue</strong>
              <p>Capture the next piece of work without leaving your current view.</p>
            </div>
            <kbd>Esc</kbd>
          </div>
          <div className="quick-create-title-row">
            <label className="quick-create-field team-field">
              <span>Team</span>
              <select
                aria-label="Team"
                value={teamId}
                onChange={(event) => setTeamId(event.target.value)}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.key}
                  </option>
                ))}
              </select>
            </label>
            <label className="quick-create-field title-field">
              <span>Title</span>
              <input
                autoFocus
                placeholder="What needs to be done?"
                aria-label="Issue title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void submit()}
              />
            </label>
          </div>
          <label className="quick-create-field">
            <span>
              Description <em>optional</em>
            </span>
            <textarea
              placeholder="Add context, acceptance criteria, or links…"
              aria-label="Issue description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={(event) =>
                (event.metaKey || event.ctrlKey) && event.key === "Enter" && void submit()
              }
            />
          </label>
          <div className="quick-create-options">
            <label className="quick-create-field">
              <span>Priority</span>
              <select
                aria-label="Priority"
                value={priority}
                onChange={(event) => setPriority(Number(event.target.value))}
              >
                {PRIORITY_NAMES.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="quick-create-field">
              <span>Assignee</span>
              <select
                aria-label="Assignee"
                value={assigneeId}
                onChange={(event) => setAssigneeId(event.target.value)}
              >
                <option value="">Unassigned</option>
                {(actors.data?.actors ?? []).map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.name}
                    {actor.type === "AGENT" ? " (agent)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span className="quick-create-hint">
            <kbd>⌘</kbd>
            <kbd>Enter</kbd> to create
          </span>
          <button className="btn secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn"
            onClick={() => void submit()}
            disabled={submitting || !title.trim()}
          >
            {submitting ? "Creating…" : "Create issue"}
          </button>
        </div>
      </div>
    </div>
  );
}
