// Lista de issues agrupada por estado con navegación por teclado (AT-145).
// Reutilizada por la vista de team y la de proyecto.
import { useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../router.tsx";
import { Avatar, LabelChip, PriorityIcon, StateIcon } from "./bits.tsx";
import {
  IssueActionMenu,
  type IssueActionInput,
  type IssueActionOptions,
} from "./IssueActions.tsx";
import { isIssueShortcutTarget } from "../issue-selection.ts";
import type { IssueColumn } from "./DisplayOptions.tsx";

export interface IssueListItem {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  state: { id: string; name: string; type: string; position: number };
  assignee: { id: string; name: string; type: string } | null;
  labels: Array<{ id: string; name: string; color: string }>;
  milestone?: { id: string; name: string } | null;
  cycle?: { id: string; name: string; number?: number } | null;
  project?: { id: string; name: string } | null;
  parent?: { id: string; identifier: string; title: string } | null;
}

export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable),
  );
}

/** Ordena dentro del grupo: urgente primero, "no priority" al final. */
function prioritySortKey(issue: IssueListItem): number {
  return issue.priority === 0 ? 5 : issue.priority;
}

export type GroupBy = "state" | "milestone" | "assignee" | "priority";

/** Hace explícito el límite de 250 elementos de la API en lugar de ocultarlos. */
export function IssueListLimitNotice({ hasNextPage }: { hasNextPage: boolean }) {
  if (!hasNextPage) return null;
  return (
    <div className="pagination-notice">
      Showing the first 250 issues. Narrow the filter to see issues beyond this limit.
    </div>
  );
}

export const GROUP_LABELS: Record<GroupBy, string> = {
  state: "State",
  milestone: "Milestone",
  assignee: "Assignee",
  priority: "Priority",
};

/** Clave y orden del grupo al que pertenece un issue, según el criterio elegido. */
function groupOf(issue: IssueListItem, by: GroupBy): { key: string; label: string; order: number } {
  if (by === "milestone") {
    return issue.milestone
      ? { key: issue.milestone.id, label: issue.milestone.name, order: 0 }
      : { key: "none", label: "No milestone", order: 1 };
  }
  if (by === "assignee") {
    return issue.assignee
      ? { key: issue.assignee.id, label: issue.assignee.name, order: 0 }
      : { key: "none", label: "No assignee", order: 1 };
  }
  if (by === "priority") {
    const names = ["No priority", "Urgent", "High", "Medium", "Low"];
    return {
      key: String(issue.priority),
      label: names[issue.priority] ?? "?",
      order: issue.priority === 0 ? 5 : issue.priority,
    };
  }
  return { key: issue.state.id, label: issue.state.name, order: issue.state.position };
}

export interface IssueSelection {
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectAll?: () => void;
  onClear?: () => void;
}

export function IssueList({
  issues,
  groupBy = "state",
  selection,
  actionOptions,
  onIssueAction,
  onArchiveIssue,
  visibleColumns = ["priority", "labels", "assignee"],
}: {
  issues: IssueListItem[];
  groupBy?: GroupBy;
  selection?: IssueSelection;
  actionOptions?: IssueActionOptions;
  onIssueAction?: (id: string, input: IssueActionInput) => Promise<void>;
  onArchiveIssue?: (id: string) => Promise<void>;
  visibleColumns?: IssueColumn[];
}) {
  const [focusIndex, setFocusIndex] = useState(-1);
  const focusRef = useRef(focusIndex);
  useEffect(() => {
    focusRef.current = focusIndex;
  }, [focusIndex]);

  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        label: string;
        order: number;
        state?: IssueListItem["state"];
        items: IssueListItem[];
      }
    >();
    for (const issue of issues) {
      const g = groupOf(issue, groupBy);
      const group = map.get(g.key) ?? {
        label: g.label,
        order: g.order,
        state: groupBy === "state" ? issue.state : undefined,
        items: [],
      };
      group.items.push(issue);
      map.set(g.key, group);
    }
    const sorted = [...map.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    for (const group of sorted) {
      group.items.sort((a, b) => prioritySortKey(a) - prioritySortKey(b));
    }
    return sorted;
  }, [issues, groupBy]);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isIssueShortcutTarget(event.target) || document.querySelector(".overlay")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selection?.onSelectAll?.();
        return;
      }
      if (event.key === "Escape") {
        selection?.onClear?.();
        setFocusIndex(-1);
        return;
      }
      if ((event.key === "x" || event.key === "X") && !event.metaKey && !event.ctrlKey) {
        const focused = flat[focusRef.current];
        if (focused && onArchiveIssue) {
          event.preventDefault();
          void onArchiveIssue(focused.id);
        }
        return;
      }
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setFocusIndex((index) => Math.min(index + 1, flat.length - 1));
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setFocusIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === "Enter") {
        const issue = flat[focusRef.current];
        if (issue) navigate(`/issue/${issue.identifier}`);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, onArchiveIssue, selection]);

  useEffect(() => {
    document.querySelector(".issue-row.focused")?.scrollIntoView({ block: "nearest" });
  }, [focusIndex]);

  if (issues.length === 0) {
    return (
      <div className="empty">
        No issues here yet. Press <kbd>C</kbd> to create one.
      </div>
    );
  }

  let flatIndex = -1;
  return (
    <div>
      {groups.map((group) => (
        <div key={group.key}>
          <div className="state-group-header">
            {group.state && <StateIcon state={group.state} />}
            {group.label}
            <span className="count">{group.items.length}</span>
          </div>
          {group.items.map((issue) => {
            flatIndex += 1;
            const index = flatIndex;
            return (
              <div
                key={issue.id}
                className={`issue-row${index === focusIndex ? " focused" : ""}`}
                role="button"
                tabIndex={index === focusIndex ? 0 : -1}
                aria-current={index === focusIndex ? "true" : undefined}
                onClick={() => navigate(`/issue/${issue.identifier}`)}
                onMouseEnter={() => setFocusIndex(index)}
              >
                {selection && (
                  <input
                    className="issue-select"
                    type="checkbox"
                    aria-label={`Select ${issue.identifier}`}
                    checked={selection.selectedIds.has(issue.id)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => selection.onToggle(issue.id)}
                  />
                )}
                {visibleColumns.includes("priority") && <PriorityIcon priority={issue.priority} />}
                <span className="identifier">{issue.identifier}</span>
                <span className="title">{issue.title}</span>
                <span className="right">
                  {visibleColumns.includes("labels") &&
                    issue.labels.map((label) => <LabelChip key={label.id} label={label} />)}
                  {visibleColumns.includes("project") && issue.project && (
                    <span className="issue-property">{issue.project.name}</span>
                  )}
                  {visibleColumns.includes("cycle") && issue.cycle && (
                    <span className="issue-property">{issue.cycle.name}</span>
                  )}
                  {visibleColumns.includes("assignee") && <Avatar actor={issue.assignee} />}
                  {actionOptions && onIssueAction && onArchiveIssue && (
                    <IssueActionMenu
                      options={actionOptions}
                      onAction={(input) => onIssueAction(issue.id, input)}
                      onArchive={() => onArchiveIssue(issue.id)}
                    />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
