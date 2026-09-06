import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { JSDOM } from "jsdom";

type QueryState = {
  data: unknown;
  error: null;
  loading: false;
  refetch: () => void;
};

const issueState = { id: "state-1", name: "Todo", type: "BACKLOG", color: "#999", position: 0 };
const issue = {
  id: "issue-1",
  identifier: "PRB-1",
  title: "Comment refresh",
  description: "",
  priority: 0,
  url: "http://localhost:3333/issue/PRB-1",
  branchName: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  team: {
    id: "team-1",
    key: "PRB",
    name: "Prime Board",
    accessPolicy: "WORKSPACE_MEMBERS",
    memberships: [],
    states: [issueState],
    labels: [],
    projects: [],
    cycles: [],
  },
  state: issueState,
  assignee: null,
  creator: { id: "actor-1", name: "admin", type: "HUMAN" },
  subscribers: [],
  cycle: null,
  parent: null,
  children: [],
  labels: [],
  project: null,
  milestone: null,
  relations: [],
  archivedAt: null,
  activity: [],
};

let persistedComment: string | null = null;
let visibleComment: string | null = null;
let issueRefetches = 0;
const navigationData = {
  issues: {
    nodes: [{ id: issue.id, identifier: issue.identifier }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

function issueComments() {
  return visibleComment
    ? [
        {
          id: "comment-1",
          body: visibleComment,
          actor: { name: "admin", type: "HUMAN" },
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ]
    : [];
}

function commentBody(variables: Record<string, unknown>): string {
  const input = variables.input;
  if (!input || typeof input !== "object" || !("body" in input)) {
    throw new Error("Comment mutation has no body");
  }
  const body = input.body;
  if (typeof body !== "string") throw new Error("Comment body is not a string");
  return body;
}

mock.module("../src/api.ts", () => ({
  gql: async () => ({}),
  mutate: async (_query: string, variables: Record<string, unknown>) => {
    persistedComment = commentBody(variables);
    return { commentCreate: { comment: { id: "comment-1" } } };
  },
  useQuery: (query: string): QueryState => {
    const isIssueQuery = query.includes("issue(id:");
    const [, rerender] = useState(0);
    if (!isIssueQuery) {
      return {
        data: navigationData,
        error: null,
        loading: false,
        refetch: () => undefined,
      };
    }
    return {
      data: {
        viewer: { id: "actor-1" },
        issue: { ...issue, comments: issueComments() },
        actors: [{ id: "actor-1", name: "admin", type: "HUMAN", status: "ACTIVE" }],
      },
      error: null,
      loading: false,
      refetch: () => {
        visibleComment = persistedComment;
        issueRefetches += 1;
        rerender((value) => value + 1);
      },
    };
  },
}));

describe("Comments de Issues", () => {
  test("muestra un Comment recién creado sin recargar la página", async () => {
    persistedComment = null;
    visibleComment = null;
    issueRefetches = 0;
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "http://localhost/#/issue/PRB-1",
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      localStorage: dom.window.localStorage,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
      Node: dom.window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { IssueView } = await import("../src/views/IssueView.tsx");
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(createElement(IssueView, { issueRef: "PRB-1" }));
      });

      const commentInput = dom.window.document.querySelector(
        'textarea[placeholder^="Leave a comment"]',
      );
      if (!(commentInput instanceof dom.window.HTMLTextAreaElement)) {
        throw new Error("Comment input was not rendered");
      }
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (!valueSetter) throw new Error("Comment input has no value setter");
      valueSetter.call(commentInput, "Fresh comment");
      await act(async () => {
        commentInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });

      const commentButton = Array.from(dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Comment",
      );
      if (!(commentButton instanceof dom.window.HTMLElement)) {
        throw new Error("Comment button was not rendered");
      }
      await act(async () => {
        commentButton.click();
      });

      expect(issueRefetches).toBe(1);
      expect(dom.window.document.querySelector(".comment")?.textContent).toContain("Fresh comment");
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
});
