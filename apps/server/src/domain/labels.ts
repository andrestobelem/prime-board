// Dominio de labels: de workspace (team_id NULL) y de team (spec §3).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { recordActivity } from "./activity.ts";
import type { IssueRow } from "./issues.ts";

export interface LabelRow {
  id: string;
  name: string;
  color: string;
  team_id: string | null;
  created_at: string;
}

export function mapLabel(row: LabelRow) {
  return { id: row.id, name: row.name, color: row.color, teamId: row.team_id };
}

export function getLabel(db: Database, id: string): LabelRow | null {
  return db.query("SELECT * FROM labels WHERE id = ?1").get(id) as LabelRow | null;
}

export function createLabel(
  db: Database,
  input: { name: string; color?: string | null; teamId?: string | null },
): LabelRow {
  const name = input.name.trim();
  if (!name) throw apiError("VALIDATION_FAILED", "Label name cannot be empty");
  if (input.teamId) {
    const team = db.query("SELECT id FROM teams WHERE id = ?1").get(input.teamId);
    if (!team) throw apiError("NOT_FOUND", "Team not found");
  }
  // UNIQUE(team_id, name) no cubre NULL en SQLite: chequeo explícito.
  const duplicate = input.teamId
    ? db.query("SELECT id FROM labels WHERE team_id = ?1 AND name = ?2").get(input.teamId, name)
    : db.query("SELECT id FROM labels WHERE team_id IS NULL AND name = ?1").get(name);
  if (duplicate) throw apiError("VALIDATION_FAILED", `Label ${name} already exists in this scope`);

  const id = newId();
  db.query(
    "INSERT INTO labels (id, name, color, team_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(id, name, input.color ?? "#95a2b3", input.teamId ?? null, now());
  return db.query("SELECT * FROM labels WHERE id = ?1").get(id) as LabelRow;
}

export function updateLabel(
  db: Database,
  id: string,
  input: { name?: string | null; color?: string | null },
): LabelRow {
  const label = db.query("SELECT * FROM labels WHERE id = ?1").get(id) as LabelRow | null;
  if (!label) throw apiError("NOT_FOUND", "Label not found");
  if (input.name != null) {
    const name = input.name.trim();
    if (!name) throw apiError("VALIDATION_FAILED", "Label name cannot be empty");
    const duplicate = label.team_id
      ? db
          .query("SELECT id FROM labels WHERE team_id = ?1 AND name = ?2 AND id != ?3")
          .get(label.team_id, name, id)
      : db
          .query("SELECT id FROM labels WHERE team_id IS NULL AND name = ?1 AND id != ?2")
          .get(name, id);
    if (duplicate)
      throw apiError("VALIDATION_FAILED", `Label ${name} already exists in this scope`);
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name != null) {
    params.push(input.name.trim());
    sets.push(`name = ?${params.length}`);
  }
  if (input.color != null) {
    params.push(input.color);
    sets.push(`color = ?${params.length}`);
  }
  if (sets.length > 0) {
    params.push(id);
    db.query(`UPDATE labels SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
      ...(params as never[]),
    );
  }
  return db.query("SELECT * FROM labels WHERE id = ?1").get(id) as LabelRow;
}

/** Borra la label y la quita de todos los issues que la tenían. */
export function deleteLabel(db: Database, actorId: string, id: string): number {
  const label = db.query("SELECT * FROM labels WHERE id = ?1").get(id) as LabelRow | null;
  if (!label) throw apiError("NOT_FOUND", "Label not found");
  let affected = 0;
  db.transaction(() => {
    const issues = db
      .query("SELECT issue_id FROM issue_labels WHERE label_id = ?1")
      .values(id)
      .map((row) => row[0] as string);
    affected = issues.length;
    db.query("DELETE FROM issue_labels WHERE label_id = ?1").run(id);
    const timestamp = now();
    for (const issueId of issues) {
      db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2").run(timestamp, issueId);
      recordActivity(db, issueId, actorId, "unlabeled", {
        label: label.name,
        reason: "label_deleted",
      });
    }
    db.query("DELETE FROM labels WHERE id = ?1").run(id);
  })();
  return affected;
}

/** Labels visibles para un team: las de workspace + las propias. Sin team: todas. */
export function listLabels(db: Database, teamId?: string | null): LabelRow[] {
  if (teamId) {
    return db
      .query("SELECT * FROM labels WHERE team_id IS NULL OR team_id = ?1 ORDER BY name")
      .all(teamId) as LabelRow[];
  }
  return db.query("SELECT * FROM labels ORDER BY name").all() as LabelRow[];
}

export function listIssueLabels(db: Database, issueId: string): LabelRow[] {
  return db
    .query(
      `SELECT labels.* FROM labels
       JOIN issue_labels ON issue_labels.label_id = labels.id
       WHERE issue_labels.issue_id = ?1 ORDER BY labels.name`,
    )
    .all(issueId) as LabelRow[];
}

function assertApplicable(db: Database, issue: IssueRow, labelId: string): LabelRow {
  const label = db.query("SELECT * FROM labels WHERE id = ?1").get(labelId) as LabelRow | null;
  if (!label) throw apiError("NOT_FOUND", `Label not found: ${labelId}`);
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
  const current = new Set(listIssueLabels(db, issue.id).map((label) => label.id));
  let target = new Set(current);

  if (ops.labelIds != null) target = new Set(ops.labelIds);
  for (const id of ops.addLabelIds ?? []) target.add(id);
  for (const id of ops.removeLabelIds ?? []) target.delete(id);

  const toAdd = [...target].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !target.has(id));
  if (toAdd.length === 0 && toRemove.length === 0) return false;

  for (const labelId of toAdd) {
    const label = assertApplicable(db, issue, labelId);
    db.query("INSERT INTO issue_labels (issue_id, label_id) VALUES (?1, ?2)").run(
      issue.id,
      labelId,
    );
    recordActivity(db, issue.id, actorId, "labeled", { label: label.name });
  }
  for (const labelId of toRemove) {
    const label = db.query("SELECT name FROM labels WHERE id = ?1").get(labelId) as {
      name: string;
    } | null;
    db.query("DELETE FROM issue_labels WHERE issue_id = ?1 AND label_id = ?2").run(
      issue.id,
      labelId,
    );
    recordActivity(db, issue.id, actorId, "unlabeled", { label: label?.name ?? labelId });
  }
  return true;
}
