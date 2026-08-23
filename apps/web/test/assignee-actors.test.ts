import { describe, expect, it } from "bun:test";
import { getAssignableActors, type AssigneeActor } from "../src/assignee-actors.ts";

const actors: AssigneeActor[] = [
  { id: "owner", name: "Owner", type: "HUMAN", status: "ACTIVE" },
  { id: "member", name: "Member", type: "HUMAN", status: "ACTIVE" },
  { id: "outsider", name: "Outsider", type: "HUMAN", status: "ACTIVE" },
  { id: "suspended", name: "Suspended", type: "HUMAN", status: "SUSPENDED" },
];

const membership = (id: string) => {
  const actor = actors.find((candidate) => candidate.id === id);
  if (!actor) throw new Error(`Missing actor ${id}`);
  return { actor };
};
const ids = (items: AssigneeActor[]) => items.map((actor) => actor.id);

describe("assignable actors", () => {
  it("limits team-members policy to active team members", () => {
    expect(
      ids(
        getAssignableActors(actors, {
          accessPolicy: "TEAM_MEMBERS",
          memberships: [membership("owner"), membership("member"), membership("suspended")],
        }),
      ),
    ).toEqual(["owner", "member"]);
  });

  it("allows active workspace members and excludes outsiders only from team policy", () => {
    expect(ids(getAssignableActors(actors, { accessPolicy: "WORKSPACE_MEMBERS" }))).toEqual([
      "owner",
      "member",
      "outsider",
    ]);
    expect(
      ids(
        getAssignableActors(actors, {
          accessPolicy: "TEAM_MEMBERS",
          memberships: [membership("owner"), membership("member")],
        }),
      ),
    ).not.toContain("outsider");
  });

  it("does not offer suspended actors under either policy", () => {
    expect(ids(getAssignableActors(actors, { accessPolicy: "WORKSPACE_MEMBERS" }))).not.toContain(
      "suspended",
    );
    expect(
      ids(
        getAssignableActors(actors, {
          accessPolicy: "TEAM_MEMBERS",
          memberships: [membership("suspended")],
        }),
      ),
    ).toEqual([]);
  });

  it("falls back to active workspace actors when the roster is absent", () => {
    expect(ids(getAssignableActors(actors, { accessPolicy: "TEAM_MEMBERS" }))).toEqual([]);
    expect(ids(getAssignableActors(actors, null))).toEqual(["owner", "member", "outsider"]);
  });
});
