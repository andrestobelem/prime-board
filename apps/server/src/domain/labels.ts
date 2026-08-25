// Dominio de labels: de workspace/team, con lifecycle, grupos y merge.
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { recordActivity } from "./activity.ts";
import type { IssueRow } from "./issues.ts";

export const MAX_LABELS_PER_GROUP = 250;

export interface LabelRow {
  id: string;
  workspace_id: string | null;
  name: string;
  color: string;
  description: string | null;
  team_id: string | null;
  created_at: string;
  archived_at: string | null;
  is_group: number;
  group_id: string | null;
  merged_into_id: string | null;
}

export interface LabelInput {
  name: string;
  color?: string | null;
  description?: string | null;
  teamId?: string | null;
  isGroup?: boolean | null;
  groupId?: string | null;
}

export interface LabelUpdateInput {
  name?: string | null;
  color?: string | null;
  description?: string | null;
  /** Undefined means unchanged. Null moves the label to Workspace scope. */
  teamId?: string | null;
  /** Undefined means unchanged. Null removes the group. */
  groupId?: string | null;
}

export function mapLabel(row: LabelRow) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    isGroup: Boolean(row.is_group),
    teamId: row.team_id,
    groupId: row.group_id,
    archivedAt: row.archived_at,
    mergedIntoId: row.merged_into_id,
  };
}

function scopedSelect(workspaceId?: string): string {
  return workspaceId ? " AND workspace_id = ?2" : "";
}

function scopedParams(id: string, workspaceId?: string): [string] | [string, string] {
  return workspaceId ? [id, workspaceId] : [id];
}

export function getLabel(db: Database, id: string, workspaceId?: string): LabelRow | null {
  return db
    .query(`SELECT * FROM labels WHERE id = ?1${scopedSelect(workspaceId)}`)
    .get(...scopedParams(id, workspaceId)) as LabelRow | null;
}

function getTeamId(db: Database, teamId: string, workspaceId?: string): { id: string } | null {
  return workspaceId
    ? (db
        .query("SELECT id FROM teams WHERE id = ?1 AND workspace_id = ?2")
        .get(teamId, workspaceId) as {
        id: string;
      } | null)
    : (db.query("SELECT id FROM teams WHERE id = ?1").get(teamId) as { id: string } | null);
}

function labelDuplicate(
  db: Database,
  teamId: string | null,
  name: string,
  id: string | null,
  workspaceId?: string,
): boolean {
  const workspace = workspaceId ? "workspace_id = ?" : "1 = 1";
  const params: unknown[] = [];
  let sql: string;
  if (teamId) {
    sql = `SELECT id FROM labels WHERE ${workspace} AND team_id = ? AND name = ?`;
    if (workspaceId) params.push(workspaceId);
    params.push(teamId, name);
  } else {
    sql = `SELECT id FROM labels WHERE ${workspace} AND team_id IS NULL AND name = ?`;
    if (workspaceId) params.push(workspaceId);
    params.push(name);
  }
  if (id) {
    sql += " AND id != ?";
    params.push(id);
  }
  return Boolean(db.query(sql).get(...(params as never[])));
}

function requireGroup(
  db: Database,
  groupId: string,
  teamId: string | null,
  workspaceId?: string,
): LabelRow {
  const group = getLabel(db, groupId, workspaceId);
  if (!group) throw apiError("NOT_FOUND", "Label group not found");
  if (!group.is_group) throw apiError("VALIDATION_FAILED", "groupId must reference a label group");
  if (group.team_id !== teamId) {
    throw apiError("VALIDATION_FAILED", "Label and group must use the same scope");
  }
  if (group.archived_at) throw apiError("VALIDATION_FAILED", "Label group is archived");
  return group;
}

function validateGroupCapacity(
  db: Database,
  groupId: string,
  workspaceId?: string,
  excludingId?: string,
): void {
  const scope = workspaceId ? "workspace_id = ? AND" : "";
  const params: unknown[] = [];
  if (workspaceId) params.push(workspaceId);
  params.push(groupId);
  let sql = `SELECT count(*) AS count FROM labels WHERE ${scope} group_id = ?`;
  if (excludingId) {
    sql += " AND id != ?";
    params.push(excludingId);
  }
  const row = db.query(sql).get(...(params as never[])) as { count: number };
  if (row.count >= MAX_LABELS_PER_GROUP) {
    throw apiError(
      "VALIDATION_FAILED",
      `Label groups cannot contain more than ${MAX_LABELS_PER_GROUP} labels`,
    );
  }
}

function assertNoIssueGroupConflict(
  db: Database,
  labelId: string,
  groupId: string,
  workspaceId?: string,
  excludedLabelIds: readonly string[] = [labelId],
): void {
  const exclusions = excludedLabelIds.map((_, index) => `?${index + 2}`).join(", ");
  const groupParam = excludedLabelIds.length + 2;
  const params: unknown[] = [labelId, ...excludedLabelIds, groupId];
  let sql = `
    SELECT 1
      FROM issue_labels AS linked
      JOIN issue_labels AS other
        ON other.issue_id = linked.issue_id
      JOIN labels AS other_label
        ON other_label.id = other.label_id
     WHERE linked.label_id = ?1
       AND other.label_id NOT IN (${exclusions})
       AND other_label.group_id = ?${groupParam}`;
  if (workspaceId) {
    const workspaceParam = groupParam + 1;
    params.push(workspaceId);
    sql += `
       AND linked.workspace_id = ?${workspaceParam}
       AND other.workspace_id = ?${workspaceParam}
       AND other_label.workspace_id = ?${workspaceParam}`;
  }
  sql += " LIMIT 1";
  if (db.query(sql).get(...(params as never[]))) {
    throw apiError(
      "VALIDATION_FAILED",
      "A label group cannot be shared by multiple labels on the same issue",
    );
  }
}

export function createLabel(db: Database, input: LabelInput, workspaceId?: string): LabelRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Label name cannot be empty");
  let created: LabelRow | null = null;
  db.transaction(() => {
    const teamId = input.teamId ?? null;
    if (teamId && !getTeamId(db, teamId, workspaceId)) {
      throw apiError("NOT_FOUND", "Team not found");
    }
    const isGroup = Boolean(input.isGroup);
    if (isGroup && input.groupId != null) {
      throw apiError("VALIDATION_FAILED", "A label group cannot belong to another group");
    }
    if (!isGroup && input.groupId != null) {
      requireGroup(db, input.groupId, teamId, workspaceId);
      validateGroupCapacity(db, input.groupId, workspaceId);
    }
    if (labelDuplicate(db, teamId, name, null, workspaceId)) {
      throw apiError("VALIDATION_FAILED", `Label ${name} already exists in this scope`);
    }

    const id = newId();
    db.query(
      `INSERT INTO labels
        (id, name, color, description, team_id, created_at, workspace_id, archived_at, is_group, group_id, merged_into_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, NULL)`,
    ).run(
      id,
      name,
      input.color ?? "#95a2b3",
      input.description ?? null,
      teamId,
      now(),
      workspaceId ?? null,
      isGroup ? 1 : 0,
      isGroup ? null : (input.groupId ?? null),
    );
    created = getLabel(db, id, workspaceId);
  })();
  if (!created) throw apiError("NOT_FOUND", "Label was not created");
  return created;
}

export function updateLabel(
  db: Database,
  id: string,
  input: LabelUpdateInput,
  workspaceId?: string,
): LabelRow {
  let updated: LabelRow | null = null;
  db.transaction(() => {
    const label = getLabel(db, id, workspaceId);
    if (!label) throw apiError("NOT_FOUND", "Label not found");
    const teamId = input.teamId !== undefined ? (input.teamId ?? null) : label.team_id;
    const groupId = input.groupId !== undefined ? (input.groupId ?? null) : label.group_id;
    const name = input.name != null ? input.name.trim() : label.name;
    if (!name) throw apiError("VALIDATION_FAILED", "Label name cannot be empty");
    if (teamId && !getTeamId(db, teamId, workspaceId)) {
      throw apiError("NOT_FOUND", "Team not found");
    }
    if (label.is_group && groupId != null) {
      throw apiError("VALIDATION_FAILED", "A label group cannot belong to another group");
    }
    if (!label.is_group && groupId != null) {
      requireGroup(db, groupId, teamId, workspaceId);
      if (groupId !== label.group_id) {
        validateGroupCapacity(db, groupId, workspaceId);
        assertNoIssueGroupConflict(db, id, groupId, workspaceId);
      }
    }
    if (labelDuplicate(db, teamId, name, id, workspaceId)) {
      throw apiError("VALIDATION_FAILED", `Label ${name} already exists in this scope`);
    }
    if (label.is_group && input.teamId !== undefined && label.team_id !== teamId) {
      const children = workspaceId
        ? (db
            .query("SELECT id, name FROM labels WHERE group_id = ?1 AND workspace_id = ?2")
            .all(label.id, workspaceId) as Array<{ id: string; name: string }>)
        : (db.query("SELECT id, name FROM labels WHERE group_id = ?1").all(label.id) as Array<{
            id: string;
            name: string;
          }>);
      for (const child of children) {
        if (labelDuplicate(db, teamId, child.name, child.id, workspaceId)) {
          throw apiError("VALIDATION_FAILED", `Label ${child.name} already exists in this scope`);
        }
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = ?${params.length}`);
    };
    if (input.name != null) push("name", name);
    if (input.color != null) push("color", input.color);
    if (input.description !== undefined) push("description", input.description ?? null);
    if (input.teamId !== undefined) push("team_id", teamId);
    if (input.groupId !== undefined) push("group_id", groupId);
    if (sets.length > 0) {
      params.push(id);
      let sql = `UPDATE labels SET ${sets.join(", ")} WHERE id = ?${params.length}`;
      if (workspaceId) {
        params.push(workspaceId);
        sql += ` AND workspace_id = ?${params.length}`;
      }
      db.query(sql).run(...(params as never[]));
    }

    // A group move carries its children with it. This keeps scope checks and
    // future assignments coherent while preserving existing issue references.
    if (label.is_group && input.teamId !== undefined && label.team_id !== teamId) {
      if (workspaceId) {
        db.query("UPDATE labels SET team_id = ?1 WHERE group_id = ?2 AND workspace_id = ?3").run(
          teamId,
          label.id,
          workspaceId,
        );
      } else {
        db.query("UPDATE labels SET team_id = ?1 WHERE group_id = ?2").run(teamId, label.id);
      }
    }
    updated = getLabel(db, id, workspaceId);
  })();
  if (!updated) throw apiError("NOT_FOUND", "Label not found");
  return updated;
}

export function archiveLabel(
  db: Database,
  id: string,
  archived: boolean,
  workspaceId?: string,
): LabelRow {
  const label = getLabel(db, id, workspaceId);
  if (!label) throw apiError("NOT_FOUND", "Label not found");
  if (!archived && label.merged_into_id) {
    throw apiError("VALIDATION_FAILED", "Merged labels are terminal and cannot be unarchived");
  }
  const archivedAt = archived ? now() : null;
  if (workspaceId) {
    db.query("UPDATE labels SET archived_at = ?1 WHERE id = ?2 AND workspace_id = ?3").run(
      archivedAt,
      id,
      workspaceId,
    );
  } else {
    db.query("UPDATE labels SET archived_at = ?1 WHERE id = ?2").run(archivedAt, id);
  }
  return getLabel(db, id, workspaceId) ?? label;
}

export interface LabelMergeResult {
  source: LabelRow;
  target: LabelRow;
  affectedIssues: number;
  affectedIssueIds: string[];
}

export function mergeLabels(
  db: Database,
  actorId: string,
  sourceId: string,
  targetId: string,
  workspaceId?: string,
): LabelMergeResult {
  if (sourceId === targetId)
    throw apiError("VALIDATION_FAILED", "A label cannot merge into itself");
  let result!: LabelMergeResult;
  db.transaction(() => {
    const source = getLabel(db, sourceId, workspaceId);
    const target = getLabel(db, targetId, workspaceId);
    if (!source || !target) throw apiError("NOT_FOUND", "Label not found");
    if (source.is_group || target.is_group) {
      throw apiError("VALIDATION_FAILED", "Label groups cannot be merged");
    }
    if (source.team_id !== target.team_id) {
      throw apiError("VALIDATION_FAILED", "Labels must use the same scope to merge");
    }
    if (target.archived_at) throw apiError("VALIDATION_FAILED", "Target label is archived");
    if (source.merged_into_id) throw apiError("VALIDATION_FAILED", "Label was already merged");
    if (target.group_id) {
      assertNoIssueGroupConflict(db, source.id, target.group_id, workspaceId, [
        source.id,
        target.id,
      ]);
    }

    const issueRows = workspaceId
      ? (db
          .query(
            "SELECT issue_id FROM issue_labels WHERE label_id = ?1 AND workspace_id = ?2 ORDER BY issue_id",
          )
          .all(source.id, workspaceId) as Array<{ issue_id: string }>)
      : (db
          .query("SELECT issue_id FROM issue_labels WHERE label_id = ?1 ORDER BY issue_id")
          .all(source.id) as Array<{ issue_id: string }>);
    const timestamp = now();
    for (const { issue_id: issueId } of issueRows) {
      const targetExists = workspaceId
        ? db
            .query(
              "SELECT 1 FROM issue_labels WHERE issue_id = ?1 AND label_id = ?2 AND workspace_id = ?3",
            )
            .get(issueId, target.id, workspaceId)
        : db
            .query("SELECT 1 FROM issue_labels WHERE issue_id = ?1 AND label_id = ?2")
            .get(issueId, target.id);
      if (!targetExists) {
        db.query(
          "INSERT INTO issue_labels (issue_id, label_id, workspace_id) VALUES (?1, ?2, ?3)",
        ).run(issueId, target.id, workspaceId ?? null);
        recordActivity(
          db,
          issueId,
          actorId,
          "labeled",
          { label: target.name, reason: "label_merged", from: source.name },
          timestamp,
          workspaceId,
        );
      }
      if (workspaceId) {
        db.query(
          "DELETE FROM issue_labels WHERE issue_id = ?1 AND label_id = ?2 AND workspace_id = ?3",
        ).run(issueId, source.id, workspaceId);
        db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3").run(
          timestamp,
          issueId,
          workspaceId,
        );
      } else {
        db.query("DELETE FROM issue_labels WHERE issue_id = ?1 AND label_id = ?2").run(
          issueId,
          source.id,
        );
        db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2").run(timestamp, issueId);
      }
      recordActivity(
        db,
        issueId,
        actorId,
        "unlabeled",
        { label: source.name, reason: "label_merged", target: target.name },
        timestamp,
        workspaceId,
      );
    }
    if (workspaceId) {
      db.query(
        "UPDATE labels SET archived_at = ?1, merged_into_id = ?2 WHERE id = ?3 AND workspace_id = ?4",
      ).run(timestamp, target.id, source.id, workspaceId);
    } else {
      db.query("UPDATE labels SET archived_at = ?1, merged_into_id = ?2 WHERE id = ?3").run(
        timestamp,
        target.id,
        source.id,
      );
    }
    result = {
      source: getLabel(db, source.id, workspaceId)!,
      target: getLabel(db, target.id, workspaceId)!,
      affectedIssues: issueRows.length,
      affectedIssueIds: issueRows.map(({ issue_id }) => issue_id),
    };
  })();
  return result;
}

/** Borra la label y la quita de todos los issues que la tenían. */
export function deleteLabel(
  db: Database,
  actorId: string,
  id: string,
  workspaceId?: string,
): number {
  const label = getLabel(db, id, workspaceId);
  if (!label) throw apiError("NOT_FOUND", "Label not found");
  if (label.is_group) {
    const childCount = workspaceId
      ? (db
          .query("SELECT count(*) AS count FROM labels WHERE group_id = ?1 AND workspace_id = ?2")
          .get(id, workspaceId) as { count: number })
      : (db.query("SELECT count(*) AS count FROM labels WHERE group_id = ?1").get(id) as {
          count: number;
        });
    if (childCount.count > 0) {
      throw apiError("VALIDATION_FAILED", "Delete the labels in a group before deleting the group");
    }
  }
  let affected = 0;
  db.transaction(() => {
    const issues = workspaceId
      ? (
          db
            .query("SELECT issue_id FROM issue_labels WHERE label_id = ?1 AND workspace_id = ?2")
            .all(id, workspaceId) as Array<{ issue_id: string }>
        ).map((row) => row.issue_id)
      : (
          db.query("SELECT issue_id FROM issue_labels WHERE label_id = ?1").all(id) as Array<{
            issue_id: string;
          }>
        ).map((row) => row.issue_id);
    affected = issues.length;
    if (workspaceId) {
      db.query("DELETE FROM issue_labels WHERE label_id = ?1 AND workspace_id = ?2").run(
        id,
        workspaceId,
      );
    } else {
      db.query("DELETE FROM issue_labels WHERE label_id = ?1").run(id);
    }
    const timestamp = now();
    for (const issueId of issues) {
      if (workspaceId) {
        db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3").run(
          timestamp,
          issueId,
          workspaceId,
        );
      } else {
        db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2").run(timestamp, issueId);
      }
      recordActivity(
        db,
        issueId,
        actorId,
        "unlabeled",
        { label: label.name, reason: "label_deleted" },
        undefined,
        workspaceId,
      );
    }
    if (workspaceId) {
      db.query("DELETE FROM labels WHERE id = ?1 AND workspace_id = ?2").run(id, workspaceId);
    } else {
      db.query("DELETE FROM labels WHERE id = ?1").run(id);
    }
  })();
  return affected;
}

/** Labels visibles para un team: las de workspace + las propias. Sin team: todas. */
export function listLabels(
  db: Database,
  teamId?: string | null,
  includeArchived = false,
  workspaceId?: string,
): LabelRow[] {
  const params: unknown[] = [];
  const predicates: string[] = [];
  if (workspaceId) {
    params.push(workspaceId);
    predicates.push(`workspace_id = ?${params.length}`);
  }
  if (teamId) {
    params.push(teamId);
    predicates.push(`(team_id IS NULL OR team_id = ?${params.length})`);
  }
  if (!includeArchived) predicates.push("archived_at IS NULL");
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  return db
    .query(`SELECT * FROM labels${where} ORDER BY name, id`)
    .all(...(params as never[])) as LabelRow[];
}

export function listIssueLabels(db: Database, issueId: string, workspaceId?: string): LabelRow[] {
  const query = workspaceId
    ? `SELECT labels.* FROM labels
       JOIN issue_labels ON issue_labels.label_id = labels.id
       WHERE issue_labels.issue_id = ?1
         AND issue_labels.workspace_id = ?2
         AND labels.workspace_id = ?2
       ORDER BY labels.name, labels.id`
    : `SELECT labels.* FROM labels
       JOIN issue_labels ON issue_labels.label_id = labels.id
       WHERE issue_labels.issue_id = ?1 ORDER BY labels.name, labels.id`;
  return (
    workspaceId ? db.query(query).all(issueId, workspaceId) : db.query(query).all(issueId)
  ) as LabelRow[];
}

function assertApplicable(db: Database, issue: IssueRow, labelId: string): LabelRow {
  const workspaceId = issue.workspace_id ?? undefined;
  const label = getLabel(db, labelId, workspaceId);
  if (!label) throw apiError("NOT_FOUND", `Label not found: ${labelId}`);
  if (label.archived_at) throw apiError("VALIDATION_FAILED", `Label ${label.name} is archived`);
  if (label.merged_into_id) {
    throw apiError("VALIDATION_FAILED", `Label ${label.name} was merged into another label`);
  }
  if (label.is_group) throw apiError("VALIDATION_FAILED", `Label ${label.name} is a group`);
  if (label.group_id) {
    const group = getLabel(db, label.group_id, workspaceId);
    if (!group || group.archived_at) {
      throw apiError("VALIDATION_FAILED", `Label group for ${label.name} is archived`);
    }
  }
  if (label.team_id !== null && label.team_id !== issue.team_id) {
    throw apiError("VALIDATION_FAILED", `Label ${label.name} belongs to another team`);
  }
  return label;
}

export interface LabelOps {
  labelIds?: string[] | null;
  addLabelIds?: string[] | null;
  removeLabelIds?: string[] | null;
}

/** Aplica set/add/remove de labels a un issue, registrando actividad. */
export function applyLabelOps(
  db: Database,
  actorId: string,
  issue: IssueRow,
  ops: LabelOps,
): boolean {
  const currentRows = listIssueLabels(db, issue.id, issue.workspace_id ?? undefined);
  const current = new Set(currentRows.map((label) => label.id));
  const target = new Set(current);

  if (ops.labelIds != null) (target.clear(), ops.labelIds.forEach((id) => target.add(id)));
  for (const id of ops.addLabelIds ?? []) target.add(id);
  for (const id of ops.removeLabelIds ?? []) target.delete(id);

  const toAdd = [...target].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !target.has(id));
  if (toAdd.length === 0 && toRemove.length === 0) return false;

  // Validate every new label before changing the issue, including the one-label
  // invariant for each group.
  const targetRows = [...target].map(
    (id) => currentRows.find((row) => row.id === id) ?? assertApplicable(db, issue, id),
  );
  const groups = new Map<string, string>();
  for (const label of targetRows) {
    if (!label.group_id) continue;
    const previous = groups.get(label.group_id);
    if (previous && previous !== label.id) {
      throw apiError(
        "VALIDATION_FAILED",
        "Only one label from each group can be applied to an issue",
      );
    }
    groups.set(label.group_id, label.id);
  }
  for (const labelId of toAdd) {
    if (!current.has(labelId)) assertApplicable(db, issue, labelId);
  }

  for (const labelId of toAdd) {
    const label = assertApplicable(db, issue, labelId);
    db.query("INSERT INTO issue_labels (issue_id, label_id, workspace_id) VALUES (?1, ?2, ?3)").run(
      issue.id,
      labelId,
      issue.workspace_id ?? null,
    );
    recordActivity(
      db,
      issue.id,
      actorId,
      "labeled",
      { label: label.name },
      undefined,
      issue.workspace_id ?? undefined,
    );
  }
  for (const labelId of toRemove) {
    const label = issue.workspace_id
      ? (db
          .query("SELECT name FROM labels WHERE id = ?1 AND workspace_id = ?2")
          .get(labelId, issue.workspace_id) as { name: string } | null)
      : (db.query("SELECT name FROM labels WHERE id = ?1").get(labelId) as {
          name: string;
        } | null);
    if (issue.workspace_id) {
      db.query(
        "DELETE FROM issue_labels WHERE issue_id = ?1 AND label_id = ?2 AND workspace_id = ?3",
      ).run(issue.id, labelId, issue.workspace_id);
    } else {
      db.query("DELETE FROM issue_labels WHERE issue_id = ?1 AND label_id = ?2").run(
        issue.id,
        labelId,
      );
    }
    recordActivity(
      db,
      issue.id,
      actorId,
      "unlabeled",
      { label: label?.name ?? labelId },
      undefined,
      issue.workspace_id ?? undefined,
    );
  }
  return true;
}
