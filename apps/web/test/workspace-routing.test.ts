import { afterEach, describe, expect, it } from "bun:test";
import { gql } from "../src/api.ts";
import { getEffectiveWorkspaceContext } from "../src/ui-context.ts";
import { parseRoute, workspacePath } from "../src/router.tsx";
import {
  getSelectedWorkspaceId,
  getWorkspaceContract,
  selectWorkspace,
  setSelectedWorkspaceId,
} from "../src/workspace.ts";

describe("Workspace routes", () => {
  it("parses a Workspace deep-link and keeps the existing route shape", () => {
    expect(parseRoute("#/workspace/acme/team/ENG")).toEqual({
      workspaceKey: "acme",
      segments: ["team", "ENG"],
    });
  });

  it("builds encoded Workspace links without changing legacy paths", () => {
    expect(workspacePath("acme space", "/issue/ENG-1")).toBe("/workspace/acme%20space/issue/ENG-1");
    expect(parseRoute("#/board/ENG").workspaceKey).toBeUndefined();
  });
});

describe("Workspace selection", () => {
  const workspaces = [
    { id: "a", name: "A", urlKey: "a" },
    { id: "b", name: "B", urlKey: "b" },
  ];

  it("requires a deep-link Workspace to be in the accessible list", () => {
    expect(selectWorkspace(workspaces, "b")?.id).toBe("b");
    expect(selectWorkspace(workspaces, "private")).toBeNull();
  });
});

describe("Workspace contract feature gate", () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "localStorage", {
      value: originalStorage,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
  });

  it("does not enable the switcher for a legacy schema", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: { __schema: { queryType: { fields: [{ name: "workspace" }] } } } }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;

    await expect(getWorkspaceContract()).resolves.toEqual({ supported: false });
  });
});

describe("Workspace request isolation", () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "localStorage", {
      value: originalStorage,
      configurable: true,
    });
  });

  it("does not persist a late response after the Workspace changes", async () => {
    const values = new Map<string, string>([["pb.apiKey", "pb_test"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: storage },
    });
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as unknown as typeof fetch;

    const pending = gql<{ viewer: { id: string }; workspace: { id: string } }>(
      `{ viewer { id } workspace { id } }`,
    );
    setSelectedWorkspaceId("workspace-b");
    resolveFetch(
      new Response(
        JSON.stringify({
          data: { viewer: { id: "actor" }, workspace: { id: "workspace-a" } },
        }),
        { status: 200 },
      ),
    );
    await pending;

    expect(getSelectedWorkspaceId()).toBe("workspace-b");
    expect(getEffectiveWorkspaceContext()).toBeNull();
  });
});
