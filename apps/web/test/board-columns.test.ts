import { describe, expect, it } from "bun:test";
import { getVisibleBoardMetadata } from "../src/board-columns.ts";

describe("board metadata columns", () => {
  it("shows project and cycle only when configured", () => {
    const issue = { project: { name: "Roadmap" }, cycle: { name: "Sprint", number: 3 } };
    expect(getVisibleBoardMetadata(issue, ["project", "cycle"])).toEqual({
      project: "Roadmap",
      cycle: "Cycle 3 Sprint",
    });
    expect(getVisibleBoardMetadata(issue, ["assignee"])).toEqual({ project: null, cycle: null });
  });

  it("handles unassigned metadata", () => {
    expect(getVisibleBoardMetadata({}, ["project", "cycle"])).toEqual({
      project: null,
      cycle: null,
    });
  });
});
