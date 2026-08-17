import { useState } from "react";
import {
  activeIssueFilterCount,
  EMPTY_ISSUE_FILTER,
  type IssueFilterDraft,
} from "../issue-filter.ts";
import {
  BulkIssueActions,
  type IssueActionInput,
  type IssueActionOptions,
} from "./IssueActions.tsx";

interface StateOption {
  id: string;
  name: string;
  type: string;
}

interface ActorOption {
  id: string;
  name: string;
  type: string;
}

interface LabelOption {
  id: string;
  name: string;
  color: string;
}

export function IssueFilterToolbar({
  draft,
  states,
  actors,
  labels,
  visibleCount,
  selectedCount,
  onChange,
  onSelectAll,
  onClearSelection,
  onBulkState,
  actionOptions,
  onBulkAction,
  onBulkArchive,
  bulkLoading = false,
}: {
  draft: IssueFilterDraft;
  states: StateOption[];
  actors: ActorOption[];
  labels: LabelOption[];
  visibleCount: number;
  selectedCount: number;
  onChange: (draft: IssueFilterDraft) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkState: (stateId: string) => Promise<void>;
  actionOptions?: IssueActionOptions;
  onBulkAction?: (input: IssueActionInput) => Promise<void>;
  onBulkArchive?: () => Promise<void>;
  bulkLoading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = activeIssueFilterCount(draft);

  function update(key: keyof IssueFilterDraft, value: string) {
    onChange({ ...draft, [key]: value });
  }

  return (
    <div className="issue-toolbar">
      <div className="issue-toolbar-main">
        <button
          className={`btn secondary filter-trigger${activeCount ? " active" : ""}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Filter{activeCount > 0 && <span className="filter-count">{activeCount}</span>}
        </button>
        <input
          className="issue-search"
          aria-label="Search issues"
          placeholder="Search issues"
          value={draft.search}
          onChange={(event) => update("search", event.target.value)}
        />
        <button className="btn secondary" onClick={onSelectAll} disabled={!visibleCount}>
          {selectedCount === visibleCount && visibleCount > 0 ? "Deselect all" : "Select visible"}
        </button>
      </div>
      {actionOptions && onBulkAction && onBulkArchive ? (
        <BulkIssueActions
          selectedCount={selectedCount}
          options={actionOptions}
          onAction={onBulkAction}
          onArchive={onBulkArchive}
          onClear={onClearSelection}
          loading={bulkLoading}
        />
      ) : selectedCount > 0 ? (
        <div className="selection-toolbar" aria-live="polite">
          <span>{selectedCount} selected</span>
          <select
            aria-label="Set state for selected issues"
            defaultValue=""
            disabled={bulkLoading}
            onChange={(event) => {
              const stateId = event.target.value;
              if (stateId) void onBulkState(stateId);
              event.currentTarget.value = "";
            }}
          >
            <option value="">Set state…</option>
            {states.map((state) => (
              <option key={state.id} value={state.id}>
                {state.name}
              </option>
            ))}
          </select>
          <button className="btn secondary" onClick={onClearSelection} disabled={bulkLoading}>
            Clear
          </button>
          {bulkLoading && <span className="toolbar-status">Updating…</span>}
        </div>
      ) : null}
      {open && (
        <div className="filter-popover" role="dialog" aria-label="Issue filters">
          <label>
            State
            <select
              value={draft.stateId}
              onChange={(event) => update("stateId", event.target.value)}
            >
              <option value="">Any state</option>
              <option value="__none__">No state</option>
              {states.map((state) => (
                <option key={state.id} value={state.id}>
                  {state.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assignee
            <select
              value={draft.assigneeId}
              onChange={(event) => update("assigneeId", event.target.value)}
            >
              <option value="">Anyone</option>
              <option value="__none__">Unassigned</option>
              {actors.map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.name}
                  {actor.type === "AGENT" ? " (agent)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select
              value={draft.priority}
              onChange={(event) => update("priority", event.target.value)}
            >
              <option value="">Any priority</option>
              <option value="0">No priority</option>
              <option value="1">Urgent</option>
              <option value="2">High</option>
              <option value="3">Medium</option>
              <option value="4">Low</option>
            </select>
          </label>
          <label>
            Label
            <select
              value={draft.labelId}
              onChange={(event) => update("labelId", event.target.value)}
            >
              <option value="">Any label</option>
              {labels.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
          </label>
          {activeCount > 0 && (
            <button
              className="btn secondary"
              onClick={() => onChange({ ...draft, ...EMPTY_ISSUE_FILTER })}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
