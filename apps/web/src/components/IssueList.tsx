// Lista de issues agrupada por estado con navegación por teclado (AT-145).
// Reutilizada por la vista de team y la de proyecto.
import { useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../router.tsx";
import { Avatar, LabelChip, PriorityIcon, StateDot } from "./bits.tsx";

export interface IssueListItem {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  state: { id: string; name: string; type: string; position: number };
  assignee: { id: string; name: string; type: string } | null;
  labels: Array<{ id: string; name: string; color: string }>;
}

export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(
    target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" ||
      target.isContentEditable),
  );
}

/** Ordena dentro del grupo: urgente primero, "no priority" al final. */
function prioritySortKey(issue: IssueListItem): number {
  return issue.priority === 0 ? 5 : issue.priority;
}

export function IssueList({ issues }: { issues: IssueListItem[] }) {
const [focusIndex, setFocusIndex] = useState(-1);
const focusRef = useRef(focusIndex);
useEffect(() => {
  focusRef.current = focusIndex;
}, [focusIndex]);

const groups = useMemo(() => {
  const byState = new Map<string, { state: IssueListItem["state"]; items: IssueListItem[] }>();
  for (const issue of issues) {
    const group = byState.get(issue.state.id) ?? { state: issue.state, items: [] };
    group.items.push(issue);
    byState.set(issue.state.id, group);
  }
  const sorted = [...byState.values()].sort((a, b) => a.state.position - b.state.position);
  for (const group of sorted) {
    group.items.sort((a, b) => prioritySortKey(a) - prioritySortKey(b));
  }
  return sorted;
}, [issues]);

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
    return <div className="empty">No issues here yet. Press <kbd>C</kbd> to create one.</div>;
  }

  let flatIndex = -1;
  return (
    <div>
      {groups.map((group) => (
        <div key={group.state.id}>
          <div className="state-group-header">
            <StateDot state={group.state} />
            {group.state.name}
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
                <PriorityIcon priority={issue.priority} />
                <span className="identifier">{issue.identifier}</span>
                <span className="title">{issue.title}</span>
                <span className="right">
                  {issue.labels.map((label) => <LabelChip key={label.id} label={label} />)}
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
