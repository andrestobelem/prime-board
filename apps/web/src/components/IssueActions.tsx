import { useState } from "react";
import { Icon } from "./icons.tsx";

export interface IssueActionState {
  id: string;
  name: string;
}

export interface IssueActionActor {
  id: string;
  name: string;
  type: string;
}

export interface IssueActionLabel {
  id: string;
  name: string;
  color?: string;
}

export interface IssueActionProject {
  id: string;
  name: string;
}

export interface IssueActionCycle {
  id: string;
  name: string;
  number?: number;
}

export interface IssueActionOptions {
  states: IssueActionState[];
  actors: IssueActionActor[];
  labels: IssueActionLabel[];
  projects: IssueActionProject[];
  cycles: IssueActionCycle[];
}

export type IssueActionInput = Record<string, unknown>;

export const PRIORITY_OPTIONS = [
  ["0", "No priority"],
  ["1", "Urgent"],
  ["2", "High"],
  ["3", "Medium"],
  ["4", "Low"],
] as const;

function actionValue(value: string, options: IssueActionOptions): IssueActionInput | null {
  if (!value) return null;
  const [kind, id] = value.split(":", 2);
  if (kind === "state") return { stateId: id };
  if (kind === "assignee") return { assigneeId: id || null };
  if (kind === "priority") return { priority: Number(id) };
  if (kind === "label") return { addLabelIds: [id] };
  if (kind === "project") return { projectId: id || null };
  if (kind === "cycle") return { cycleId: id || null };
  return null;
}

export function IssueActionMenu({
  options,
  onAction,
  onArchive,
  disabled = false,
}: {
  options: IssueActionOptions;
  onAction: (input: IssueActionInput) => Promise<void>;
  onArchive: () => Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setSaving(true);
    setError(null);
    try {
      await action();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The issue action failed.");
    } finally {
      setSaving(false);
    }
  }

  function selectOptions(): Array<[string, string]> {
    return [
      ...options.states.map(
        (state) => [`state:${state.id}`, `State: ${state.name}`] as [string, string],
      ),
      ...options.actors.map(
        (actor) =>
          [
            `assignee:${actor.id}`,
            `Assignee: ${actor.name}${actor.type === "AGENT" ? " (agent)" : ""}`,
          ] as [string, string],
      ),
      ...PRIORITY_OPTIONS.map(
        ([id, name]) => [`priority:${id}`, `Priority: ${name}`] as [string, string],
      ),
      ...options.labels.map(
        (label) => [`label:${label.id}`, `Add label: ${label.name}`] as [string, string],
      ),
      ["project:", "Project: No project"],
      ...options.projects.map(
        (project) => [`project:${project.id}`, `Project: ${project.name}`] as [string, string],
      ),
      ["cycle:", "Cycle: No cycle"],
      ...options.cycles.map(
        (cycle) => [`cycle:${cycle.id}`, `Cycle: ${cycle.name}`] as [string, string],
      ),
    ];
  }

  return (
    <div className="issue-context-actions">
      <button
        className="icon-action"
        aria-label="Issue actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || saving}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <Icon name="more" size={14} />
      </button>
      {open && (
        <div
          className="issue-context-menu"
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <label>
            <span className="sr-only">Change issue</span>
            <select
              aria-label="Change issue"
              autoFocus
              defaultValue=""
              disabled={saving}
              onChange={(event) => {
                const input = actionValue(event.target.value, options);
                event.currentTarget.value = "";
                if (input) void run(() => onAction(input));
              }}
            >
              <option value="">Change…</option>
              {selectOptions().map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            role="menuitem"
            className="danger"
            disabled={saving}
            onClick={() => void run(onArchive)}
          >
            <Icon name="archive" size={14} /> Archive issue
          </button>
        </div>
      )}
    </div>
  );
}

export function BulkIssueActions({
  selectedCount,
  options,
  onAction,
  onArchive,
  onClear,
  loading = false,
}: {
  selectedCount: number;
  options: IssueActionOptions;
  onAction: (input: IssueActionInput) => Promise<void>;
  onArchive: () => Promise<void>;
  onClear: () => void;
  loading?: boolean;
}) {
  const [value, setValue] = useState("");
  if (!selectedCount) return null;

  const optionsList = [
    ...options.states.map(
      (state) => [`state:${state.id}`, `Set state: ${state.name}`] as [string, string],
    ),
    ["assignee:", "Set assignee: unassigned"],
    ...options.actors.map(
      (actor) => [`assignee:${actor.id}`, `Set assignee: ${actor.name}`] as [string, string],
    ),
    ...PRIORITY_OPTIONS.map(
      ([id, name]) => [`priority:${id}`, `Set priority: ${name}`] as [string, string],
    ),
    ...options.labels.map(
      (label) => [`label:${label.id}`, `Add label: ${label.name}`] as [string, string],
    ),
    ["project:", "Set project: none"],
    ...options.projects.map(
      (project) => [`project:${project.id}`, `Set project: ${project.name}`] as [string, string],
    ),
    ["cycle:", "Set cycle: none"],
    ...options.cycles.map(
      (cycle) => [`cycle:${cycle.id}`, `Set cycle: ${cycle.name}`] as [string, string],
    ),
  ];

  return (
    <div className="selection-toolbar" aria-live="polite">
      <span>{selectedCount} selected</span>
      <select
        aria-label="Apply action to selected issues"
        value={value}
        disabled={loading}
        onChange={(event) => {
          const next = event.target.value;
          setValue("");
          const input = actionValue(next, options);
          if (input) void onAction(input);
        }}
      >
        <option value="">Change…</option>
        {optionsList.map(([optionValue, label]) => (
          <option key={optionValue} value={optionValue}>
            {label}
          </option>
        ))}
      </select>
      <button className="btn secondary" disabled={loading} onClick={() => void onArchive()}>
        <Icon name="archive" size={14} /> Archive
      </button>
      <button className="btn secondary" onClick={onClear} disabled={loading}>
        Clear
      </button>
      {loading && <span className="toolbar-status">Updating…</span>}
    </div>
  );
}
