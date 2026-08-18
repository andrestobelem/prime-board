/** Merge a cursor page while preserving the first occurrence of each entity. */
export function appendUniqueById<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  const added: T[] = [];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    added.push(item);
  }
  return [...current, ...added];
}
