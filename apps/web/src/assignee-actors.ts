export interface AssigneeActor {
  id: string;
  name: string;
  type: string;
  status: string;
}

export interface AssigneeTeam {
  accessPolicy?: string | null;
  memberships?: Array<{ actor: AssigneeActor }> | null;
}

export function getAssignableActors(
  actors: AssigneeActor[],
  team: AssigneeTeam | null | undefined,
): AssigneeActor[] {
  const activeActors = actors.filter((actor) => actor.status === "ACTIVE");
  if (team?.accessPolicy !== "TEAM_MEMBERS") return activeActors;
  return (team.memberships ?? [])
    .map((membership) => membership.actor)
    .filter((actor) => actor.status === "ACTIVE");
}
