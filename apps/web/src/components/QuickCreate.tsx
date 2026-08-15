// Modal de creación rápida de issues (tecla C) — AT-148.
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
  const actors = useQuery<{ actors: Array<{ id: string; name: string; type: string }> }>(
    "{ actors { id name type } }",
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (!title.trim() || !teamId || submitting) return;
    setSubmitting(true);
    const input: Record<string, unknown> = { teamId, title: title.trim(), priority };
    if (description.trim()) input.description = description;
    if (assigneeId) input.assigneeId = assigneeId;
    try {
      const data = await mutate<{ issueCreate: { issue: { identifier: string } } }>(
        `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) { issue { identifier } }
        }`, { input });
      onClose();
      navigate(`/issue/${data.issueCreate.issue.identifier}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-body">
          <div style={{ display: "flex", gap: 8 }}>
            <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.key}</option>)}
            </select>
            <input
              style={{ flex: 1 }}
              autoFocus
              placeholder="Issue title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
            />
          </div>
          <textarea
            placeholder="Description… (markdown, optional)"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => (event.metaKey || event.ctrlKey) && event.key === "Enter" && submit()}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <select value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
              {PRIORITY_NAMES.map((name, index) => (
                <option key={name} value={index}>{name}</option>
              ))}
            </select>
            <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
              <option value="">Unassigned</option>
              {(actors.data?.actors ?? []).map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.name}{actor.type === "AGENT" ? " (agent)" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submit} disabled={submitting}>Create issue</button>
        </div>
      </div>
    </div>
  );
}
