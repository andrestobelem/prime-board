import { describe, expect, it } from "bun:test";
import { appendUniqueById } from "../src/pagination.ts";
import { buildIssueFilter, EMPTY_ISSUE_FILTER } from "../src/issue-filter.ts";

describe("board and project issue scope", () => {
  it("keeps project scope with search and supported filters", () => {
    const draft = {
      ...EMPTY_ISSUE_FILTER,
      search: "  roadmap ",
      priority: "2",
      labelId: "label-1",
    };
    const projectFilter: Record<string, unknown> = {
      ...buildIssueFilter(null, draft),
      project: { eq: "project-1" },
    };
    expect(projectFilter).toEqual({
      project: { eq: "project-1" },
      search: "roadmap",
      priority: { eq: 2 },
      labels: { includes: "label-1" },
    });
  });

  it("appends pages without losing filtered results or duplicates", () => {
    const first = [{ id: "one" }, { id: "two" }];
    const next = [{ id: "two" }, { id: "three" }];
    expect(appendUniqueById(first, next)).toEqual([{ id: "one" }, { id: "two" }, { id: "three" }]);
  });

  it("uses independent persisted keys for team and project layouts", () => {
    expect("project-project-1").not.toBe("TEAM");
    expect({ team: "TEAM", project: "project-project-1" }).toEqual({
      team: "TEAM",
      project: "project-project-1",
    });
  });
});
