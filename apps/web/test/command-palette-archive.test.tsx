import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { ArchiveConfirmModal } from "../src/components/ArchiveConfirmModal.tsx";
import { Palette } from "../src/components/Palette.tsx";
import type { ShellData } from "../src/App.tsx";
import { archiveIssueFromPalette, archiveMutation } from "../src/issue-actions.ts";
import { navigate } from "../src/router.tsx";

type Archive = (issueRef: string) => Promise<{ success: boolean }>;

const shell: ShellData = {
  viewer: { id: "viewer-1", name: "Viewer", type: "user" },
  workspace: { id: "workspace-1", name: "Workspace" },
  teams: [
    {
      id: "team-1",
      key: "PRB",
      name: "Prime Board",
      accessPolicy: "PUBLIC",
      projects: [],
      cycles: [],
    },
  ],
  initiatives: [],
  savedViews: [],
  favorites: [],
  inboxUnreadCount: 0,
};

function installDom(dom: JSDOM): void {
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
}

function buttonWithText(document: Document, text: string): Element {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim().startsWith(text) ?? false,
  );
  if (!button) throw new Error(`Button ${text} not found`);
  return button;
}

async function click(dom: JSDOM, element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

function ArchivePaletteHarness({ archive }: { archive: Archive }) {
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [archiveOpen, setArchiveOpen] = useState(false);

  return (
    <>
      {paletteOpen && (
        <Palette
          shell={shell}
          onClose={() => setPaletteOpen(false)}
          onNewIssue={() => undefined}
          currentIssueRef="PRB-1"
          onArchiveCurrentIssue={() => {
            setArchiveOpen(true);
            return Promise.resolve();
          }}
        />
      )}
      {archiveOpen && (
        <ArchiveConfirmModal
          target={{ kind: "issue", identifier: "PRB-1" }}
          onClose={() => setArchiveOpen(false)}
          onConfirm={() =>
            archiveIssueFromPalette("PRB-1", archive, () => {
              setArchiveOpen(false);
              navigate("/my");
            })
          }
        />
      )}
    </>
  );
}

function render(dom: JSDOM, archive: Archive): { root: Root; document: Document } {
  installDom(dom);
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ArchivePaletteHarness, { archive })));
  return { root, document: dom.window.document };
}

describe("Command Palette archive", () => {
  test("calls issueArchive and navigates to the existing My issues route", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "http://localhost/#/issue/PRB-1",
    });
    const requests: Array<{ query: string; variables: Record<string, string> }> = [];
    const rendered = render(dom, async (issueRef) => {
      requests.push({ query: archiveMutation(), variables: { id: issueRef } });
      return { success: true };
    });

    await click(dom, buttonWithText(rendered.document, "Archive issue PRB-1"));
    await click(dom, buttonWithText(rendered.document, "Archive"));

    expect(requests).toEqual([
      {
        query: "mutation($id: ID!) { issueArchive(id: $id) { success } }",
        variables: { id: "PRB-1" },
      },
    ]);
    expect(dom.window.location.hash).toBe("#/my");
    expect(rendered.document.querySelector(".overlay")).toBeNull();

    await act(async () => rendered.root.unmount());
    dom.window.close();
  });

  test("keeps the route and confirmation open after an archive error, then allows retry", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "http://localhost/#/issue/PRB-1",
    });
    const outcomes = [false, true];
    const requests: string[] = [];
    const rendered = render(dom, async (issueRef) => {
      requests.push(issueRef);
      return { success: outcomes.shift() ?? true };
    });
    const routeBeforeArchive = dom.window.location.hash;

    await click(dom, buttonWithText(rendered.document, "Archive issue PRB-1"));
    await click(dom, buttonWithText(rendered.document, "Archive"));

    expect(requests).toEqual(["PRB-1"]);
    expect(dom.window.location.hash).toBe(routeBeforeArchive);
    expect(rendered.document.querySelector(".overlay")?.textContent).toContain(
      "The issue could not be archived.",
    );

    await click(dom, buttonWithText(rendered.document, "Archive"));
    expect(requests).toEqual(["PRB-1", "PRB-1"]);
    expect(dom.window.location.hash).toBe("#/my");
    expect(rendered.document.querySelector(".overlay")).toBeNull();

    await act(async () => rendered.root.unmount());
    dom.window.close();
  });
});
