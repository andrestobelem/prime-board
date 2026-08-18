// Board por estado con drag & drop nativo y update optimista (AT-146).
// Sirve tanto para un team (#/board/KEY) como para un proyecto (#/project-board/ID, AT-182).
import { useEffect, useState } from "react";
import { gql, mutate, useQuery } from "../api.ts";
import { EmptyState, ErrorState, LoadingState } from "../components/AsyncState.tsx";
import { Avatar, LabelChip, PriorityIcon, StateIcon } from "../components/bits.tsx";
import {
  IssueListLimitNotice,
  type GroupBy,
  type IssueListItem,
} from "../components/IssueList.tsx";
import { ISSUE_LIST_FIELDS } from "../fragments.ts";
import { issueStateColumnKey, stateColumnKey } from "../board-grouping.ts";
import { navigate } from "../router.tsx";
import {
  BulkIssueActions,
  IssueActionMenu,
  type IssueActionInput,
  type IssueActionOptions,
} from "../components/IssueActions.tsx";
import { archiveMutation, issueUpdateMutation, runIssueActions } from "../issue-actions.ts";
import { isIssueShortcutTarget } from "../issue-selection.ts";
import type { IssueColumn, IssueOrder } from "../components/DisplayOptions.tsx";

const TEAM_BOARD_QUERY = `query($key: String, $filter: IssueFilter, $orderBy: IssueOrder, $after: String) {
  team(key: $key) {
    id key name
    states { id name type color position }
    projects { id name milestones { id name } }
    labels { id name color }
    cycles { id name number }
  }
  actors { id name type }
  issues(filter: $filter, first: 250, after: $after, orderBy: $orderBy) {
    nodes { ${ISSUE_LIST_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

// El board de proyecto puede cruzar teams: cada issue trae su team para que el
// drop por estado escriba el state id correcto de SU team.
const PROJECT_BOARD_QUERY = `query($id: ID!, $filter: IssueFilter, $orderBy: IssueOrder, $after: String) {
  project(id: $id) {
    id name
    teams { id key states { id name type color position } labels { id name color } cycles { id name number } }
    milestones { id name }
  }
  actors { id name type }
  issues(filter: $filter, first: 250, after: $after, orderBy: $orderBy) {
    nodes { ${ISSUE_LIST_FIELDS} team { id } }
    pageInfo { hasNextPage endCursor }
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

export function BoardView({
  scope,
  groupBy = "state",
  orderBy = "UPDATED_DESC",
  visibleColumns = ["priority", "labels", "assignee"],
}: {
  scope: BoardScope;
  groupBy?: GroupBy;
  orderBy?: IssueOrder;
  visibleColumns?: IssueColumn[];
}) {
  const isProject = scope.kind === "project";
  const result = useQuery<any>(
    isProject ? PROJECT_BOARD_QUERY : TEAM_BOARD_QUERY,
    isProject
      ? { id: scope.projectId, filter: { project: { eq: scope.projectId } }, orderBy }
      : { key: scope.teamKey, filter: scope.teamId ? { team: { eq: scope.teamId } } : {}, orderBy },
  );
  // Copia local para el update optimista del drag & drop.
  const [local, setLocal] = useState<BoardCard[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overState, setOverState] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [extraIssues, setExtraIssues] = useState<BoardCard[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    endCursor: null as string | null,
  });

  useEffect(() => setLocal(null), [result.data]);
  useEffect(() => {
    setExtraIssues([]);
    if (result.data?.issues?.pageInfo) setPageInfo(result.data.issues.pageInfo);
  }, [result.data]);

  useEffect(() => {
    const visible = new Set((result.data?.issues?.nodes ?? []).map((issue: BoardCard) => issue.id));
    setSelectedIds((current) => new Set([...current].filter((id) => visible.has(id))));
    setFocusedId((current) => (current && visible.has(current) ? current : null));
  }, [result.data]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isIssueShortcutTarget(event.target) || document.querySelector(".overlay")) return;
      const visible = result.data?.issues?.nodes ?? [];
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(new Set(visible.map((issue: BoardCard) => issue.id)));
      } else if (event.key === "Escape") {
        setSelectedIds(new Set());
        setFocusedId(null);
      } else if ((event.key === "x" || event.key === "X") && (focusedId || selectedIds.size)) {
        event.preventDefault();
        if (event.shiftKey && selectedIds.size) void bulkArchive();
        else if (focusedId) void archiveIssue(focusedId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedId, result.data, selectedIds]);

  if (result.loading && !result.data) return <LoadingState />;
  if (result.error) return <ErrorState message={result.error.message} onRetry={result.refetch} />;
  const container = isProject ? result.data?.project : result.data?.team;
  if (!container) {
    return (
      <EmptyState
        title={
          isProject
            ? "Project not found."
            : `Team ${(scope as { teamKey: string }).teamKey} not found.`
        }
      />
    );
  }

  const issues: BoardCard[] = local ?? [...result.data.issues.nodes, ...extraIssues];
  const actors: Array<{ id: string; name: string; type: string }> = result.data.actors;
  const actionOptions: IssueActionOptions = {
    states: isProject ? [] : container.states,
    actors,
    labels: isProject ? [] : container.labels,
    projects: isProject
      ? []
      : container.projects.map((project: any) => ({ id: project.id, name: project.name })),
    cycles: isProject ? [] : container.cycles,
  };

  async function loadMore(): Promise<void> {
    if (loadingMore || !pageInfo.hasNextPage || !pageInfo.endCursor) return;
    setLoadingMore(true);
    try {
      const variables = isProject
        ? {
            id: scope.projectId,
            filter: { project: { eq: scope.projectId } },
            orderBy,
            after: pageInfo.endCursor,
          }
        : {
            key: scope.teamKey,
            filter: scope.teamId ? { team: { eq: scope.teamId } } : {},
            orderBy,
            after: pageInfo.endCursor,
          };
      const next = await gql<any>(isProject ? PROJECT_BOARD_QUERY : TEAM_BOARD_QUERY, variables);
      setExtraIssues((current) => [...current, ...next.issues.nodes]);
      setPageInfo(next.issues.pageInfo);
    } finally {
      setLoadingMore(false);
    }
  }

  async function bulkAction(input: IssueActionInput): Promise<void> {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await runIssueActions(ids, async (id) => {
        const response = await mutate<{ issueUpdate: { success: boolean } }>(
          issueUpdateMutation(),
          {
            id,
            input,
          },
        );
        return response.issueUpdate;
      });
      setSelectedIds(new Set());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update selected issues.");
    } finally {
      setActionLoading(false);
    }
  }

  async function bulkArchive(): Promise<void> {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await runIssueActions(ids, async (id) => {
        const response = await mutate<{ issueArchive: { success: boolean } }>(archiveMutation(), {
          id,
        });
        return response.issueArchive;
      });
      setSelectedIds(new Set());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not archive selected issues.");
    } finally {
      setActionLoading(false);
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
    setActionError(null);
    try {
      const response = await mutate<{ issueArchive: { success: boolean } }>(archiveMutation(), {
        id,
      });
      if (!response.issueArchive.success) throw new Error(`Could not archive issue ${id}.`);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not archive issue ${id}.`);
    }
  }

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
        { key: "none", label: "No milestone", patch: { milestoneId: null } },
      ];
    }
    if (groupBy === "assignee") {
      return [
        ...actors.map((actor) => ({
          key: actor.id,
          label: `${actor.name}${actor.type === "AGENT" ? " (agent)" : ""}`,
          patch: { assigneeId: actor.id },
        })),
        { key: "none", label: "No assignee", patch: { assigneeId: null } },
      ];
    }
    if (groupBy === "priority") {
      return ["No priority", "Urgent", "High", "Medium", "Low"].map((label, index) => ({
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
    setActionError(null);
    mutate(
      `mutation($id: ID!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
      { id: dragId, input },
    )
      .then((response: any) => {
        if (!response.issueUpdate?.success) throw new Error("Could not update the issue.");
      })
      .catch((error) => {
        setLocal(null);
        setActionError(error instanceof Error ? error.message : "Could not update the issue.");
      });
    setDragId(null);
  }

  return (
    <>
      <BulkIssueActions
        selectedCount={selectedIds.size}
        options={actionOptions}
        onAction={bulkAction}
        onArchive={bulkArchive}
        onClear={() => setSelectedIds(new Set())}
        loading={actionLoading}
      />
      {actionError && (
        <div className="error-banner" role="alert">
          {actionError}
        </div>
      )}
      <IssueListLimitNotice
        hasNextPage={pageInfo.hasNextPage}
        loading={loadingMore}
        onLoadMore={() => void loadMore()}
      />
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
                  className={`board-card${focusedId === issue.id ? " focused" : ""}`}
                  role="button"
                  tabIndex={focusedId === issue.id ? 0 : -1}
                  aria-current={focusedId === issue.id ? "true" : undefined}
                  draggable
                  onMouseEnter={() => setFocusedId(issue.id)}
                  onDragStart={() => setDragId(issue.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverState(null);
                  }}
                  onClick={() => navigate(`/issue/${issue.identifier}`)}
                >
                  <span className="board-card-topline">
                    <input
                      className="issue-select"
                      type="checkbox"
                      aria-label={`Select ${issue.identifier}`}
                      checked={selectedIds.has(issue.id)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() =>
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (next.has(issue.id)) next.delete(issue.id);
                          else next.add(issue.id);
                          return next;
                        })
                      }
                    />
                    <span className="identifier">{issue.identifier}</span>
                    <IssueActionMenu
                      options={actionOptions}
                      onAction={(input) => updateIssue(issue.id, input)}
                      onArchive={() => archiveIssue(issue.id)}
                    />
                  </span>
                  <span className="card-title">{issue.title}</span>
                  <span className="card-footer">
                    {visibleColumns.includes("priority") && (
                      <PriorityIcon priority={issue.priority} />
                    )}
                    {visibleColumns.includes("labels") &&
                      issue.labels.map((label) => <LabelChip key={label.id} label={label} />)}
                    <span style={{ marginLeft: "auto" }}>
                      {visibleColumns.includes("assignee") && <Avatar actor={issue.assignee} />}
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
