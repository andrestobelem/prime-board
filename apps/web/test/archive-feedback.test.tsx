import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { IssueActionMenu, type IssueActionOptions } from "../src/components/IssueActions.tsx";
import {
  IssueList,
  type IssueListItem,
  type IssueSelection,
} from "../src/components/IssueList.tsx";
import { archiveConfirmationCopy } from "../src/components/ArchiveConfirmModal.tsx";

const options: IssueActionOptions = {
  states: [],
  actors: [],
  labels: [],
  projects: [],
  cycles: [],
};

function buttonWithText(document: Document, text: string): Element {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text,
  );
  if (!button) throw new Error(`Button ${text} not found`);
  return button;
}

async function click(dom: JSDOM, element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

function renderMenu(
  dom: JSDOM,
  onArchive: () => Promise<void>,
): { root: Root; document: Document } {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(IssueActionMenu, {
        options,
        onAction: async () => undefined,
        onArchive,
        archiveTarget: { kind: "issue", identifier: "PRB-1" },
      }),
    );
  });
  return { root, document: dom.window.document };
}

const issue: IssueListItem = {
  id: "issue-1",
  identifier: "PRB-1",
  title: "Archive me",
  priority: 1,
  state: { id: "state-1", name: "Todo", type: "BACKLOG", position: 0 },
  assignee: null,
  labels: [],
};

function renderList(
  dom: JSDOM,
  selection: IssueSelection,
  onArchiveIssue: (id: string) => Promise<void>,
): { root: Root; document: Document } {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(IssueList, {
        issues: [issue],
        selection,
        onArchiveIssue,
      }),
    );
  });
  return { root, document: dom.window.document };
}

describe("archive feedback", () => {
  test("uses one confirmation copy and shows the bulk boundary", () => {
    expect(archiveConfirmationCopy({ kind: "issue", identifier: "PRB-1" })).toEqual({
      title: "Archive issue",
      message: "Archive PRB-1? It will leave active issue lists.",
      confirmLabel: "Archive",
    });
    expect(archiveConfirmationCopy({ kind: "issues", count: 1 }).message).toContain(
      "Archive 1 selected issue?",
    );
    expect(archiveConfirmationCopy({ kind: "issues", count: 250 }).message).toContain(
      "Archive 250 selected issues?",
    );
    expect(archiveConfirmationCopy({ kind: "project", name: "Roadmap" }).title).toBe(
      "Archive project",
    );
    expect(archiveConfirmationCopy({ kind: "saved-view", name: "My issues" }).title).toBe(
      "Archive saved view",
    );
  });

  test("keeps the menu open after cancel and closes it after success", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    let archives = 0;
    const rendered = renderMenu(dom, async () => {
      archives += 1;
    });
    await click(dom, buttonWithText(rendered.document, "Issue actions"));
    await click(dom, buttonWithText(rendered.document, "Archive issue"));
    expect(rendered.document.querySelector(".overlay")).not.toBeNull();
    await click(dom, buttonWithText(rendered.document, "Cancel"));
    expect(rendered.document.querySelector(".overlay")).toBeNull();
    expect(rendered.document.querySelector('[role="menu"]')).not.toBeNull();
    await click(dom, buttonWithText(rendered.document, "Archive issue"));
    await click(dom, buttonWithText(rendered.document, "Archive"));
    expect(archives).toBe(1);
    expect(rendered.document.querySelector(".overlay")).toBeNull();
    expect(rendered.document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => rendered.root.unmount());
    dom.window.close();
  });

  test("preserves selection and route while Enter or Escape reaches the modal", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/#/team/PRB" });
    const selectedIds = new Set([issue.id]);
    let clears = 0;
    let archives = 0;
    const rendered = renderList(
      dom,
      {
        selectedIds,
        onToggle: () => undefined,
        onClear: () => {
          clears += 1;
        },
      },
      async () => {
        archives += 1;
      },
    );
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j" }));
    });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "x" }));
    });
    expect(rendered.document.querySelector(".overlay")).not.toBeNull();
    const routeBeforeEnter = dom.window.location.hash;
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(dom.window.location.hash).toBe(routeBeforeEnter);
    expect(archives).toBe(0);
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(rendered.document.querySelector(".overlay")).toBeNull();
    expect(clears).toBe(0);
    expect(selectedIds).toEqual(new Set([issue.id]));
    await act(async () => rendered.root.unmount());
    dom.window.close();
  });

  test("TeamView preserves selected issues when bulk confirmation closes by Escape", async () => {
    const teamData = {
      team: {
        id: "team-1",
        key: "PRB",
        name: "Prime Board",
        states: [issue.state],
        projects: [],
        cycles: [],
      },
      actors: [],
      labels: [],
      issues: { nodes: [issue], pageInfo: { hasNextPage: false, endCursor: null } },
    };
    const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/#/team/PRB" });
    const previousFetch = globalThis.fetch;
    const fetchStub = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify({ data: teamData }), {
        headers: { "content-type": "application/json" },
      });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      localStorage: dom.window.localStorage,
      HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: fetchStub,
    });
    const { TeamView } = await import("../src/views/TeamView.tsx");
    dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TeamView, { teamKey: "PRB", teamId: "team-1" }));
    });
    await click(dom, buttonWithText(dom.window.document, "Select visible"));
    const checkbox = dom.window.document.querySelector('input[aria-label="Select PRB-1"]');
    if (!(checkbox instanceof dom.window.HTMLInputElement))
      throw new Error("Issue checkbox not found");
    expect(checkbox.checked).toBe(true);
    await click(dom, buttonWithText(dom.window.document, "Archive"));
    expect(dom.window.document.querySelector(".overlay")).not.toBeNull();
    const routeBeforeEnter = dom.window.location.hash;
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
    });
    expect(dom.window.location.hash).toBe(routeBeforeEnter);
    expect(checkbox.checked).toBe(true);
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(dom.window.document.querySelector(".overlay")).toBeNull();
    const checkboxAfterCancel = dom.window.document.querySelector(
      'input[aria-label="Select PRB-1"]',
    );
    if (!(checkboxAfterCancel instanceof dom.window.HTMLInputElement))
      throw new Error("Issue checkbox disappeared");
    expect(checkboxAfterCancel.checked).toBe(true);
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    dom.window.close();
  });

  test("keeps the confirmation and context after an archive error", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const rendered = renderMenu(dom, async () => {
      throw new Error("Archive denied");
    });
    await click(dom, buttonWithText(rendered.document, "Issue actions"));
    await click(dom, buttonWithText(rendered.document, "Archive issue"));
    await click(dom, buttonWithText(rendered.document, "Archive"));
    expect(rendered.document.querySelector(".overlay")?.textContent).toContain("Archive denied");
    expect(rendered.document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => rendered.root.unmount());
    dom.window.close();
  });
});
