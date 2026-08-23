import type { SidebarFavorite } from "./components/Sidebar.tsx";

export type FavoriteTarget = { projectId: string } | { savedViewId: string };

export function favoriteMatchesTarget(favorite: SidebarFavorite, target: FavoriteTarget): boolean {
  return "projectId" in target
    ? favorite.project?.id === target.projectId
    : favorite.savedView?.id === target.savedViewId;
}

export function favoriteMutationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Could not update favorite.";
}

export function restoreFavorites(favorites: SidebarFavorite[]): SidebarFavorite[] {
  return favorites.map((favorite) => ({ ...favorite }));
}

/** Moves a favorite and rewrites positions to match the sidebar order. */
export function moveFavorite(
  favorites: SidebarFavorite[],
  favoriteId: string,
  position: number,
): SidebarFavorite[] {
  const currentIndex = favorites.findIndex((favorite) => favorite.id === favoriteId);
  if (currentIndex < 0) return favorites;

  const next = [...favorites];
  const selected = next.splice(currentIndex, 1)[0];
  if (!selected) return favorites;

  const targetIndex = Math.max(0, Math.min(position, next.length));
  next.splice(targetIndex, 0, selected);
  return next.map((favorite, index) => ({ ...favorite, position: index }));
}
