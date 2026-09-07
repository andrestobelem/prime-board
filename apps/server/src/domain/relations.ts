// Dominio de relaciones entre issues (AT-175): blocked-by leída desde ambos extremos.
//
// Almacenamiento canónico: una sola fila por relación con dirección issue_id → related_id.
// 'blocks' se normaliza al crearse (BLOCKED_BY invierte los extremos) y cada extremo
// la ve con el tipo que le corresponde ('blocks' de un lado, 'blocked_by' del otro).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { recordActivity } from "./activity.ts";
import { getIssue, getIssueByRef, identifierOf, type IssueRow } from "./issues.ts";

/** Tipos canónicos: como se guardan en la tabla. */
export type StoredRelationType = "blocks" | "related" | "duplicate_of";
/** Tipos de la API: incluyen las vistas inversas, que se normalizan al guardar. */
export type RelationType = StoredRelationType | "blocked_by" | "duplicated_by";

export interface RelationRow {
  id: string;
  issue_id: string;
  related_id: string;
  type: StoredRelationType;
  created_at: string;
  workspace_id: string | null;
}

/** La inversa con la que el otro extremo ve cada tipo ('related' es simétrica). */
const INVERSE: Record<RelationType, RelationType> = {
  blocks: "blocked_by",
  blocked_by: "blocks",
  related: "related",
  duplicate_of: "duplicated_by",
  duplicated_by: "duplicate_of",
};

/** Dirección canónica de cada tipo de la API: las vistas inversas invierten extremos. */
const NORMALIZE: Record<RelationType, { type: StoredRelationType; invert: boolean }> = {
  blocks: { type: "blocks", invert: false },
  blocked_by: { type: "blocks", invert: true },
  related: { type: "related", invert: false },
  duplicate_of: { type: "duplicate_of", invert: false },
  duplicated_by: { type: "duplicate_of", invert: true },
};

/** Vista de una relación desde uno de sus extremos. */
export interface RelationView {
  id: string;
  /** Tipo visto desde el issue consultado. */
  type: RelationType;
  /** El issue del otro extremo. */
  relatedId: string;
  createdAt: string;
}

export function mapRelation(view: RelationView) {
  return { id: view.id, type: view.type, _relatedId: view.relatedId, createdAt: view.createdAt };
}

export function getRelation(db: Database, id: string, workspaceId?: string): RelationRow | null {
  const query = workspaceId
    ? "SELECT * FROM issue_relations WHERE id = ?1 AND workspace_id = ?2"
    : "SELECT * FROM issue_relations WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as RelationRow | null;
}

export function listRelations(db: Database, issueId: string, workspaceId?: string): RelationView[] {
  const query = workspaceId
    ? `SELECT * FROM issue_relations
       WHERE workspace_id = ?2 AND (issue_id = ?1 OR related_id = ?1)
       ORDER BY created_at, id`
    : "SELECT * FROM issue_relations WHERE issue_id = ?1 OR related_id = ?1 ORDER BY created_at, id";
  const rows = (
    workspaceId ? db.query(query).all(issueId, workspaceId) : db.query(query).all(issueId)
  ) as RelationRow[];
  return rows.map((row) =>
    row.issue_id === issueId
      ? { id: row.id, type: row.type, relatedId: row.related_id, createdAt: row.created_at }
      : { id: row.id, type: INVERSE[row.type], relatedId: row.issue_id, createdAt: row.created_at },
  );
}

/**
 * Rechaza una relación de bloqueo que cierre un ciclo (AT-176): si el bloqueado
 * ya bloquea (transitivamente) al bloqueante, agregar blocks(source → target)
 * dejaría el grafo sin solución y el frontier de /wayfinder vacío para siempre.
 */
function assertNoBlockingCycle(
  db: Database,
  source: IssueRow,
  target: IssueRow,
  workspaceId?: string,
): void {
  // BFS sobre las aristas blocks desde target: ¿se llega a source?
  const parents = new Map<string, string>();
  const queue = [target.id];
  const seen = new Set([target.id]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === source.id) {
      // Reconstruye el camino target → … → source para nombrar el ciclo completo.
      const path: string[] = [];
      for (let node: string | undefined = source.id; node; node = parents.get(node)) {
        path.push(node);
      }
      const cycle = [source.id, target.id, ...path.reverse().slice(1)].map((id) =>
        identifierOf(getIssue(db, id, workspaceId)!),
      );
      throw apiError(
        "VALIDATION_FAILED",
        `Relation would create a blocking cycle: ${cycle.join(" → ")}`,
      );
    }
    const next = workspaceId
      ? db
          .query(
            "SELECT related_id FROM issue_relations WHERE issue_id = ?1 AND workspace_id = ?2 AND type = 'blocks'",
          )
          .values(current, workspaceId)
          .map((row) => row[0] as string)
      : db
          .query("SELECT related_id FROM issue_relations WHERE issue_id = ?1 AND type = 'blocks'")
          .values(current)
          .map((row) => row[0] as string);
    for (const neighbor of next) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      parents.set(neighbor, current);
      queue.push(neighbor);
    }
  }
}

export interface RelationCreateInput {
  /** Acepta UUID o identificador legible (AT-126). */
  issueId: string;
  relatedIssueId: string;
  type: RelationType;
}

export interface CreatedRelation {
  row: RelationRow;
  /** La relación vista desde input.issueId. */
  view: RelationView;
  issue: IssueRow;
  relatedIssue: IssueRow;
  stateChange?: { issueId: string; from: string; to: string };
}

export function createRelation(
  db: Database,
  actorId: string,
  input: RelationCreateInput,
  workspaceId?: string,
): CreatedRelation {
  const issue = getIssueByRef(db, input.issueId, workspaceId);
  if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${input.issueId}`);
  const related = getIssueByRef(db, input.relatedIssueId, workspaceId);
  if (!related) throw apiError("NOT_FOUND", `Issue not found: ${input.relatedIssueId}`);
  if (issue.id === related.id) {
    throw apiError("VALIDATION_FAILED", "An issue cannot be related to itself");
  }

  // Normalización a la dirección canónica: blocked_by(A, B) === blocks(B, A).
  const { type, invert } = NORMALIZE[input.type];
  const [source, target] = invert ? [related, issue] : [issue, related];

  // 'related' es simétrica: el duplicado se detecta en cualquiera de las dos direcciones.
  const existing =
    type === "related"
      ? db
          .query(
            `SELECT id FROM issue_relations
             WHERE type = 'related'
               AND workspace_id IS ?3
               AND ((issue_id = ?1 AND related_id = ?2) OR (issue_id = ?2 AND related_id = ?1))`,
          )
          .get(source.id, target.id, workspaceId ?? null)
      : db
          .query(
            "SELECT id FROM issue_relations WHERE issue_id = ?1 AND related_id = ?2 AND type = ?3 AND workspace_id IS ?4",
          )
          .get(source.id, target.id, type, workspaceId ?? null);
  if (existing) {
    throw apiError(
      "VALIDATION_FAILED",
      `Relation already exists: ${identifierOf(source)} ${type} ${identifierOf(target)}`,
    );
  }

  // Solo las relaciones de bloqueo forman un grafo con solución que cuidar (AT-178).
  if (type === "blocks") assertNoBlockingCycle(db, source, target, workspaceId);

  const id = newId();
  let stateChange: CreatedRelation["stateChange"];
  db.transaction(() => {
    const timestamp = now();
    let duplicateStateId: string | null = null;
    if (type === "duplicate_of") {
      const duplicate = db
        .query(
          `SELECT id FROM workflow_states
           WHERE team_id = ?1 AND lower(name) = lower('Duplicate') AND is_reserved = 1
           ORDER BY position, id LIMIT 1`,
        )
        .get(source.team_id) as { id: string } | null;
      if (!duplicate) {
        throw apiError(
          "VALIDATION_FAILED",
          "The source Team must have the reserved Duplicate state",
        );
      }
      duplicateStateId = duplicate.id;
    }
    db.query(
      `INSERT INTO issue_relations
        (id, issue_id, related_id, type, created_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).run(id, source.id, target.id, type, timestamp, workspaceId ?? null);
    if (duplicateStateId && source.state_id !== duplicateStateId) {
      db.query(
        workspaceId
          ? "UPDATE issues SET state_id = ?1, updated_at = ?2 WHERE id = ?3 AND workspace_id = ?4"
          : "UPDATE issues SET state_id = ?1, updated_at = ?2 WHERE id = ?3",
      ).run(
        ...(workspaceId
          ? [duplicateStateId, timestamp, source.id, workspaceId]
          : [duplicateStateId, timestamp, source.id]),
      );
      recordActivity(
        db,
        source.id,
        actorId,
        "state_changed",
        { from: source.state_id, to: duplicateStateId, reason: "duplicate_of" },
        undefined,
        workspaceId,
      );
      stateChange = { issueId: source.id, from: source.state_id, to: duplicateStateId };
    }
    if (workspaceId) {
      db.query("UPDATE issues SET updated_at = ?1 WHERE workspace_id = ?4 AND id IN (?2, ?3)").run(
        timestamp,
        source.id,
        target.id,
        workspaceId,
      );
    } else {
      db.query("UPDATE issues SET updated_at = ?1 WHERE id IN (?2, ?3)").run(
        timestamp,
        source.id,
        target.id,
      );
    }
    // El payload usa identificadores (claves naturales): sobreviven a un rebuild.
    recordActivity(
      db,
      source.id,
      actorId,
      "relation_added",
      { type, issue: identifierOf(target) },
      undefined,
      workspaceId,
    );
    recordActivity(
      db,
      target.id,
      actorId,
      "relation_added",
      { type: INVERSE[type], issue: identifierOf(source) },
      undefined,
      workspaceId,
    );
  })();

  const row = getRelation(db, id, workspaceId);
  if (!row) throw apiError("NOT_FOUND", `Relation not found: ${id}`);
  const refreshedIssue = getIssue(db, issue.id, workspaceId);
  const refreshedRelated = getIssue(db, related.id, workspaceId);
  if (!refreshedIssue || !refreshedRelated) throw apiError("NOT_FOUND", "Issue not found");
  const view: RelationView =
    row.issue_id === issue.id
      ? { id: row.id, type: row.type, relatedId: row.related_id, createdAt: row.created_at }
      : { id: row.id, type: INVERSE[row.type], relatedId: row.issue_id, createdAt: row.created_at };
  return { row, view, issue: refreshedIssue, relatedIssue: refreshedRelated, stateChange };
}

export function deleteRelation(
  db: Database,
  actorId: string,
  id: string,
  workspaceId?: string,
): { issueId: string; relatedId: string; type: StoredRelationType } {
  const row = getRelation(db, id, workspaceId);
  if (!row) throw apiError("NOT_FOUND", `Relation not found: ${id}`);
  const source = getIssueByRef(db, row.issue_id, workspaceId);
  const target = getIssueByRef(db, row.related_id, workspaceId);
  if (!source || !target) throw apiError("NOT_FOUND", "Issue not found");
  db.transaction(() => {
    const timestamp = now();
    if (workspaceId) {
      db.query("DELETE FROM issue_relations WHERE id = ?1 AND workspace_id = ?2").run(
        id,
        workspaceId,
      );
      db.query("UPDATE issues SET updated_at = ?1 WHERE workspace_id = ?4 AND id IN (?2, ?3)").run(
        timestamp,
        source.id,
        target.id,
        workspaceId,
      );
    } else {
      db.query("DELETE FROM issue_relations WHERE id = ?1").run(id);
      db.query("UPDATE issues SET updated_at = ?1 WHERE id IN (?2, ?3)").run(
        timestamp,
        source.id,
        target.id,
      );
    }
    recordActivity(
      db,
      source.id,
      actorId,
      "relation_removed",
      { type: row.type, issue: identifierOf(target) },
      undefined,
      workspaceId,
    );
    recordActivity(
      db,
      target.id,
      actorId,
      "relation_removed",
      { type: INVERSE[row.type], issue: identifierOf(source) },
      undefined,
      workspaceId,
    );
  })();
  return { issueId: row.issue_id, relatedId: row.related_id, type: row.type };
}
