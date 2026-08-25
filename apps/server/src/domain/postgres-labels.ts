import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getPostgresTeam, isPostgresTeamOwner } from "./postgres-teams.ts";
import type { IssueRow } from "./issues.ts";
import type { ActorRow } from "../auth/viewer.ts";

export const MAX_LABELS_PER_GROUP = 250;

export interface PostgresLabelRow {
  id: string;
  name: string;
  color: string;
  description: string | null;
  team_id: string | null;
  created_at: string;
  archived_at: string | null;
  is_group: boolean;
  group_id: string | null;
  merged_into_id: string | null;
}

export interface PostgresLabelInput {
  name: string;
  color?: string | null;
  description?: string | null;
  teamId?: string | null;
  isGroup?: boolean | null;
  groupId?: string | null;
}

export interface PostgresLabelUpdateInput {
  name?: string | null;
  color?: string | null;
  description?: string | null;
  teamId?: string | null;
  groupId?: string | null;
}

export function mapPostgresLabel(row: PostgresLabelRow) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    isGroup: row.is_group,
    teamId: row.team_id,
    groupId: row.group_id,
    archivedAt: row.archived_at,
    mergedIntoId: row.merged_into_id,
  };
}

export async function getPostgresLabel(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<PostgresLabelRow | null> {
  return persistence.one<PostgresLabelRow>("SELECT * FROM labels WHERE id = $1", [id]);
}

export async function listPostgresLabels(
  persistence: Persistence | PersistenceTransaction,
  teamId?: string | null,
  includeArchived = false,
): Promise<PostgresLabelRow[]> {
  const archived = includeArchived ? "" : " AND archived_at IS NULL";
  if (teamId) {
    return [
      ...(await persistence.many<PostgresLabelRow>(
        `SELECT * FROM labels WHERE (team_id IS NULL OR team_id = $1)${archived} ORDER BY name, id`,
        [teamId],
      )),
    ];
  }
  return [
    ...(await persistence.many<PostgresLabelRow>(
      `SELECT * FROM labels WHERE TRUE${archived} ORDER BY name, id`,
    )),
  ];
}

export async function listPostgresIssueLabels(
  persistence: Persistence | PersistenceTransaction,
  issueId: string,
): Promise<PostgresLabelRow[]> {
  return [
    ...(await persistence.many<PostgresLabelRow>(
      `SELECT labels.* FROM labels
       JOIN issue_labels ON issue_labels.label_id = labels.id
       WHERE issue_labels.issue_id = $1 ORDER BY labels.name, labels.id`,
      [issueId],
    )),
  ];
}

async function assertLabelManageAccess(
  persistence: Persistence | PersistenceTransaction,
  viewer: ActorRow,
  teamId: string | null,
): Promise<void> {
  if (!teamId) {
    if (viewer.workspace_role !== "admin") {
      throw apiError("UNAUTHORIZED", "Workspace admin permission is required");
    }
    return;
  }
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
  if (
    viewer.workspace_role !== "admin" &&
    !(await isPostgresTeamOwner(persistence, teamId, viewer.id))
  ) {
    throw apiError("UNAUTHORIZED", "Team owner permission is required");
  }
}

async function duplicateLabel(
  persistence: Persistence | PersistenceTransaction,
  teamId: string | null,
  name: string,
  id?: string,
): Promise<boolean> {
  const params: SqlValue[] = teamId ? [teamId, name] : [name];
  const scope = teamId ? "team_id = $1 AND name = $2" : "team_id IS NULL AND name = $1";
  const exclusion = id ? ` AND id <> $${params.length + 1}` : "";
  if (id) params.push(id);
  return Boolean(await persistence.one(`SELECT id FROM labels WHERE ${scope}${exclusion}`, params));
}

async function requireGroup(
  persistence: Persistence | PersistenceTransaction,
  groupId: string,
  teamId: string | null,
): Promise<PostgresLabelRow> {
  const group = await getPostgresLabel(persistence, groupId);
  if (!group) throw apiError("NOT_FOUND", "Label group not found");
  if (!group.is_group) throw apiError("VALIDATION_FAILED", "groupId must reference a label group");
  if (group.team_id !== teamId) {
    throw apiError("VALIDATION_FAILED", "Label and group must use the same scope");
  }
  if (group.archived_at) throw apiError("VALIDATION_FAILED", "Label group is archived");
  return group;
}

async function validateGroupCapacity(
  persistence: Persistence | PersistenceTransaction,
  groupId: string,
  excludingId?: string,
): Promise<void> {
  const params: SqlValue[] = [groupId];
  let sql = "SELECT count(*)::int AS count FROM labels WHERE group_id = $1";
  if (excludingId) {
    params.push(excludingId);
    sql += " AND id <> $2";
  }
  const row = await persistence.one<{ count: number }>(sql, params);
  if ((row?.count ?? 0) >= MAX_LABELS_PER_GROUP) {
    throw apiError(
      "VALIDATION_FAILED",
      `Label groups cannot contain more than ${MAX_LABELS_PER_GROUP} labels`,
    );
  }
}

export async function createPostgresLabel(
  persistence: Persistence,
  viewer: ActorRow,
  input: PostgresLabelInput,
): Promise<PostgresLabelRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Label name cannot be empty");
  const teamId = input.teamId ?? null;
  const isGroup = Boolean(input.isGroup);
  if (isGroup && input.groupId != null) {
    throw apiError("VALIDATION_FAILED", "A label group cannot belong to another group");
  }
  await assertLabelManageAccess(persistence, viewer, teamId);
  if (!isGroup && input.groupId != null) {
    await requireGroup(persistence, input.groupId, teamId);
    await validateGroupCapacity(persistence, input.groupId);
  }
  if (await duplicateLabel(persistence, teamId, name)) {
    throw apiError("VALIDATION_FAILED", `Label ${name} already exists in this scope`);
  }
  const id = newId();
  await persistence.execute(
    `INSERT INTO labels
      (id, name, color, description, team_id, created_at, archived_at, is_group, group_id, merged_into_id)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, NULL)`,
    [
      id,
      name,
      input.color ?? "#95a2b3",
      input.description ?? null,
      teamId,
      now(),
      isGroup,
      isGroup ? null : (input.groupId ?? null),
    ],
  );
  const label = await getPostgresLabel(persistence, id);
  if (!label) throw apiError("NOT_FOUND", "Label was not created");
  return label;
}

export async function updatePostgresLabel(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  input: PostgresLabelUpdateInput,
): Promise<PostgresLabelRow> {
  return persistence.transaction(async (tx) => {
    const label = await getPostgresLabel(tx, id);
    if (!label) throw apiError("NOT_FOUND", "Label not found");
    const teamId = input.teamId !== undefined ? (input.teamId ?? null) : label.team_id;
    const groupId = input.groupId !== undefined ? (input.groupId ?? null) : label.group_id;
    const name = input.name != null ? input.name.trim() : label.name;
    if (!name) throw apiError("VALIDATION_FAILED", "Label name cannot be empty");
    await assertLabelManageAccess(tx, viewer, label.team_id);
    if (input.teamId !== undefined && input.teamId !== label.team_id) {
      await assertLabelManageAccess(tx, viewer, teamId);
    }
    if (label.is_group && groupId != null) {
      throw apiError("VALIDATION_FAILED", "A label group cannot belong to another group");
    }
    if (!label.is_group && groupId != null) {
      await requireGroup(tx, groupId, teamId);
      if (groupId !== label.group_id) await validateGroupCapacity(tx, groupId);
    }
    if (await duplicateLabel(tx, teamId, name, id)) {
      throw apiError("VALIDATION_FAILED", `Label ${name} already exists in this scope`);
    }
    if (label.is_group && input.teamId !== undefined && label.team_id !== teamId) {
      const children = await tx.many<{ id: string; name: string }>(
        "SELECT id, name FROM labels WHERE group_id = $1",
        [label.id],
      );
      for (const child of children) {
        if (await duplicateLabel(tx, teamId, child.name, child.id)) {
          throw apiError("VALIDATION_FAILED", `Label ${child.name} already exists in this scope`);
        }
      }
    }

    const params: SqlValue[] = [];
    const sets: string[] = [];
    const push = (column: string, value: SqlValue) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.name != null) push("name", name);
    if (input.color != null) push("color", input.color);
    if (input.description !== undefined) push("description", input.description ?? null);
    if (input.teamId !== undefined) push("team_id", teamId);
    if (input.groupId !== undefined) push("group_id", groupId);
    if (sets.length) {
      params.push(id);
      await tx.execute(`UPDATE labels SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    }
    if (label.is_group && input.teamId !== undefined && label.team_id !== teamId) {
      await tx.execute("UPDATE labels SET team_id = $1 WHERE group_id = $2", [teamId, label.id]);
    }
    const updated = await getPostgresLabel(tx, id);
    if (!updated) throw apiError("NOT_FOUND", "Label not found");
    return updated;
  });
}

export async function archivePostgresLabel(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  archived: boolean,
): Promise<PostgresLabelRow> {
  return persistence.transaction(async (tx) => {
    const label = await getPostgresLabel(tx, id);
    if (!label) throw apiError("NOT_FOUND", "Label not found");
    await assertLabelManageAccess(tx, viewer, label.team_id);
    await tx.execute("UPDATE labels SET archived_at = $1 WHERE id = $2", [
      archived ? now() : null,
      id,
    ]);
    return (await getPostgresLabel(tx, id))!;
  });
}

export interface PostgresLabelMergeResult {
  source: PostgresLabelRow;
  target: PostgresLabelRow;
  affectedIssues: number;
}

export async function mergePostgresLabels(
  persistence: Persistence,
  viewer: ActorRow,
  sourceId: string,
  targetId: string,
): Promise<PostgresLabelMergeResult> {
  if (sourceId === targetId)
    throw apiError("VALIDATION_FAILED", "A label cannot merge into itself");
  return persistence.transaction(async (tx) => {
    const source = await getPostgresLabel(tx, sourceId);
    const target = await getPostgresLabel(tx, targetId);
    if (!source || !target) throw apiError("NOT_FOUND", "Label not found");
    if (source.is_group || target.is_group) {
      throw apiError("VALIDATION_FAILED", "Label groups cannot be merged");
    }
    if (source.team_id !== target.team_id) {
      throw apiError("VALIDATION_FAILED", "Labels must use the same scope to merge");
    }
    if (target.archived_at) throw apiError("VALIDATION_FAILED", "Target label is archived");
    if (source.merged_into_id) throw apiError("VALIDATION_FAILED", "Label was already merged");
    await assertLabelManageAccess(tx, viewer, source.team_id);

    const issues = await tx.many<{ issue_id: string }>(
      "SELECT issue_id FROM issue_labels WHERE label_id = $1 ORDER BY issue_id",
      [source.id],
    );
    const timestamp = now();
    for (const issue of issues) {
      const targetExists = await tx.one(
        "SELECT 1 FROM issue_labels WHERE issue_id = $1 AND label_id = $2",
        [issue.issue_id, target.id],
      );
      if (!targetExists) {
        await tx.execute("INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2)", [
          issue.issue_id,
          target.id,
        ]);
        await recordPostgresLabelActivity(
          tx,
          issue.issue_id,
          viewer.id,
          "labeled",
          {
            label: target.name,
            reason: "label_merged",
            from: source.name,
          },
          timestamp,
        );
      }
      await tx.execute("DELETE FROM issue_labels WHERE issue_id = $1 AND label_id = $2", [
        issue.issue_id,
        source.id,
      ]);
      await tx.execute("UPDATE issues SET updated_at = $1 WHERE id = $2", [
        timestamp,
        issue.issue_id,
      ]);
      await recordPostgresLabelActivity(
        tx,
        issue.issue_id,
        viewer.id,
        "unlabeled",
        {
          label: source.name,
          reason: "label_merged",
          target: target.name,
        },
        timestamp,
      );
    }
    await tx.execute("UPDATE labels SET archived_at = $1, merged_into_id = $2 WHERE id = $3", [
      timestamp,
      target.id,
      source.id,
    ]);
    return {
      source: (await getPostgresLabel(tx, source.id))!,
      target: (await getPostgresLabel(tx, target.id))!,
      affectedIssues: issues.length,
    };
  });
}

async function recordPostgresLabelActivity(
  persistence: PersistenceTransaction,
  issueId: string,
  actorId: string,
  type: "labeled" | "unlabeled",
  payload: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  await persistence.execute(
    `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [newId(), issueId, actorId, type, JSON.stringify(payload), createdAt],
  );
}

export async function deletePostgresLabel(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
): Promise<number> {
  return persistence.transaction(async (tx) => {
    const label = await getPostgresLabel(tx, id);
    if (!label) throw apiError("NOT_FOUND", "Label not found");
    await assertLabelManageAccess(tx, viewer, label.team_id);
    if (label.is_group) {
      const children = await tx.one<{ count: number }>(
        "SELECT count(*)::int AS count FROM labels WHERE group_id = $1",
        [id],
      );
      if ((children?.count ?? 0) > 0) {
        throw apiError(
          "VALIDATION_FAILED",
          "Delete the labels in a group before deleting the group",
        );
      }
    }
    const issues = await tx.many<{ issue_id: string }>(
      "SELECT issue_id FROM issue_labels WHERE label_id = $1",
      [id],
    );
    const timestamp = now();
    for (const issue of issues) {
      await tx.execute("UPDATE issues SET updated_at = $1 WHERE id = $2", [
        timestamp,
        issue.issue_id,
      ]);
      await recordPostgresLabelActivity(
        tx,
        issue.issue_id,
        viewer.id,
        "unlabeled",
        {
          label: label.name,
          reason: "label_deleted",
        },
        timestamp,
      );
    }
    await tx.execute("DELETE FROM issue_labels WHERE label_id = $1", [id]);
    await tx.execute("DELETE FROM labels WHERE id = $1", [id]);
    return issues.length;
  });
}

async function applicableLabel(
  persistence: Persistence | PersistenceTransaction,
  issue: IssueRow,
  labelId: string,
): Promise<PostgresLabelRow> {
  const label = await getPostgresLabel(persistence, labelId);
  if (!label) throw apiError("NOT_FOUND", `Label not found: ${labelId}`);
  if (label.archived_at) throw apiError("VALIDATION_FAILED", `Label ${label.name} is archived`);
  if (label.is_group) throw apiError("VALIDATION_FAILED", `Label ${label.name} is a group`);
  if (label.group_id) {
    const group = await getPostgresLabel(persistence, label.group_id);
    if (!group || group.archived_at) {
      throw apiError("VALIDATION_FAILED", `Label group for ${label.name} is archived`);
    }
  }
  if (label.team_id !== null && label.team_id !== issue.team_id) {
    throw apiError("VALIDATION_FAILED", `Label ${label.name} belongs to another team`);
  }
  return label;
}

export async function applyPostgresLabelOps(
  persistence: PersistenceTransaction,
  actorId: string,
  issue: IssueRow,
  ops: {
    labelIds?: string[] | null;
    addLabelIds?: string[] | null;
    removeLabelIds?: string[] | null;
  },
): Promise<boolean> {
  const currentRows = await listPostgresIssueLabels(persistence, issue.id);
  const current = new Set(currentRows.map((label) => label.id));
  const target = new Set(current);
  if (ops.labelIds != null) {
    target.clear();
    ops.labelIds.forEach((id) => target.add(id));
  }
  for (const id of ops.addLabelIds ?? []) target.add(id);
  for (const id of ops.removeLabelIds ?? []) target.delete(id);
  const toAdd = [...target].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !target.has(id));
  if (!toAdd.length && !toRemove.length) return false;

  const targetRows: PostgresLabelRow[] = [];
  for (const id of target) {
    const existing = currentRows.find((label) => label.id === id);
    targetRows.push(existing ?? (await applicableLabel(persistence, issue, id)));
  }
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
  for (const labelId of toAdd) await applicableLabel(persistence, issue, labelId);

  const timestamp = now();
  for (const labelId of toAdd) {
    const label = await applicableLabel(persistence, issue, labelId);
    await persistence.execute("INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2)", [
      issue.id,
      labelId,
    ]);
    await recordPostgresLabelActivity(
      persistence,
      issue.id,
      actorId,
      "labeled",
      {
        label: label.name,
      },
      timestamp,
    );
  }
  for (const labelId of toRemove) {
    const label = await getPostgresLabel(persistence, labelId);
    await persistence.execute("DELETE FROM issue_labels WHERE issue_id = $1 AND label_id = $2", [
      issue.id,
      labelId,
    ]);
    await recordPostgresLabelActivity(
      persistence,
      issue.id,
      actorId,
      "unlabeled",
      {
        label: label?.name ?? labelId,
      },
      timestamp,
    );
  }
  return true;
}
