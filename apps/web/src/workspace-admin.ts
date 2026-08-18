export interface WorkspaceAdminTeam {
  id: string;
  key: string;
  name: string;
  archivedAt: string | null;
  projects: Array<{ id: string }>;
  cycles: Array<{ id: string }>;
  labels: Array<{ id: string }>;
}

/** La API recorta nombres, pero la UI debe avisar antes de abrir la confirmación. */
export function validateWorkspaceName(value: string): string | null {
  return value.trim() ? null : "Workspace name cannot be empty.";
}

/**
 * El borrado de un Team comprueba recursos que no están todos expuestos en sus campos.
 * Mantenemos la lista completa visible para explicar el posible bloqueo destructivo.
 */
export function teamDeletionDependencyMessage(team: WorkspaceAdminTeam): string {
  const known = [
    ["Projects", team.projects.length],
    ["Cycles", team.cycles.length],
    ["Labels", team.labels.length],
  ] as const;
  const present = known
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}: ${count}`);
  const knownText = present.length
    ? ` Currently listed: ${present.join(", ")}.`
    : " No listed projects, cycles, or labels.";
  return `Permanent deletion is blocked while this Team has Issues (and their Activities), Projects, Cycles, Labels, Saved Views, or Initiatives. Remove those resources first; nothing is deleted when a dependency blocks the operation. If no blockers remain, the Team's Workflow States and Memberships are removed atomically with the Team.${knownText}`;
}
