import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { SavedViewPage } from "../src/views/SavedViewPage.tsx";

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

test("SavedViewPage reads and updates actor display preferences", async () => {
  const dom = installDom();
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let stored = {
    layout: "BOARD",
    orderBy: "CREATED_ASC",
    groupBy: "priority",
    columns: ["project"],
  };
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables: Record<string, unknown>;
    };
    requests.push(body);
    if (body.query.includes("viewPreferencesUpdate")) {
      stored = body.variables.input as typeof stored;
      return new Response(JSON.stringify({ data: { viewPreferencesUpdate: { success: true } } }));
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
          data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      );
    }
    throw new Error(`Unexpected query: ${body.query}`);
  }) as typeof fetch;

  const container = dom.window.document.getElementById("root");
  if (!container) throw new Error("Test root is missing.");
  const root = createRoot(container);
  await act(async () => {
    root.render(<SavedViewPage viewId="view-1" />);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  expect(container.textContent).toContain("CREATED_ASC · group by priority · board");
  const orderSelect = container.querySelectorAll("select")[1];
  if (!(orderSelect instanceof dom.window.HTMLSelectElement)) {
    throw new Error("Display order select is missing.");
  }
  await act(async () => {
    orderSelect.value = "UPDATED_ASC";
    orderSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  const preferenceUpdate = requests.find((request) =>
    request.query.includes("viewPreferencesUpdate"),
  );
  expect(preferenceUpdate?.variables.input).toMatchObject({
    viewId: "view-1",
    scope: "ACTOR",
    viewType: "ISSUE",
    orderBy: "UPDATED_ASC",
    groupBy: "priority",
    columns: ["project"],
  });

  await act(async () => {
    root.unmount();
  });
});
