export interface RosterActor {
  id: string;
  name: string;
  type?: string;
}

export interface RosterMembership {
  actor: { id: string };
}

export function availableTeamActors(
  actors: RosterActor[],
  memberships: RosterMembership[],
): RosterActor[] {
  const memberIds = new Set(memberships.map((membership) => membership.actor.id));
  return actors.filter((actor) => !memberIds.has(actor.id));
}
