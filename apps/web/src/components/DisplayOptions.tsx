import type { GroupBy } from "./IssueList.tsx";

export type IssueOrder = "CREATED_DESC" | "CREATED_ASC" | "UPDATED_DESC" | "UPDATED_ASC";
export type IssueColumn = "priority" | "labels" | "assignee" | "project" | "cycle";

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
  onGroupBy,
  onOrderBy,
  onColumns,
}: {
  groupBy: GroupBy;
  orderBy: IssueOrder;
  columns: IssueColumn[];
  onGroupBy: (value: GroupBy) => void;
  onOrderBy: (value: IssueOrder) => void;
  onColumns: (value: IssueColumn[]) => void;
}) {
  return (
    <details className="display-options">
      <summary className="btn secondary">Display</summary>
      <div className="display-options-popover">
        <label>
          Group by
          <select value={groupBy} onChange={(event) => onGroupBy(event.target.value as GroupBy)}>
            <option value="state">State</option>
            <option value="milestone">Milestone</option>
            <option value="assignee">Assignee</option>
            <option value="priority">Priority</option>
          </select>
        </label>
        <label>
          Order by
          <select value={orderBy} onChange={(event) => onOrderBy(event.target.value as IssueOrder)}>
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
