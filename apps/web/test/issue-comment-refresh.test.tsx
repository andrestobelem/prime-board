import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { JSDOM } from "jsdom";

type QueryState = {
  data: unknown;
  error: null;
  loading: false;
  refetch: () => Promise<void>;
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
let mutationError: string | null = null;
let issueRefetches = 0;
let issueRefetch: (() => Promise<void>) | null = null;
let refreshDelay: Promise<void> | null = null;
let releaseRefresh: (() => void) | null = null;
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
  mutate: async (
    _query: string,
    variables: Record<string, unknown>,
    options: { notify?: boolean } = {},
  ) => {
    if (mutationError) throw new Error(mutationError);
    persistedComment = commentBody(variables);
    if (options.notify !== false) await issueRefetch?.();
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
        refetch: async () => undefined,
      };
    }
    const refreshIssue = async () => {
      issueRefetches += 1;
      if (refreshDelay) await refreshDelay;
      visibleComment = persistedComment;
      rerender((value) => value + 1);
    };
    issueRefetch = refreshIssue;
    return {
      data: {
        viewer: { id: "actor-1" },
        issue: { ...issue, comments: issueComments() },
        actors: [{ id: "actor-1", name: "admin", type: "HUMAN", status: "ACTIVE" }],
      },
      error: null,
      loading: false,
      refetch: refreshIssue,
    };
  },
}));

type ReactAct = typeof import("react").act;
type TestRoot = ReturnType<typeof import("react-dom/client").createRoot>;

function resetMockState(): void {
  persistedComment = null;
  visibleComment = null;
  mutationError = null;
  issueRefetches = 0;
  issueRefetch = null;
  refreshDelay = null;
  releaseRefresh = null;
}

async function renderIssue(): Promise<{ dom: JSDOM; root: TestRoot; act: ReactAct }> {
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
  await act(async () => {
    root.render(createElement(IssueView, { issueRef: "PRB-1" }));
  });
  return { dom, root, act };
}

function enterComment(dom: JSDOM, body: string): void {
  const input = dom.window.document.querySelector('textarea[placeholder^="Leave a comment"]');
  if (!(input instanceof dom.window.HTMLTextAreaElement)) {
    throw new Error("Comment input was not rendered");
  }
  const valueSetter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (!valueSetter) throw new Error("Comment input has no value setter");
  valueSetter.call(input, body);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function commentButton(dom: JSDOM): HTMLElement {
  const button = Array.from(dom.window.document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "Comment",
  );
  if (!(button instanceof dom.window.HTMLElement)) {
    throw new Error("Comment button was not rendered");
  }
  return button;
}

describe("Issue comments", () => {
  test("shows a newly created comment without reloading the page", async () => {
    resetMockState();
    refreshDelay = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const { dom, root, act } = await renderIssue();

    try {
      await act(async () => enterComment(dom, "Fresh comment"));
      await act(async () => {
        commentButton(dom).click();
        await Promise.resolve();
      });

      const input = dom.window.document.querySelector('textarea[placeholder^="Leave a comment"]');
      if (!(input instanceof dom.window.HTMLTextAreaElement)) {
        throw new Error("Comment input was not rendered");
      }
      expect(issueRefetches).toBe(1);
      expect(dom.window.document.querySelector(".save-notice")).toBeNull();
      expect(input.value).toBe("Fresh comment");

      const release = releaseRefresh;
      if (!release) throw new Error("Issue refresh did not start");
      await act(async () => {
        release();
        await Promise.resolve();
      });

      const renderedComment = dom.window.document.querySelector(".comment");
      expect(issueRefetches).toBe(1);
      expect(renderedComment?.textContent).toContain("Fresh comment");
      expect(renderedComment?.querySelector(".author")?.textContent).toBe("admin");
      expect(renderedComment?.querySelector(".meta")?.textContent).toContain("1/1/2026");
    } finally {
      releaseRefresh?.();
      await act(async () => root.unmount());
      dom.window.close();
    }
  });

  test("preserves the comment and does not add content when the mutation fails", async () => {
    resetMockState();
    mutationError = "Comment failed";
    const { dom, root, act } = await renderIssue();

    try {
      await act(async () => enterComment(dom, "Retry this comment"));
      await act(async () => commentButton(dom).click());

      const input = dom.window.document.querySelector('textarea[placeholder^="Leave a comment"]');
      if (!(input instanceof dom.window.HTMLTextAreaElement)) {
        throw new Error("Comment input disappeared after the error");
      }
      expect(issueRefetches).toBe(0);
      expect(dom.window.document.querySelector(".comment")).toBeNull();
      expect(input.disabled).toBe(false);
      expect(input.value).toBe("Retry this comment");
      expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain(
        "Comment failed",
      );
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });

  test("does not duplicate the comment when multiple refreshes arrive", async () => {
    resetMockState();
    const { dom, root, act } = await renderIssue();

    try {
      await act(async () => enterComment(dom, "One comment"));
      await act(async () => commentButton(dom).click());
      await act(async () => {
        await issueRefetch?.();
        await issueRefetch?.();
      });
      expect(dom.window.document.querySelectorAll(".comment")).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
});
