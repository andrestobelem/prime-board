import { describe, expect, it } from "bun:test";
import { availableTeamActors } from "../src/team-memberships.ts";

describe("team membership roster", () => {
  it("does not offer actors already assigned to the team", () => {
    const actors = [
      { id: "one", name: "One" },
      { id: "two", name: "Two" },
    ];
    expect(availableTeamActors(actors, [{ actor: { id: "one" } }])).toEqual([
      { id: "two", name: "Two" },
    ]);
  });
});
