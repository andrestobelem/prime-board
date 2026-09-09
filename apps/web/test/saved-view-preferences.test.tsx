import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { SavedViewPage } from "../src/views/SavedViewPage.tsx";

interface ViewPreferences {
  layout: string;
  orderBy: string;
  groupBy: string;
  columns: string[];
}

interface RequestBody {
  query: string;
  variables: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequestBody(init: RequestInit | undefined): RequestBody {
  const parsed: unknown = JSON.parse(String(init?.body ?? "{}"));
  if (!isRecord(parsed) || typeof parsed.query !== "string") {
    throw new Error("GraphQL request body is invalid.");
  }
  return {
    query: parsed.query,
    variables: isRecord(parsed.variables) ? parsed.variables : {},
  };
}

function readPreferences(input: unknown): ViewPreferences {
  if (!isRecord(input)) throw new Error("Preference input is missing.");
  const { layout, orderBy, groupBy, columns } = input;
  if (
    typeof layout !== "string" ||
    typeof orderBy !== "string" ||
    typeof groupBy !== "string" ||
    !Array.isArray(columns) ||
    !columns.every((column) => typeof column === "string")
  ) {
    throw new Error("Preference input is invalid.");
  }
  return {
    layout,
    orderBy,
    groupBy,
    columns: columns.filter((column): column is string => typeof column === "string"),
  };
}

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://localhost/",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom;
}

describe("SavedViewPage display layout", () => {
  test("renders the persisted board and switches back to list", async () => {
    const dom = installDom();
    const requests: RequestBody[] = [];
    let stored: ViewPreferences = {
      layout: "BOARD",
      orderBy: "CREATED_ASC",
      groupBy: "priority",
      columns: ["project"],
    };
    const fetchStub = Object.assign(
      async (_input: URL | RequestInfo, init: RequestInit | undefined) => {
        const body = readRequestBody(init);
        requests.push(body);
        if (body.query.includes("viewPreferencesUpdate")) {
          stored = readPreferences(body.variables.input);
          return new Response(
            JSON.stringify({ data: { viewPreferencesUpdate: { success: true } } }),
          );
        }
        if (body.query.includes("savedView(id:")) {
          return new Response(
            JSON.stringify({
              data: {
                savedView: {
                  id: "view-1",
                  name: "Project view",
                  scope: "PROJECT",
                  filter: {},
                  orderBy: "UPDATED_DESC",
                  groupBy: "state",
                  columns: ["priority"],
                  preferences: stored,
                  team: null,
                },
              },
            }),
          );
        }
        if (body.query.includes("issues(")) {
          return new Response(
            JSON.stringify({
              data: {
                issues: {
                  nodes: [
                    {
                      id: "issue-1",
                      identifier: "PB-1",
                      title: "Board issue",
                      priority: 2,
                      state: { id: "state-1", name: "In Progress", type: "STARTED", position: 1 },
                      assignee: null,
                      labels: [],
                      project: null,
                      cycle: null,
                      milestone: null,
                      parent: null,
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            }),
          );
        }
        throw new Error(`Unexpected query: ${body.query}`);
      },
      { preconnect: () => {} },
    );
    globalThis.fetch = fetchStub;

    const container = dom.window.document.getElementById("root");
    if (!container) throw new Error("Test root is missing.");
    const root = createRoot(container);
    await act(async () => {
      root.render(<SavedViewPage viewId="view-1" />);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector("[data-saved-view-layout=board]")).not.toBeNull();
    expect(container.querySelector(".board-card")?.textContent).toContain("PB-1");
    expect(container.textContent).toContain("CREATED_ASC · group by priority · board");

    const layoutSelect = container.querySelector('select[aria-label="Layout"]');
    if (!(layoutSelect instanceof dom.window.HTMLSelectElement)) {
      throw new Error("Display layout select is missing.");
    }
    await act(async () => {
      layoutSelect.value = "LIST";
      layoutSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector("[data-saved-view-layout=board]")).toBeNull();
    expect(container.querySelector(".issue-row")?.textContent).toContain("PB-1");
    const preferenceUpdate = requests.find((request) =>
      request.query.includes("viewPreferencesUpdate"),
    );
    if (!preferenceUpdate) throw new Error("Display preference update is missing.");
    const input = preferenceUpdate.variables.input;
    if (!isRecord(input)) throw new Error("Display preference input is missing.");
    expect(input).toMatchObject({
      viewId: "view-1",
      scope: "ACTOR",
      viewType: "ISSUE",
      layout: "LIST",
      orderBy: "CREATED_ASC",
      groupBy: "priority",
      columns: ["project"],
    });

    await act(async () => {
      root.unmount();
    });
  });
});
