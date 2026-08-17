import { describe, expect, test } from "bun:test";
import {
  clearSelection,
  isIssueShortcutTarget,
  selectVisible,
  toggleSelection,
} from "../src/issue-selection.ts";

describe("issue selection helpers", () => {
  test("toggles, selects visible and clears", () => {
    const selected = toggleSelection(new Set(["a"]), "b");
    expect([...selected]).toEqual(["a", "b"]);
    expect([...selectVisible(["c", "d"])]).toEqual(["c", "d"]);
    expect([...clearSelection()]).toEqual([]);
  });

  test("recognizes typing targets but not rows", () => {
    expect(isIssueShortcutTarget({ tagName: "INPUT" } as HTMLElement)).toBe(true);
    expect(isIssueShortcutTarget({ tagName: "DIV", isContentEditable: false } as HTMLElement)).toBe(
      false,
    );
  });
});
