// Board por estado con drag & drop nativo y update optimista (AT-146).
import { useEffect, useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { Avatar, LabelChip, PriorityIcon, StateIcon } from "../components/bits.tsx";
import type { GroupBy, IssueListItem } from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";
import { navigate } from "../router.tsx";

const BOARD_QUERY = `query($key: String, $filter: IssueFilter) {
  team(key: $key) {
    id key name
    states { id name type color position }
    projects { id name milestones { id name } }
  }
  actors { id name type }
  issues(filter: $filter, first: 250) {
    nodes { ${ISSUE_LIST_FIELDS} }
  }
}`;

interface BoardData {
  team: {
    id: string;
    states: Array<{ id: string; name: string; type: string; color: string; position: number }>;
    projects: Array<{ id: string; name: string; milestones: Array<{ id: string; name: string }> }>;
  } | null;
  actors: Array<{ id: string; name: string; type: string }>;
  issues: { nodes: IssueListItem[] };
}

/** Columna del board: qué representa y qué campo escribe el drop. */
interface Column {
  key: string;
  label: string;
  state?: { id: string; name: string; type: string; color: string };
  /** Input de issueUpdate que aplica soltar una card acá. */
  patch: Record<string, string | null>;
}

export function BoardView(
  { teamKey, teamId, groupBy = "state" }: { teamKey: string; teamId: string | null; groupBy?: GroupBy },
) {
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

  // Las columnas dependen del criterio; cada una sabe qué campo escribe el drop.
  const columns: Column[] = (() => {
    if (groupBy === "milestone") {
      const milestones = result.data.team.projects.flatMap((project) =>
        project.milestones.map((milestone) => ({
          key: milestone.id,
          label: `${milestone.name}`,
          patch: { milestoneId: milestone.id },
        })),
      );
      return [...milestones, { key: "none", label: "Sin milestone", patch: { milestoneId: null } }];
    }
    if (groupBy === "assignee") {
      return [
        ...result.data.actors.map((actor) => ({
          key: actor.id,
          label: `${actor.name}${actor.type === "AGENT" ? " 🤖" : ""}`,
          patch: { assigneeId: actor.id },
        })),
        { key: "none", label: "Sin assignee", patch: { assigneeId: null } },
      ];
    }
    if (groupBy === "priority") {
      return ["Sin prioridad", "Urgent", "High", "Medium", "Low"].map((label, index) => ({
        key: String(index),
        label,
        patch: { priority: String(index) },
      }));
    }
    return states.map((state) => ({
      key: state.id,
      label: state.name,
      state,
      patch: { stateId: state.id },
    }));
  })();

  /** A qué columna pertenece hoy un issue. */
  function columnOf(issue: IssueListItem): string {
    if (groupBy === "milestone") return issue.milestone?.id ?? "none";
    if (groupBy === "assignee") return issue.assignee?.id ?? "none";
    if (groupBy === "priority") return String(issue.priority);
    return issue.state.id;
  }

  function drop(column: Column) {
    setOverState(null);
    if (!dragId) return;
    const issue = issues.find((candidate) => candidate.id === dragId);
    if (!issue || columnOf(issue) === column.key) return;

    // Optimista: mueve la card ya; la mutación refetchea al confirmar.
    setLocal(issues.map((candidate): IssueListItem => {
      if (candidate.id !== dragId) return candidate;
      if (groupBy === "state") {
        // La columna trae color; la card solo necesita id/name/type/position.
        return column.state
          ? { ...candidate, state: { ...candidate.state, ...column.state } }
          : candidate;
      }
      if (groupBy === "milestone") {
        return { ...candidate, milestone: column.key === "none" ? null : { id: column.key, name: column.label } };
      }
      if (groupBy === "assignee") {
        const actor = result.data!.actors.find((a) => a.id === column.key);
        return { ...candidate, assignee: actor ? { ...actor } : null };
      }
      return { ...candidate, priority: Number(column.key) };
    }));

    const input = groupBy === "priority"
      ? { priority: Number(column.key) }
      : column.patch;
    mutate(`mutation($id: ID!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`, { id: dragId, input }).catch(() => setLocal(null));
    setDragId(null);
  }

  return (
    <div className="board">
      {columns.map((column) => {
        const cards = issues
          .filter((issue) => columnOf(issue) === column.key)
          .sort((a, b) => (a.priority === 0 ? 5 : a.priority) - (b.priority === 0 ? 5 : b.priority));
        return (
          <div
            key={column.key}
            className={`board-column${overState === column.key ? " drag-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOverState(column.key);
            }}
            onDragLeave={() => setOverState((current) => (current === column.key ? null : current))}
            onDrop={() => drop(column)}
          >
            <div className="col-header">
              {column.state && <StateIcon state={column.state} />}
              {column.label}
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
