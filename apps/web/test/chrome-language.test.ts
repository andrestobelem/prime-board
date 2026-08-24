import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import { Sidebar } from "../src/components/Sidebar.tsx";

const chromeSources = [
  "src/App.tsx",
  "src/components/IssueList.tsx",
  "src/views/BoardView.tsx",
  "src/views/ProjectView.tsx",
].map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("frontend chrome language", () => {
  it("keeps the visible list and board chrome in English", () => {
    const source = chromeSources.join("\n");
    for (const spanishChrome of [
      "Agrupar por",
      "Sin milestone",
      "Sin assignee",
      "Sin prioridad",
      "Estados y labels",
    ]) {
      expect(source).not.toContain(spanishChrome);
    }
  });

  it("renders the Favorites heading in normal casing", async () => {
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
      url: "http://localhost/",
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    const previousNode = globalThis.Node;
    const previousActEnvironment = Object.getOwnPropertyDescriptor(
      globalThis,
      "IS_REACT_ACT_ENVIRONMENT",
    );
    let root: Root | undefined;

    try {
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        Node: dom.window.Node,
        IS_REACT_ACT_ENVIRONMENT: true,
      });
      const style = dom.window.document.createElement("style");
      style.textContent = stylesSource;
      dom.window.document.head.append(style);
      const container = dom.window.document.createElement("div");
      dom.window.document.body.append(container);
      root = createRoot(container);
      await act(async () => {
        root?.render(
          createElement(Sidebar, {
            workspace: { name: "Workspace" },
            teams: [],
            onToggleFavorite: () => undefined,
          }),
        );
      });

      const heading = container.querySelector(".favorites-heading");
      if (!heading) throw new Error("Favorites heading was not rendered");
      expect(heading.textContent?.trim()).toBe("Favorites");
      expect(dom.window.getComputedStyle(heading).textTransform).toBe("none");
    } finally {
      await act(async () => root?.unmount());
      Object.assign(globalThis, {
        window: previousWindow,
        document: previousDocument,
        HTMLElement: previousHTMLElement,
        Node: previousNode,
      });
      if (previousActEnvironment) {
        Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
      } else {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      }
      dom.window.close();
    }
  });
});
