export function nextBoardFocusId(
  ids: readonly string[],
  focusedId: string | null,
  key: string,
): string | null {
  if (!ids.length) return null;
  const current = focusedId ? ids.indexOf(focusedId) : -1;
  const next =
    key === "j" || key === "ArrowDown"
      ? Math.min(current + 1, ids.length - 1)
      : Math.max(current < 0 ? 0 : current - 1, 0);
  return ids[next] ?? null;
}
