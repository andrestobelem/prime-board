import { describe, expect, test } from "bun:test";
import { nextBoardFocusId } from "../src/board-keyboard.ts";

describe("board keyboard focus", () => {
  const ids = ["one", "two", "three"];
  test("moves through visible cards with J/K and arrows", () => {
    expect(nextBoardFocusId(ids, null, "j")).toBe("one");
    expect(nextBoardFocusId(ids, "one", "ArrowDown")).toBe("two");
    expect(nextBoardFocusId(ids, "two", "k")).toBe("one");
    expect(nextBoardFocusId(ids, "one", "ArrowUp")).toBe("one");
    expect(nextBoardFocusId(ids, "three", "j")).toBe("three");
  });
  test("does not focus a card when the board is empty", () => {
    expect(nextBoardFocusId([], null, "j")).toBeNull();
  });
});
