import { describe, expect, it } from "bun:test";
import { issueStateColumnKey, stateColumnKey } from "../src/board-grouping.ts";

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
});
