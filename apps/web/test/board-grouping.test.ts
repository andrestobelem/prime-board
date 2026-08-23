import { describe, expect, it } from "bun:test";
import {
  incompatibleStateDropMessage,
  issueStateColumnKey,
  stateColumnKey,
  stateIdForDrop,
} from "../src/board-grouping.ts";

const state = { id: "state-1", name: "Done", type: "COMPLETED" };

describe("board state columns", () => {
  it("uses state ids for a team board", () => {
    expect(stateColumnKey(state, false)).toBe("state-1");
    expect(issueStateColumnKey(state, false)).toBe("state-1");
  });

  it("uses portable state names for a project board", () => {
    expect(stateColumnKey(state, true)).toBe("Done/COMPLETED");
    expect(issueStateColumnKey(state, true)).toBe("Done/COMPLETED");
  });

  it("resolves the state id for the issue team", () => {
    expect(
      stateIdForDrop({
        isProject: true,
        stateIdByTeam: { "team-a": "state-a", "team-b": "state-b" },
        issueTeamId: "team-b",
      }),
    ).toBe("state-b");
    expect(stateIdForDrop({ isProject: false, stateId: "state-1" })).toBe("state-1");
  });

  it("reports an incompatible project column without a team state", () => {
    expect(
      stateIdForDrop({
        isProject: true,
        stateIdByTeam: { "team-a": "state-a" },
        issueTeamId: "team-b",
      }),
    ).toBeNull();
    expect(
      stateIdForDrop({
        isProject: true,
        stateIdByTeam: { "team-a": "state-a" },
        issueTeamId: null,
      }),
    ).toBeNull();
    expect(incompatibleStateDropMessage("Review")).toContain("Move to…");
  });
});
