import { describe, expect, it } from "bun:test";
import { changedTeamIds, parseTeamIds, serializeTeamIds } from "../src/project-teams.ts";

describe("project team selection", () => {
  it("round-trips multiple teams without duplicates or empty values", () => {
    expect(parseTeamIds(serializeTeamIds(["one", "two", "one"]))).toEqual(["one", "two"]);
    expect(parseTeamIds(" one,,two, ")).toEqual(["one", "two"]);
  });

  it("omits teamIds when membership did not change", () => {
    expect(changedTeamIds(["one", "two"], ["two", "one"])).toBeUndefined();
    expect(changedTeamIds(["one"], ["one", "two"])).toEqual(["one", "two"]);
  });
});
