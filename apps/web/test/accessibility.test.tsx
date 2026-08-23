import { afterEach, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IssueActionMenu } from "../src/components/IssueActions.tsx";
import { Switcher } from "../src/components/Switcher.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
  value: () => undefined,
});
Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
  value: () => undefined,
});

afterEach(() => {
  document.body.replaceChildren();
});

function MenuSemanticsFixture() {
  return (
    <>
      <IssueActionMenu
        options={{ states: [], actors: [], labels: [], projects: [], cycles: [] }}
        onAction={async () => undefined}
        onArchive={async () => undefined}
        archiveTarget={{ kind: "issue", identifier: "PRB-1" }}
      />
      <Switcher
        teams={[{ id: "team-1", key: "PRB", name: "Prime Board", projects: [] }]}
        current={{ kind: "team", key: "PRB" }}
        view="team"
      />
    </>
  );
}

describe("accessible menu ownership", () => {
  it("keeps controls outside the owned menu when menus are open", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => root.render(<MenuSemanticsFixture />));

    const actionTrigger = document.querySelector('button[aria-label="Issue actions"]');
    const switcherTrigger = document.querySelector(".switcher-trigger");
    if (!(actionTrigger instanceof HTMLElement) || !(switcherTrigger instanceof HTMLElement)) {
      throw new Error("Menu triggers were not rendered");
    }
    await act(async () => {
      actionTrigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      switcherTrigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    const actionMenu = document.querySelector('.issue-context-menu [role="menu"]');
    const switcherMenu = document.querySelector("#switcher-options");
    expect(actionMenu?.querySelector("select")).toBeNull();
    expect(switcherMenu?.querySelector("input")).toBeNull();
    expect(document.querySelector(".issue-context-menu > label select")).not.toBeNull();
    expect(document.querySelector('.switcher-menu [role="search"] input')).not.toBeNull();

    for (const menu of [actionMenu, switcherMenu]) {
      if (!menu) throw new Error("Expected an open menu");
      for (const child of Array.from(menu.children)) {
        const role = child.getAttribute("role");
        if (!role) throw new Error("Menu child has no role");
        expect(["menuitem", "menuitemcheckbox", "menuitemradio", "group"]).toContain(role);
      }
    }
    await act(async () => root.unmount());
  });
});
