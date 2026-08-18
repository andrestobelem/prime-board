import { describe, expect, it } from "bun:test";
import { canManageCycle, canManageProject } from "../src/permissions.ts";

const memberViewer = { id: "member", workspaceRole: "MEMBER" };
const ownerViewer = { id: "owner", workspaceRole: "MEMBER" };
const outsiderViewer = { id: "outsider", workspaceRole: "MEMBER" };
const teams = [
  {
    id: "team-1",
    memberships: [
      { actorId: "owner", role: "OWNER" },
      { actorId: "member", role: "MEMBER" },
    ],
  },
];

describe("project and cycle permissions", () => {
  it("allows project mutations for a member of an associated team", () => {
    expect(canManageProject(memberViewer, teams)).toBe(true);
    expect(canManageProject(outsiderViewer, teams)).toBe(false);
  });

  it("requires team ownership for cycle mutations", () => {
    expect(canManageCycle(ownerViewer, teams[0]!)).toBe(true);
    expect(canManageCycle(memberViewer, teams[0]!)).toBe(false);
    expect(canManageCycle(outsiderViewer, teams[0]!)).toBe(false);
  });

  it("allows workspace admins regardless of team membership", () => {
    const admin = { id: "admin", workspaceRole: "ADMIN" };
    expect(canManageProject(admin, [])).toBe(true);
    expect(canManageCycle(admin, null)).toBe(true);
  });
});
