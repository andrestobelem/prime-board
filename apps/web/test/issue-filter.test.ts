import { describe, expect, it } from "bun:test";
import {
  activeIssueFilterCount,
  buildIssueFilter,
  EMPTY_ISSUE_FILTER,
} from "../src/issue-filter.ts";

describe("issue filters", () => {
  it("combines team and selected criteria for the API", () => {
    expect(
      buildIssueFilter("team-1", {
        ...EMPTY_ISSUE_FILTER,
        search: "  cycle  ",
        stateId: "state-1",
        assigneeId: "actor-1",
        priority: "2",
        labelId: "label-1",
      }),
    ).toEqual({
      team: { eq: "team-1" },
      search: "cycle",
      state: { eq: "state-1" },
      assignee: { eq: "actor-1" },
      priority: { eq: 2 },
      labels: { includes: "label-1" },
    });
  });

  it("represents unassigned and no-state filters as null comparators", () => {
    expect(
      buildIssueFilter("team-1", {
        ...EMPTY_ISSUE_FILTER,
        stateId: "__none__",
        assigneeId: "__none__",
      }),
    ).toEqual({ team: { eq: "team-1" }, state: { null: true }, assignee: { null: true } });
  });

  it("supports the API's extended queue filters", () => {
    expect(
      buildIssueFilter("team-1", {
        ...EMPTY_ISSUE_FILTER,
        projectId: "project-1",
        milestoneId: "__none__",
        cycleId: "cycle-1",
        parentId: "parent-1",
        creatorId: "actor-1",
        unblocked: "true",
      }),
    ).toEqual({
      team: { eq: "team-1" },
      project: { eq: "project-1" },
      milestone: { null: true },
      cycle: { eq: "cycle-1" },
      parent: { eq: "parent-1" },
      creator: { eq: "actor-1" },
      unblocked: true,
    });
  });

  it("counts active criteria and ignores whitespace-only search", () => {
    expect(activeIssueFilterCount({ ...EMPTY_ISSUE_FILTER, search: "  " })).toBe(0);
    expect(activeIssueFilterCount({ ...EMPTY_ISSUE_FILTER, priority: "1", labelId: "l" })).toBe(2);
  });
});
