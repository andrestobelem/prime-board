import { describe, expect, test } from "bun:test";
import {
  defaultViewPreferences,
  normalizeViewPreferences,
  sameViewPreferences,
  viewPreferencesInput,
} from "../src/view-preferences.ts";

describe("saved view display preferences", () => {
  test("uses API values instead of local defaults", () => {
    const preferences = normalizeViewPreferences({
      layout: "BOARD",
      orderBy: "CREATED_ASC",
      groupBy: "priority",
      columns: ["project", "cycle"],
    });

    expect(preferences).toEqual({
      layout: "BOARD",
      orderBy: "CREATED_ASC",
      groupBy: "priority",
      columns: ["project", "cycle"],
    });
  });

  test("keeps an intentionally empty API column selection", () => {
    expect(normalizeViewPreferences({ columns: [] }).columns).toEqual([]);
  });

  test("falls back to safe defaults for unknown values", () => {
    expect(
      normalizeViewPreferences({
        layout: "GRID",
        orderBy: "RANDOM",
        groupBy: "unknown",
      }),
    ).toEqual(defaultViewPreferences());
    expect(normalizeViewPreferences({ columns: ["unknown"] }).columns).toEqual([]);
  });

  test("builds an actor-scoped update for a saved view", () => {
    const preferences = normalizeViewPreferences({
      layout: "LIST",
      orderBy: "UPDATED_ASC",
      groupBy: "assignee",
      columns: ["assignee"],
    });

    expect(viewPreferencesInput(preferences, "view-1")).toEqual({
      viewId: "view-1",
      viewType: "ISSUE",
      scope: "ACTOR",
      layout: "LIST",
      orderBy: "UPDATED_ASC",
      groupBy: "assignee",
      columns: ["assignee"],
    });
    expect(sameViewPreferences(preferences, preferences)).toBe(true);
    expect(sameViewPreferences(preferences, { ...preferences, columns: ["priority"] })).toBe(false);
  });
});
