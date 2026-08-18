import { describe, expect, it } from "bun:test";
import { teamDeletionDependencyMessage, validateWorkspaceName } from "../src/workspace-admin.ts";

describe("workspace administration safeguards", () => {
  it("rejects an empty Workspace name before confirmation", () => {
    expect(validateWorkspaceName("   ")).toBe("Workspace name cannot be empty.");
    expect(validateWorkspaceName(" New name ")).toBeNull();
  });

  it("explains every dependency class checked before Team deletion", () => {
    const message = teamDeletionDependencyMessage({
      id: "team-1",
      key: "PB",
      name: "Product",
      archivedAt: null,
      projects: [{ id: "project-1" }],
      cycles: [],
      labels: [{ id: "label-1" }, { id: "label-2" }],
    });
    expect(message).toContain("Issues");
    expect(message).toContain("Saved Views");
    expect(message).toContain("Initiatives");
    expect(message).toContain("Projects: 1");
    expect(message).toContain("Labels: 2");
    expect(message).toContain("nothing is deleted");
    expect(message).toContain("Workflow States and Memberships");
  });
});
