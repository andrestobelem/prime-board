// Board por estado con drag & drop nativo y update optimista (AT-146).
// Sirve tanto para un team (#/board/KEY) como para un proyecto (#/project-board/ID, AT-182).
import { useEffect, useState } from "react";
import { mutate, useQuery } from "../api.ts";
import { Avatar, LabelChip, PriorityIcon, StateIcon } from "../components/bits.tsx";
import {
  IssueListLimitNotice,
  type GroupBy,
  type IssueListItem,
} from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";
import { issueStateColumnKey, stateColumnKey } from "../board-grouping.ts";
import { navigate } from "../router.tsx";

const TEAM_BOARD_QUERY = `query($key: String, $filter: IssueFilter) {
  team(key: $key) {
    id key name
    states { id name type color position }
    projects { id name milestones { id name } }
  }
  actors { id name type }
  issues(filter: $filter, first: 250) {
    nodes { ${ISSUE_LIST_FIELDS} }
    pageInfo { hasNextPage }
  }
}`;

// El board de proyecto puede cruzar teams: cada issue trae su team para que el
// drop por estado escriba el state id correcto de SU team.
const PROJECT_BOARD_QUERY = `query($id: ID!, $filter: IssueFilter) {
  project(id: $id) {
    id name
    teams { id key states { id name type color position } }
    milestones { id name }
  }
  actors { id name type }
  issues(filter: $filter, first: 250) {
    nodes { ${ISSUE_LIST_FIELDS} team { id } }
    pageInfo { hasNextPage }
  }
}`;

interface StateInfo {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
}

interface BoardCard extends IssueListItem {
  team?: { id: string };
}

/** Columna del board: qué representa y qué campo escribe el drop. */
interface Column {
  key: string;
  label: string;
  state?: StateInfo;
  /** Input de issueUpdate que aplica soltar una card acá. */
  patch: Record<string, string | null>;
  /** Board de proyecto agrupado por estado: el state id según el team del issue. */
  stateIdByTeam?: Record<string, string>;
}

export type BoardScope =
  { kind: "team"; teamKey: string; teamId: string | null } | { kind: "project"; projectId: string };

export function BoardView({ scope, groupBy = "state" }: { scope: BoardScope; groupBy?: GroupBy }) {
  const isProject = scope.kind === "project";
  const result = useQuery<any>(
    isProject ? PROJECT_BOARD_QUERY : TEAM_BOARD_QUERY,
    isProject
      ? { id: scope.projectId, filter: { project: { eq: scope.projectId } } }
      : { key: scope.teamKey, filter: scope.teamId ? { team: { eq: scope.teamId } } : {} },
  );
  // Copia local para el update optimista del drag & drop.
  const [local, setLocal] = useState<BoardCard[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overState, setOverState] = useState<string | null>(null);

  useEffect(() => setLocal(null), [result.data]);

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;
  const container = isProject ? result.data?.project : result.data?.team;
  if (!container) {
    return (
      <div className="empty">
        {isProject
          ? "Project not found."
          : `Team ${(scope as { teamKey: string }).teamKey} not found.`}
      </div>
    );
  }

  const issues: BoardCard[] = local ?? result.data.issues.nodes;
  const actors: Array<{ id: string; name: string; type: string }> = result.data.actors;

  // Estados del alcance. En un proyecto multi-team se fusionan por nombre+tipo:
  // una columna por concepto, que sabe traducirse al state id de cada team.
  const stateColumns: Column[] = (() => {
    const teams = isProject ? container.teams : [container];
    const merged = new Map<string, Column>();
    for (const team of teams) {
      for (const state of [...team.states].sort(
        (a: StateInfo, b: StateInfo) => a.position - b.position,
      )) {
        const key = stateColumnKey(state, isProject);
        const column: Column = merged.get(key) ?? {
          key,
          label: state.name,
          state,
          patch: { stateId: state.id },
          stateIdByTeam: {},
        };
        column.stateIdByTeam![team.id as string] = state.id;
        merged.set(key, column);
      }
    }
    return [...merged.values()].sort((a, b) => a.state!.position - b.state!.position);
  })();

  const milestones: Array<{ id: string; name: string }> = isProject
    ? container.milestones
    : container.projects.flatMap((project: any) => project.milestones);

  // Las columnas dependen del criterio; cada una sabe qué campo escribe el drop.
  const columns: Column[] = (() => {
    if (groupBy === "milestone") {
      return [
        ...milestones.map((milestone) => ({
          key: milestone.id,
          label: milestone.name,
          patch: { milestoneId: milestone.id },
        })),
        { key: "none", label: "Sin milestone", patch: { milestoneId: null } },
      ];
    }
    if (groupBy === "assignee") {
      return [
        ...actors.map((actor) => ({
          key: actor.id,
          label: `${actor.name}${actor.type === "AGENT" ? " (agent)" : ""}`,
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
    return stateColumns;
  })();

  /** A qué columna pertenece hoy un issue. */
  function columnOf(issue: BoardCard): string {
    if (groupBy === "milestone") return issue.milestone?.id ?? "none";
    if (groupBy === "assignee") return issue.assignee?.id ?? "none";
    if (groupBy === "priority") return String(issue.priority);
    return issueStateColumnKey(issue.state, isProject);
  }

  function drop(column: Column) {
    setOverState(null);
    if (!dragId) return;
    const issue = issues.find((candidate) => candidate.id === dragId);
    if (!issue || columnOf(issue) === column.key) return;

    // Board de proyecto por estado: el id a escribir depende del team del issue.
    let stateId = column.patch.stateId ?? null;
    if (groupBy === "state" && isProject) {
      stateId = column.stateIdByTeam?.[issue.team?.id ?? ""] ?? null;
      if (!stateId) return; // el team del issue no tiene un estado equivalente
    }

    // Optimista: mueve la card ya; la mutación refetchea al confirmar.
    setLocal(
      issues.map((candidate): BoardCard => {
        if (candidate.id !== dragId) return candidate;
        if (groupBy === "state") {
          // La columna trae color; la card solo necesita id/name/type/position.
          return column.state
            ? { ...candidate, state: { ...candidate.state, ...column.state, id: stateId! } }
            : candidate;
        }
        if (groupBy === "milestone") {
          return {
            ...candidate,
            milestone: column.key === "none" ? null : { id: column.key, name: column.label },
          };
        }
        if (groupBy === "assignee") {
          const actor = actors.find((a) => a.id === column.key);
          return { ...candidate, assignee: actor ? { ...actor } : null };
        }
        return { ...candidate, priority: Number(column.key) };
      }),
    );

    const input =
      groupBy === "priority"
        ? { priority: Number(column.key) }
        : groupBy === "state"
          ? { stateId }
          : column.patch;
    mutate(
      `mutation($id: ID!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
      { id: dragId, input },
    ).catch(() => setLocal(null));
    setDragId(null);
  }

  return (
    <>
      <IssueListLimitNotice hasNextPage={result.data.issues.pageInfo.hasNextPage} />
      <div className="board">
        {columns.map((column) => {
          const cards = issues
            .filter((issue) => columnOf(issue) === column.key)
            .sort(
              (a, b) => (a.priority === 0 ? 5 : a.priority) - (b.priority === 0 ? 5 : b.priority),
            );
          return (
            <div
              key={column.key}
              className={`board-column${overState === column.key ? " drag-over" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setOverState(column.key);
              }}
              onDragLeave={() =>
                setOverState((current) => (current === column.key ? null : current))
              }
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
                    {issue.labels.map((label) => (
                      <LabelChip key={label.id} label={label} />
                    ))}
                    <span style={{ marginLeft: "auto" }}>
                      <Avatar actor={issue.assignee} />
                    </span>
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
