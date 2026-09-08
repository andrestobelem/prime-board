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
    expect(sql).toContain("scope_issue.id = issue_relations.issue_id");
    expect(sql).toContain("scope_issue.id = issue_relations.related_id");
    expect(sql.match(/workspace_id = \$3/g)).toHaveLength(2);
  });

  it("hereda el alcance para Issues, Projects, Milestones y Labels", () => {
    expect(issueIdWorkspaceScope("issues.parent_id", "$2")).toContain("FROM issues AS scope_issue");
    expect(projectWorkspaceScope("projects", "$2")).toContain("FROM project_teams");
    expect(milestoneWorkspaceScope("milestones", "$2")).toContain("FROM projects");
    expect(labelWorkspaceScope("labels", "$2")).toContain("labels.team_id IS NULL");
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
