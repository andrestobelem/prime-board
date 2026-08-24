import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { SettingsView } from "../src/views/SettingsView.tsx";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;
const originalHTMLElement = globalThis.HTMLElement;
const originalNode = globalThis.Node;

const teams = [
  {
    id: "team-prb",
    key: "PRB",
    name: "prime-board dev",
    archivedAt: null,
    projects: [{ id: "project-1" }],
    cycles: [{ id: "cycle-1" }],
    labels: [{ id: "label-1" }],
  },
  {
    id: "team-at",
    key: "AT",
    name: "andrestobelem",
    archivedAt: "2026-08-23T00:00:00.000Z",
    projects: [],
    cycles: [],
    labels: [],
  },
];

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: originalHTMLElement,
  });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: originalNode });
});

async function renderSettings(): Promise<{ dom: JSDOM; root: Root }> {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: dom.window.localStorage,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () =>
      new Response(
        JSON.stringify({
          data: {
            viewer: { id: "actor-1", workspaceRole: "ADMIN", name: "admin", type: "HUMAN" },
            workspace: { id: "workspace-1", name: "workspace", urlKey: "workspace" },
            teams,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SettingsView, { localAuth: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { dom, root };
}

describe("workspace Team administration", () => {
  test("presents identity, status, safeguards, and separated actions", async () => {
    const { dom, root } = await renderSettings();
    const document = dom.window.document;
    const rows = document.querySelectorAll(".workspace-team-row");

    expect(rows).toHaveLength(2);
    expect(document.querySelector(".workspace-name-panel")).not.toBeNull();
    expect(
      document.querySelector(".workspace-identity-form label input")?.getAttribute("aria-label"),
    ).toBe("Workspace name");
    expect(document.querySelector(".workspace-url-key")?.textContent).toBe("URL key: workspace");
    expect(rows[0]?.querySelector(".workspace-team-heading strong")?.textContent).toBe(
      "prime-board dev",
    );
    expect(rows[0]?.querySelector(".workspace-team-key")?.textContent).toBe("PRB");
    expect(rows[0]?.querySelector(".workspace-team-status.active")?.textContent).toContain(
      "Active",
    );
    expect(rows[1]?.querySelector(".workspace-team-status.archived")?.textContent).toContain(
      "Archived",
    );
    expect(document.querySelectorAll(".workspace-team-dependencies-label")).toHaveLength(2);
    expect(rows[0]?.querySelector(".workspace-team-controls .btn.secondary")?.textContent).toBe(
      "Archive",
    );
    expect(rows[0]?.querySelector(".workspace-team-controls .btn.danger")?.textContent).toBe(
      "Delete permanently",
    );

    await act(async () => root.unmount());
    dom.window.close();
  });
});
