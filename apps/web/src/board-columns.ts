import type { IssueColumn } from "./components/DisplayOptions.tsx";

interface BoardMetadataIssue {
  project?: { name: string } | null;
  cycle?: { name: string; number?: number } | null;
}

export function getVisibleBoardMetadata(
  issue: BoardMetadataIssue,
  columns: IssueColumn[],
): { project: string | null; cycle: string | null } {
  return {
    project: columns.includes("project") ? (issue.project?.name ?? null) : null,
    cycle: columns.includes("cycle")
      ? issue.cycle
        ? `Cycle ${issue.cycle.number ?? ""} ${issue.cycle.name}`.trim()
        : null
      : null,
  };
}
