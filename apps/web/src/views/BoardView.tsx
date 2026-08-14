// Board por estado con drag & drop nativo y update optimista (AT-146).
import { useEffect, useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { Avatar, LabelChip, PriorityIcon, StateDot } from "../components/bits.tsx";
import type { IssueListItem } from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";
import { navigate } from "../router.tsx";

const BOARD_QUERY = `query($key: String, $filter: IssueFilter) {
  team(key: $key) { id key name states { id name type color position } }
  issues(filter: $filter, first: 250) {
    nodes { ${ISSUE_LIST_FIELDS} }
  }
}`;

interface BoardData {
  team: {
    id: string;
    states: Array<{ id: string; name: string; type: string; color: string; position: number }>;
  } | null;
  issues: { nodes: IssueListItem[] };
}

export function BoardView({ teamKey, teamId }: { teamKey: string; teamId: string | null }) {
  const result = useQuery<BoardData>(BOARD_QUERY, {
    key: teamKey,
    filter: teamId ? { team: { eq: teamId } } : {},
  });
  // Copia local para el update optimista del drag & drop.
  const [local, setLocal] = useState<IssueListItem[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overState, setOverState] = useState<string | null>(null);

  useEffect(() => setLocal(null), [result.data]);

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  if (!result.data?.team) return <div className="empty">Team {teamKey} not found.</div>;

  const issues = local ?? result.data.issues.nodes;
  const states = [...result.data.team.states].sort((a, b) => a.position - b.position);

  function drop(stateId: string) {
    setOverState(null);
    if (!dragId) return;
    const issue = issues.find((candidate) => candidate.id === dragId);
    const target = states.find((candidate) => candidate.id === stateId);
    if (!issue || !target || issue.state.id === stateId) return;
    // Optimista: mueve la card ya; la mutación refetchea al confirmar.
    setLocal(issues.map((candidate) =>
      candidate.id === dragId ? { ...candidate, state: { ...target } } : candidate,
    ));
    mutate(`mutation($id: ID!, $stateId: ID!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`, { id: dragId, stateId }).catch(() => setLocal(null));
    setDragId(null);
  }

  return (
    <div className="board">
      {states.map((state) => {
        const cards = issues
          .filter((issue) => issue.state.id === state.id)
          .sort((a, b) => (a.priority === 0 ? 5 : a.priority) - (b.priority === 0 ? 5 : b.priority));
        return (
          <div
            key={state.id}
            className={`board-column${overState === state.id ? " drag-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOverState(state.id);
            }}
            onDragLeave={() => setOverState((current) => (current === state.id ? null : current))}
            onDrop={() => drop(state.id)}
          >
            <div className="col-header">
              <StateDot state={state} />
              {state.name}
              <span className="count" style={{ color: "var(--text-faint)", fontWeight: 400 }}>
                {cards.length}
              </span>
            </div>
            {cards.map((issue) => (
              <div
                key={issue.id}
                className="board-card"
                draggable
                onDragStart={() => setDragId(issue.id)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverState(null);
                }}
                onClick={() => navigate(`/issue/${issue.identifier}`)}
              >
                <span className="identifier">{issue.identifier}</span>
                <span className="card-title">{issue.title}</span>
                <span className="card-footer">
                  <PriorityIcon priority={issue.priority} />
                  {issue.labels.map((label) => <LabelChip key={label.id} label={label} />)}
                  <span style={{ marginLeft: "auto" }}><Avatar actor={issue.assignee} /></span>
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
