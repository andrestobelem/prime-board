import { describe, expect, it } from "bun:test";
import {
  actorWorkspaceScope,
  issueIdWorkspaceScope,
  issueRelationWorkspaceScope,
  labelWorkspaceScope,
  legacyWorkspaceScope,
  milestoneWorkspaceScope,
  projectWorkspaceScope,
  scopedWorkspacePredicate,
  teamWorkspaceScope,
} from "./postgres-workspace-scope.ts";

describe("alcance PostgreSQL por Workspace", () => {
  it("usa el Workspace efectivo en la relación Team-Membership", () => {
    const sql = teamWorkspaceScope("teams.id", "$1");
    expect(sql).toContain("scope_team_workspace.workspace_id = $1");
    expect(sql).toContain("scope_team_workspace.status = 'active'");
    expect(sql).toContain("scope_team_membership.team_id = teams.id");
  });

  it("exige ambos extremos de una Relation en el mismo Workspace", () => {
    const sql = issueRelationWorkspaceScope("issue_relations", "$3");
    expect(sql).toBe("issue_relations.workspace_id = $3");
  });

  it("hereda el alcance para Issues, Projects, Milestones y Labels", () => {
    expect(issueIdWorkspaceScope("issues.parent_id", "$2")).toContain("FROM issues AS scope_issue");
    expect(projectWorkspaceScope("projects", "$2")).toBe("projects.workspace_id = $2");
    expect(milestoneWorkspaceScope("milestones", "$2")).toBe("milestones.workspace_id = $2");
    expect(labelWorkspaceScope("labels", "$2")).toBe("labels.workspace_id = $2");
    expect(actorWorkspaceScope("actors", "$2")).toContain("FROM workspace_memberships");
  });

  it("mantiene el legacy solo con un Workspace", () => {
    expect(legacyWorkspaceScope()).toBe("(SELECT count(*) FROM workspace) = 1");
    expect(
      scopedWorkspacePredicate(undefined, (param) => teamWorkspaceScope("teams.id", param), "$1"),
    ).toBe(legacyWorkspaceScope());
    expect(
      scopedWorkspacePredicate(
        { workspaceId: "workspace-a" },
        (param) => teamWorkspaceScope("teams.id", param),
        "$1",
      ),
    ).toContain("workspace_id = $1");
  });
});
