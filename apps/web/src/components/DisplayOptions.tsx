import type { GroupBy } from "./IssueList.tsx";

export type IssueOrder = "CREATED_DESC" | "CREATED_ASC" | "UPDATED_DESC" | "UPDATED_ASC";
export type IssueLayout = "LIST" | "BOARD";
export type IssueColumn = "priority" | "labels" | "assignee" | "project" | "cycle";

function isGroupBy(value: string): value is GroupBy {
  return value === "state" || value === "milestone" || value === "assignee" || value === "priority";
}

function isIssueOrder(value: string): value is IssueOrder {
  return (
    value === "CREATED_ASC" ||
    value === "CREATED_DESC" ||
    value === "UPDATED_ASC" ||
    value === "UPDATED_DESC"
  );
}

export const ISSUE_COLUMNS: Array<[IssueColumn, string]> = [
  ["priority", "Priority"],
  ["labels", "Labels"],
  ["assignee", "Assignee"],
  ["project", "Project"],
  ["cycle", "Cycle"],
];

export function DisplayOptions({
  groupBy,
  orderBy,
  columns,
  layout,
  onGroupBy,
  onOrderBy,
  onColumns,
  onLayout,
}: {
  groupBy: GroupBy;
  orderBy: IssueOrder;
  columns: IssueColumn[];
  layout?: IssueLayout;
  onGroupBy: (value: GroupBy) => void;
  onOrderBy: (value: IssueOrder) => void;
  onColumns: (value: IssueColumn[]) => void;
  onLayout?: (value: IssueLayout) => void;
}) {
  return (
    <details className="display-options">
      <summary className="btn secondary">Display</summary>
      <div className="display-options-popover">
        {layout && onLayout && (
          <label>
            Layout
            <select
              aria-label="Layout"
              value={layout}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "LIST" || value === "BOARD") onLayout(value);
              }}
            >
              <option value="LIST">List</option>
              <option value="BOARD">Board</option>
            </select>
          </label>
        )}
        <label>
          Group by
          <select
            value={groupBy}
            onChange={(event) => {
              const value = event.target.value;
              if (isGroupBy(value)) onGroupBy(value);
            }}
          >
            <option value="state">State</option>
            <option value="milestone">Milestone</option>
            <option value="assignee">Assignee</option>
            <option value="priority">Priority</option>
          </select>
        </label>
        <label>
          Order by
          <select
            value={orderBy}
            onChange={(event) => {
              const value = event.target.value;
              if (isIssueOrder(value)) onOrderBy(value);
            }}
          >
            <option value="UPDATED_DESC">Recently updated</option>
            <option value="CREATED_DESC">Recently created</option>
            <option value="UPDATED_ASC">Least recently updated</option>
            <option value="CREATED_ASC">Oldest first</option>
          </select>
        </label>
        <fieldset>
          <legend>Visible properties</legend>
          {ISSUE_COLUMNS.map(([key, label]) => (
            <label key={key} className="display-option-check">
              <input
                type="checkbox"
                checked={columns.includes(key)}
                onChange={(event) =>
                  onColumns(
                    event.target.checked
                      ? [...columns, key]
                      : columns.filter((item) => item !== key),
                  )
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
      </div>
    </details>
  );
}
