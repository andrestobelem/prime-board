import { describe, expect, it } from "bun:test";
import { resolveBootstrapIdentity } from "./bootstrap-config.ts";

describe("bootstrap identity configuration", () => {
  it("uses the documented defaults", () => {
    expect(resolveBootstrapIdentity({})).toEqual({
      workspaceName: "workspace",
      workspaceUrlKey: "prime-board",
      teamName: "Prime Board",
      teamKey: "PB",
    });
  });

  it("trims names, normalizes the Team key and keeps the URL key stable", () => {
    expect(
      resolveBootstrapIdentity({
        workspaceName: "  Agent Workspace  ",
        workspaceUrlKey: "  agent-workspace  ",
        teamName: "  Agent Team  ",
        teamKey: " at1 ",
      }),
    ).toEqual({
      workspaceName: "Agent Workspace",
      workspaceUrlKey: "agent-workspace",
      teamName: "Agent Team",
      teamKey: "AT1",
    });
  });

  it.each([
    ["workspaceName", { workspaceName: "   " }, "Workspace name cannot be empty"],
    ["workspaceUrlKey", { workspaceUrlKey: "bad key" }, "Workspace URL key must"],
    ["teamName", { teamName: "   " }, "Team name cannot be empty"],
    ["teamKey", { teamKey: "123" }, "Team key must"],
  ])("rejects invalid %s", (_field, input, message) => {
    expect(() => resolveBootstrapIdentity(input)).toThrow(message);
  });
});
