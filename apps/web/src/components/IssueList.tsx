// Lista de issues agrupada por estado con navegación por teclado (AT-145).
// Reutilizada por la vista de team y la de proyecto.
import { useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../router.tsx";
import { Avatar, LabelChip, PriorityIcon, StateIcon } from "./bits.tsx";

export interface IssueListItem {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  state: { id: string; name: string; type: string; position: number };
  assignee: { id: string; name: string; type: string } | null;
  labels: Array<{ id: string; name: string; color: string }>;
  milestone?: { id: string; name: string } | null;
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
}

export function IssueList({
  issues,
  groupBy = "state",
  selection,
}: {
  issues: IssueListItem[];
  groupBy?: GroupBy;
  selection?: IssueSelection;
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
      if (isTypingTarget(event) || document.querySelector(".overlay")) return;
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
  }, [flat]);

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
                <PriorityIcon priority={issue.priority} />
                <span className="identifier">{issue.identifier}</span>
                <span className="title">{issue.title}</span>
                <span className="right">
                  {issue.labels.map((label) => (
                    <LabelChip key={label.id} label={label} />
                  ))}
                  <Avatar actor={issue.assignee} />
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
