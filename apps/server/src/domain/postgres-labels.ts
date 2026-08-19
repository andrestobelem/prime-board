import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getPostgresTeam, isPostgresTeamOwner } from "./postgres-teams.ts";
import type { IssueRow } from "./issues.ts";
import type { ActorRow } from "../auth/viewer.ts";

export interface PostgresLabelRow {
  id: string;
  name: string;
  color: string;
  team_id: string | null;
  created_at: string;
}

export function mapPostgresLabel(row: PostgresLabelRow) {
  return { id: row.id, name: row.name, color: row.color, teamId: row.team_id };
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
): Promise<PostgresLabelRow[]> {
  if (teamId) {
    return [
      ...(await persistence.many<PostgresLabelRow>(
        "SELECT * FROM labels WHERE team_id IS NULL OR team_id = $1 ORDER BY name, id",
        [teamId],
      )),
    ];
  }
  return [...(await persistence.many<PostgresLabelRow>("SELECT * FROM labels ORDER BY name, id"))];
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

export async function createPostgresLabel(
  persistence: Persistence,
  viewer: ActorRow,
  input: { name: string; color?: string | null; teamId?: string | null },
): Promise<PostgresLabelRow> {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Label name cannot be empty");
  await assertLabelManageAccess(persistence, viewer, input.teamId ?? null);
  const duplicate = await persistence.one(
    input.teamId
      ? "SELECT id FROM labels WHERE team_id = $1 AND name = $2"
      : "SELECT id FROM labels WHERE team_id IS NULL AND name = $1",
    input.teamId ? [input.teamId, name] : [name],
  );
  if (duplicate) throw apiError("VALIDATION_FAILED", `Label ${name} already exists in this scope`);
  const id = newId();
  await persistence.execute(
    "INSERT INTO labels (id, name, color, team_id, created_at) VALUES ($1, $2, $3, $4, $5)",
    [id, name, input.color ?? "#95a2b3", input.teamId ?? null, now()],
  );
  return (await getPostgresLabel(persistence, id))!;
}

export async function updatePostgresLabel(
  persistence: Persistence,
  viewer: ActorRow,
  id: string,
  input: { name?: string | null; color?: string | null },
): Promise<PostgresLabelRow> {
  const label = await getPostgresLabel(persistence, id);
  if (!label) throw apiError("NOT_FOUND", "Label not found");
  await assertLabelManageAccess(persistence, viewer, label.team_id);
  const params: SqlValue[] = [];
  const sets: string[] = [];
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Label name cannot be empty");
    const duplicate = await persistence.one(
      label.team_id
        ? "SELECT id FROM labels WHERE team_id = $1 AND name = $2 AND id <> $3"
        : "SELECT id FROM labels WHERE team_id IS NULL AND name = $1 AND id <> $2",
      label.team_id ? [label.team_id, name, id] : [name, id],
    );
    if (duplicate)
      throw apiError("VALIDATION_FAILED", `Label ${name} already exists in this scope`);
    sets.push(`name = $${params.length + 1}`);
    params.push(name);
  }
  if (input.color != null) {
    sets.push(`color = $${params.length + 1}`);
    params.push(input.color);
  }
  if (sets.length) {
    params.push(id);
    await persistence.execute(
      `UPDATE labels SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params,
    );
  }
  return (await getPostgresLabel(persistence, id))!;
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
      await tx.execute(
        `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
         VALUES ($1, $2, $3, 'unlabeled', $4, $5)`,
        [
          newId(),
          issue.issue_id,
          viewer.id,
          JSON.stringify({ label: label.name, reason: "label_deleted" }),
          timestamp,
        ],
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
  if (ops.labelIds != null) (target.clear(), ops.labelIds.forEach((id) => target.add(id)));
  for (const id of ops.addLabelIds ?? []) target.add(id);
  for (const id of ops.removeLabelIds ?? []) target.delete(id);
  const toAdd = [...target].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !target.has(id));
  if (!toAdd.length && !toRemove.length) return false;
  const timestamp = now();
  for (const labelId of toAdd) {
    const label = await applicableLabel(persistence, issue, labelId);
    await persistence.execute("INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2)", [
      issue.id,
      labelId,
    ]);
    await persistence.execute(
      `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
       VALUES ($1, $2, $3, 'labeled', $4, $5)`,
      [newId(), issue.id, actorId, JSON.stringify({ label: label.name }), timestamp],
    );
  }
  for (const labelId of toRemove) {
    const label = await getPostgresLabel(persistence, labelId);
    await persistence.execute("DELETE FROM issue_labels WHERE issue_id = $1 AND label_id = $2", [
      issue.id,
      labelId,
    ]);
    await persistence.execute(
      `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
       VALUES ($1, $2, $3, 'unlabeled', $4, $5)`,
      [newId(), issue.id, actorId, JSON.stringify({ label: label?.name ?? labelId }), timestamp],
    );
  }
  return true;
}
