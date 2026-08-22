import { describe, expect, it } from "bun:test";
import { ApiError } from "../src/errors.ts";
import { selectWorkspace } from "../src/commands/workspace.ts";

const workspaces = [
  { id: "workspace-a", name: "Alpha", urlKey: "alpha", isDefault: true },
  { id: "workspace-b", name: "Beta", urlKey: "beta", isDefault: false },
];

describe("CLI Workspace selector", () => {
  it("selects by ID or stable urlKey from the server-provided grant list", () => {
    expect(selectWorkspace(workspaces, "workspace-b").urlKey).toBe("beta");
    expect(selectWorkspace(workspaces, "alpha").id).toBe("workspace-a");
  });

  it("rejects an inaccessible reference without guessing", () => {
    expect(() => selectWorkspace(workspaces, "hidden-workspace")).toThrow(ApiError);
    expect(() => selectWorkspace(workspaces, "hidden-workspace")).toThrow(
      "not accessible: hidden-workspace",
    );
  });

  it("rejects duplicate human-readable references", () => {
    expect(() =>
      selectWorkspace(
        [
          { id: "workspace-a", name: "Shared", urlKey: "alpha" },
          { id: "workspace-b", name: "Shared", urlKey: "beta" },
        ],
        "Shared",
      ),
    ).toThrow("Workspace reference is ambiguous: Shared; use its ID");
  });
});
