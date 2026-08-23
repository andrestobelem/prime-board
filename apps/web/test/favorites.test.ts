import { describe, expect, it } from "bun:test";
import { gql, GqlError } from "../src/api.ts";
import {
  favoriteMatchesTarget,
  favoriteMutationErrorMessage,
  moveFavorite,
  restoreFavorites,
} from "../src/favorites.ts";
import type { SidebarFavorite } from "../src/components/Sidebar.tsx";

const projectFavorite: SidebarFavorite = {
  id: "favorite-project",
  position: 0,
  project: { id: "project-1", name: "Roadmap" },
  savedView: null,
};
const viewFavorite: SidebarFavorite = {
  id: "favorite-view",
  position: 1,
  project: null,
  savedView: { id: "view-1", name: "Assigned" },
};

describe("favorite feedback state", () => {
  it("applies a successful reorder and keeps contiguous positions", () => {
    expect(moveFavorite([projectFavorite, viewFavorite], projectFavorite.id, 1)).toEqual([
      { ...viewFavorite, position: 0 },
      { ...projectFavorite, position: 1 },
    ]);
    expect(favoriteMatchesTarget(projectFavorite, { projectId: "project-1" })).toBe(true);
    expect(favoriteMatchesTarget(viewFavorite, { savedViewId: "view-1" })).toBe(true);
  });

  it("restores the previous order after a failed reorder", () => {
    const previous = [projectFavorite, viewFavorite];
    const restored = restoreFavorites(previous);

    expect(restored).toEqual(previous);
    expect(restored).not.toBe(previous);
    expect(moveFavorite(previous, "missing", 0)).toBe(previous);
  });

  it("keeps a permission error available for the Retry feedback", async () => {
    const originalFetch = globalThis.fetch;
    const originalStorage = globalThis.localStorage;
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          errors: [
            {
              message: "You do not have permission to update this favorite.",
              extensions: { code: "FORBIDDEN" },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    try {
      await expect(
        gql('mutation { favoriteDelete(id: "favorite-project") { success } }'),
      ).rejects.toBeInstanceOf(GqlError);
      expect(
        favoriteMutationErrorMessage(
          new GqlError("You do not have permission to update this favorite.", "FORBIDDEN"),
        ),
      ).toBe("You do not have permission to update this favorite.");
    } finally {
      globalThis.fetch = originalFetch;
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: originalStorage,
      });
    }
  });
});
