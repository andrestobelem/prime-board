export type MyIssuesMode = "assigned" | "created" | "handoff" | "subscribed";

export interface MyIssuesScopeCopy {
  description: string;
  emptyState: string;
}

/** Construye el alcance con el Actor autenticado, sin aceptar un Actor externo. */
export function buildMyIssuesOwnerFilter(
  viewerId: string | undefined,
  mode: MyIssuesMode,
): Record<string, unknown> {
  if (!viewerId) return { search: "__pending__" };

  const actor = { eq: viewerId };
  if (mode === "assigned") return { assignee: actor };
  if (mode === "created") return { creator: actor };
  if (mode === "subscribed") return { subscribed: true };
  return { or: [{ assignee: actor }, { creator: actor }] };
}

/** Explica el alcance que se está consultando y su estado vacío. */
export function getMyIssuesScopeCopy(mode: MyIssuesMode, viewerName: string): MyIssuesScopeCopy {
  if (mode === "assigned") {
    return {
      description: `Issues assigned to ${viewerName}`,
      emptyState: `No issues assigned to ${viewerName}.`,
    };
  }
  if (mode === "created") {
    return {
      description: `Issues created by ${viewerName}`,
      emptyState: `No issues created by ${viewerName}.`,
    };
  }
  if (mode === "subscribed") {
    return {
      description: `Issues followed by ${viewerName}`,
      emptyState: `No issues followed by ${viewerName}.`,
    };
  }
  return {
    description: `Issues assigned to or created by ${viewerName}`,
    emptyState: `No issues assigned to or created by ${viewerName}.`,
  };
}
