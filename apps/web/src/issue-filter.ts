export interface IssueFilterDraft {
  search: string;
  stateId: string;
  assigneeId: string;
  priority: string;
  labelId: string;
  projectId: string;
  milestoneId: string;
  cycleId: string;
  parentId: string;
  creatorId: string;
  unblocked: string;
}

export const EMPTY_ISSUE_FILTER: IssueFilterDraft = {
  search: "",
  stateId: "",
  assigneeId: "",
  priority: "",
  labelId: "",
  projectId: "",
  milestoneId: "",
  cycleId: "",
  parentId: "",
  creatorId: "",
  unblocked: "",
};

export function buildIssueFilter(
  teamId: string | null,
  draft: IssueFilterDraft,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (teamId) filter.team = { eq: teamId };
  if (draft.search.trim()) filter.search = draft.search.trim();
  if (draft.stateId) {
    filter.state = draft.stateId === "__none__" ? { null: true } : { eq: draft.stateId };
  }
  if (draft.assigneeId) {
    filter.assignee = draft.assigneeId === "__none__" ? { null: true } : { eq: draft.assigneeId };
  }
  if (draft.priority) filter.priority = { eq: Number(draft.priority) };
  if (draft.labelId) filter.labels = { includes: draft.labelId };
  for (const [key, value] of [
    ["project", draft.projectId],
    ["milestone", draft.milestoneId],
    ["cycle", draft.cycleId],
    ["parent", draft.parentId],
    ["creator", draft.creatorId],
  ] as const) {
    if (value) filter[key] = value === "__none__" ? { null: true } : { eq: value };
  }
  if (draft.unblocked) filter.unblocked = draft.unblocked === "true";
  return filter;
}

export function activeIssueFilterCount(draft: IssueFilterDraft): number {
  return [
    draft.search.trim(),
    draft.stateId,
    draft.assigneeId,
    draft.priority,
    draft.labelId,
    draft.projectId,
    draft.milestoneId,
    draft.cycleId,
    draft.parentId,
    draft.creatorId,
    draft.unblocked,
  ].filter(Boolean).length;
}

export function loadIssueFilter(teamKey: string): IssueFilterDraft {
  try {
    const raw = localStorage.getItem(`pb.issue-filter.${teamKey}`);
    if (!raw) return EMPTY_ISSUE_FILTER;
    return { ...EMPTY_ISSUE_FILTER, ...(JSON.parse(raw) as Partial<IssueFilterDraft>) };
  } catch {
    return EMPTY_ISSUE_FILTER;
  }
}

export function saveIssueFilter(teamKey: string, draft: IssueFilterDraft): void {
  try {
    localStorage.setItem(`pb.issue-filter.${teamKey}`, JSON.stringify(draft));
  } catch {
    // La persistencia es una mejora; la consulta actual sigue funcionando sin storage.
  }
}
