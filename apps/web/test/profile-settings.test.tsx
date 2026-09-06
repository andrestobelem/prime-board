import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { MembersView } from "../src/views/MembersView.tsx";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;
const originalHTMLElement = globalThis.HTMLElement;
const originalNode = globalThis.Node;

const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];

afterEach(() => {
  requests.length = 0;
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

async function renderMembers(): Promise<{ dom: JSDOM; root: Root }> {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value: () => {},
  });
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
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      requests.push({ query: body.query, variables: body.variables ?? {} });
      const data = body.query.includes("actorUpdate")
        ? {
            actorUpdate: {
              actor: {
                id: "actor-1",
                name: "Admin",
                email: null,
                avatarUrl: "https://example.com/avatar.png",
              },
            },
          }
        : {
            viewer: { id: "actor-1", workspaceRole: "ADMIN" },
            actors: [
              {
                id: "actor-1",
                name: "Admin",
                email: null,
                avatarUrl: "https://example.com/avatar.png",
                type: "HUMAN",
                status: "ACTIVE",
                createdAt: "2026-01-01T00:00:00.000Z",
                apiKeys: [],
              },
            ],
            teams: [],
          };
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MembersView));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { dom, root };
}

describe("actor profile UI", () => {
  test("renders the avatar and sends it through the existing actorUpdate form", async () => {
    const { dom, root } = await renderMembers();
    const document = dom.window.document;
    expect(document.querySelector('img[src="https://example.com/avatar.png"]')).not.toBeNull();

    const edit = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(edit).not.toBeUndefined();
    await act(async () => {
      edit!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    const avatarInput = Array.from(document.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("Avatar URL"))
      ?.querySelector("input");
    expect(avatarInput?.value).toBe("https://example.com/avatar.png");
    const save = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Save",
    );
    await act(async () => {
      save!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const update = requests.find((request) => request.query.includes("actorUpdate"));
    expect(update?.variables.input).toMatchObject({
      avatarUrl: "https://example.com/avatar.png",
    });

    await act(async () => root.unmount());
    dom.window.close();
  });
});
