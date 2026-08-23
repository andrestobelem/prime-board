import type { IssueListItem } from "./components/IssueList.tsx";

export type BoardState = Pick<IssueListItem["state"], "id" | "name" | "type">;

/** Usa el UUID en un board de team y una clave portable en un board de proyecto. */
export function stateColumnKey(state: BoardState, isProject: boolean): string {
  return isProject ? `${state.name}/${state.type}` : state.id;
}

/** Debe coincidir con la clave producida para las columnas del board. */
export function issueStateColumnKey(state: BoardState, isProject: boolean): string {
  return stateColumnKey(state, isProject);
}

/** Resuelve el state id que debe escribir un drop para el team de la issue. */
export function stateIdForDrop({
  isProject,
  stateId,
  stateIdByTeam,
  issueTeamId,
}: {
  isProject: boolean;
  stateId?: string | null;
  stateIdByTeam?: Readonly<Record<string, string>>;
  issueTeamId?: string | null;
}): string | null {
  if (!isProject) return stateId ?? null;
  if (!issueTeamId) return null;
  return stateIdByTeam?.[issueTeamId] ?? null;
}

export function incompatibleStateDropMessage(columnLabel: string): string {
  return `Cannot move this issue to "${columnLabel}". Its team has no equivalent state. Use "Move to…" to choose a state from the issue's team.`;
}
