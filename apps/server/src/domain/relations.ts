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
export type StoredRelationType = "blocks";
/** Tipos de la API: incluyen las vistas inversas, que se normalizan al guardar. */
export type RelationType = StoredRelationType | "blocked_by";

export interface RelationRow {
  id: string;
  issue_id: string;
  related_id: string;
  type: StoredRelationType;
  created_at: string;
}

/** La inversa con la que el otro extremo ve cada tipo dirigido. */
const INVERSE: Record<RelationType, RelationType> = {
  blocks: "blocked_by",
  blocked_by: "blocks",
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

export function listRelations(db: Database, issueId: string): RelationView[] {
  const rows = db
    .query(
      "SELECT * FROM issue_relations WHERE issue_id = ?1 OR related_id = ?1 ORDER BY created_at, id",
    )
    .all(issueId) as RelationRow[];
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
function assertNoBlockingCycle(db: Database, source: IssueRow, target: IssueRow): void {
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
      const cycle = [source.id, target.id, ...path.reverse().slice(1)]
        .map((id) => identifierOf(getIssue(db, id)!));
      throw apiError(
        "VALIDATION_FAILED",
        `Relation would create a blocking cycle: ${cycle.join(" → ")}`,
      );
    }
    const next = db
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
}

export function createRelation(
  db: Database,
  actorId: string,
  input: RelationCreateInput,
): CreatedRelation {
  const issue = getIssueByRef(db, input.issueId);
  if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${input.issueId}`);
  const related = getIssueByRef(db, input.relatedIssueId);
  if (!related) throw apiError("NOT_FOUND", `Issue not found: ${input.relatedIssueId}`);
  if (issue.id === related.id) {
    throw apiError("VALIDATION_FAILED", "An issue cannot be related to itself");
  }

  // Normalización a la dirección canónica: blocked_by(A, B) === blocks(B, A).
  const [source, target] = input.type === "blocked_by" ? [related, issue] : [issue, related];
  const type: StoredRelationType = "blocks";

  const existing = db
    .query("SELECT id FROM issue_relations WHERE issue_id = ?1 AND related_id = ?2 AND type = ?3")
    .get(source.id, target.id, type);
  if (existing) {
    throw apiError(
      "VALIDATION_FAILED",
      `Relation already exists: ${identifierOf(source)} ${type} ${identifierOf(target)}`,
    );
  }

  if (type === "blocks") assertNoBlockingCycle(db, source, target);

  const id = newId();
  db.transaction(() => {
    db.query(
      "INSERT INTO issue_relations (id, issue_id, related_id, type, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).run(id, source.id, target.id, type, now());
    // El payload usa identificadores (claves naturales): sobreviven a un rebuild.
    recordActivity(db, source.id, actorId, "relation_added", {
      type,
      issue: identifierOf(target),
    });
    recordActivity(db, target.id, actorId, "relation_added", {
      type: INVERSE[type],
      issue: identifierOf(source),
    });
  })();

  const row = db.query("SELECT * FROM issue_relations WHERE id = ?1").get(id) as RelationRow;
  const view: RelationView =
    row.issue_id === issue.id
      ? { id: row.id, type: row.type, relatedId: row.related_id, createdAt: row.created_at }
      : { id: row.id, type: INVERSE[row.type], relatedId: row.issue_id, createdAt: row.created_at };
  return { row, view, issue, relatedIssue: related };
}

export function deleteRelation(
  db: Database,
  actorId: string,
  id: string,
): { issueId: string; relatedId: string } {
  const row = db.query("SELECT * FROM issue_relations WHERE id = ?1").get(id) as RelationRow | null;
  if (!row) throw apiError("NOT_FOUND", `Relation not found: ${id}`);
  const source = getIssueByRef(db, row.issue_id)!;
  const target = getIssueByRef(db, row.related_id)!;
  db.transaction(() => {
    db.query("DELETE FROM issue_relations WHERE id = ?1").run(id);
    recordActivity(db, source.id, actorId, "relation_removed", {
      type: row.type,
      issue: identifierOf(target),
    });
    recordActivity(db, target.id, actorId, "relation_removed", {
      type: INVERSE[row.type],
      issue: identifierOf(source),
    });
  })();
  return { issueId: row.issue_id, relatedId: row.related_id };
}
