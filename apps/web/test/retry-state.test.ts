import { readFileSync } from "node:fs";
import { describe, expect, it, mock } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";

interface QueryState {
  data: unknown;
  error: { message: string } | null;
  loading: boolean;
  refetch: () => void;
}

const queryStates = new Map<string, QueryState>();
let apiGql: (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown> = async () => ({});

function queryKey(query: string): string {
  if (query.includes("reviews(")) return "reviews";
  if (query.includes("actors {") && query.includes("projects {")) return "reviewsMeta";
  if (query.includes("cycle(id:")) return "cycleMeta";
  if (query.includes("issues(filter:")) return "cycleList";
  if (query.includes("apiKeys")) return "members";
  return "default";
}

mock.module("../src/api.ts", () => ({
  GqlError: class GqlError extends Error {},
  gql: (query: string, variables: Record<string, unknown>) => apiGql(query, variables),
  mutate: async () => ({}),
  useQuery: (query: string) =>
    queryStates.get(queryKey(query)) ?? {
      data: null,
      error: { message: "unexpected query" },
      loading: false,
      refetch: () => {},
    },
}));

function setQueryState(key: string, state: Partial<QueryState>): void {
  queryStates.set(key, {
    data: null,
    error: null,
    loading: false,
    refetch: () => {},
    ...state,
  });
}

function source(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

function installDom(): JSDOM {
  const dom = new JSDOM(`<!doctype html><div id="root"></div>`, {
    url: "http://localhost/",
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return dom;
}

describe("estados de retry de la SPA", () => {
  it("ofrece Retry en el error inicial y conserva el contrato común en las vistas", async () => {
    setQueryState("members", { error: { message: "Members unavailable" } });
    const { MembersView } = await import("../src/views/MembersView.tsx");
    const html = renderToStaticMarkup(React.createElement(MembersView));

    expect(html).toContain("Members unavailable");
    expect(html).toContain("Retry");
    for (const view of [
      "views/CycleView.tsx",
      "views/ReviewsView.tsx",
      "views/InitiativeView.tsx",
      "views/MembersView.tsx",
      "views/TeamSettingsView.tsx",
      "views/IssueView.tsx",
    ]) {
      expect(source(view)).toContain("ErrorState");
      expect(source(view)).toContain("onRetry");
    }
    expect(source("App.tsx")).toContain("workspaceRetryToken");
    expect(source("App.tsx")).toContain("onRetry={() => setWorkspaceRetryToken");
  });

  it("mantiene la acción principal cuando falla el metadata de Reviews", async () => {
    setQueryState("reviewsMeta", { error: { message: "Metadata unavailable" } });
    setQueryState("reviews", {
      data: {
        reviews: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    const { ReviewsView } = await import("../src/views/ReviewsView.tsx");
    const html = renderToStaticMarkup(React.createElement(ReviewsView));

    expect(html).toContain("Metadata unavailable");
    expect(html).toContain("Retry");
    expect(html).toContain("Request review");
  });

  it("muestra la vista exitosa con permisos de solo lectura", async () => {
    setQueryState("cycleMeta", {
      data: {
        viewer: { id: "viewer", workspaceRole: "MEMBER" },
        cycle: {
          id: "cycle",
          name: "Sprint",
          number: 1,
          state: "ACTIVE",
          startsAt: "2026-01-01",
          endsAt: "2026-01-14",
          progress: 0,
          completedIssues: 0,
          totalIssues: 0,
          team: {
            id: "team",
            key: "PRB",
            name: "Prime Board",
            memberships: [{ actorId: "viewer", role: "MEMBER" }],
          },
        },
      },
    });
    setQueryState("cycleList", {
      data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    });
    const { CycleView } = await import("../src/views/CycleView.tsx");
    const html = renderToStaticMarkup(React.createElement(CycleView, { cycleId: "cycle" }));

    expect(html).toContain("Sprint");
    expect(html).toContain("Read-only");
    expect(html).not.toContain(">Start</button>");
  });

  it("ofrece Retry al fallar la página siguiente y conserva los resultados actuales", async () => {
    const dom = installDom();
    setQueryState("reviewsMeta", {
      data: { actors: [], teams: [], projects: [] },
    });
    setQueryState("reviews", {
      data: {
        reviews: {
          nodes: [
            {
              id: "review-1",
              status: "REQUESTED",
              createdAt: "2026-01-01",
              requester: { id: "requester", name: "Requester", type: "HUMAN" },
              reviewer: { id: "reviewer", name: "Reviewer", type: "HUMAN" },
              issue: { identifier: "PRB-1", title: "Current review" },
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    });
    apiGql = async (_query, variables) => {
      if (variables.after) throw new Error("Next page unavailable");
      return {};
    };
    const { ReviewsView } = await import("../src/views/ReviewsView.tsx");
    const container = dom.window.document.getElementById("root");
    if (!container) throw new Error("Test root is missing.");
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(ReviewsView));
    });
    const loadMore = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more",
    );
    if (!loadMore) throw new Error("Load more action is missing.");
    await act(async () => {
      loadMore.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Current review");
    expect(container.textContent).toContain("Next page unavailable");
    expect(container.textContent).toContain("Retry");
    await act(async () => {
      root.unmount();
    });
  });
});
