import { beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IssueActionMenu } from "../src/components/IssueActions.tsx";
import {
  focusBoardCard,
  isBoardInteractiveTarget,
  nextBoardFocusId,
} from "../src/board-keyboard.ts";

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><div></div>");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

describe("board keyboard focus", () => {
  const ids = ["one", "two", "three"];
  test("moves through visible cards with J/K and arrows", () => {
    expect(nextBoardFocusId(ids, null, "j")).toBe("one");
    expect(nextBoardFocusId(ids, "one", "ArrowDown")).toBe("two");
    expect(nextBoardFocusId(ids, "two", "k")).toBe("one");
    expect(nextBoardFocusId(ids, "three", "j")).toBe("three");
  });
  test("focuses and scrolls the visible card", () => {
    const card = document.createElement("div");
    card.tabIndex = 0;
    let scrolled = false;
    card.scrollIntoView = () => {
      scrolled = true;
    };
    document.body.append(card);
    focusBoardCard(card);
    expect(scrolled).toBe(true);
    expect(document.activeElement).toBe(card);
    focusBoardCard(null);
  });
  test("isolates Enter and Space from card controls", () => {
    const root = document.createElement("div");
    const checkbox = document.createElement("input");
    const menu = document.createElement("button");
    root.append(checkbox, menu);
    expect(isBoardInteractiveTarget(checkbox)).toBe(true);
    expect(isBoardInteractiveTarget(menu)).toBe(true);
    expect(isBoardInteractiveTarget(root)).toBe(false);
  });
  test("renders accessible Move to actions for Team states", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <IssueActionMenu
          options={{
            stateActionLabel: "Move to",
            states: [{ id: "s1", name: "Todo" }],
            actors: [],
            labels: [],
            projects: [],
            cycles: [],
          }}
          onAction={async () => {}}
          onArchive={async () => {}}
          archiveTarget={{ kind: "issue", identifier: "PRB-1" }}
        />,
      ),
    );
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Issue actions"]');
    if (!(button instanceof HTMLElement)) throw new Error("Issue actions button was not rendered");
    await act(async () => button.click());
    expect(host.querySelector("option")?.textContent).toBe("Move to…");
    expect(host.textContent).toContain("Move to: Todo");
    root.unmount();
  });
});
