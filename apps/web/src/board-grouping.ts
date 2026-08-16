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
