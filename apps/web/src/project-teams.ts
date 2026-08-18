export function parseTeamIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

export function serializeTeamIds(ids: string[]): string {
  return [...new Set(ids)].join(",");
}

/** Return team IDs only when the project membership set actually changed. */
export function changedTeamIds(currentIds: string[], nextIds: string[]): string[] | undefined {
  const current = new Set(currentIds);
  if (nextIds.length === current.size && nextIds.every((id) => current.has(id))) return undefined;
  return nextIds;
}
