export interface ViewerAccess {
  id: string;
  workspaceRole?: string | null;
}

export interface TeamAccess {
  id: string;
  memberships: Array<{ actorId: string; role: string }>;
}

function isWorkspaceAdmin(viewer: ViewerAccess): boolean {
  return viewer.workspaceRole?.toUpperCase() === "ADMIN";
}

/** Projects are writable by any member of one of their associated teams. */
export function canManageProject(viewer: ViewerAccess, teams: TeamAccess[]): boolean {
  if (isWorkspaceAdmin(viewer)) return true;
  return teams.some((team) =>
    team.memberships.some((membership) => membership.actorId === viewer.id),
  );
}

/** Cycle mutations are restricted to team owners (or workspace admins). */
export function canManageCycle(viewer: ViewerAccess, team: TeamAccess | null): boolean {
  if (isWorkspaceAdmin(viewer)) return true;
  return Boolean(
    team?.memberships.some(
      (membership) => membership.actorId === viewer.id && membership.role.toUpperCase() === "OWNER",
    ),
  );
}
