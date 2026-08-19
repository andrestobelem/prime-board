import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getPostgresIssue, getPostgresIssueByRef } from "./postgres-issues.ts";
import type { IssueRow } from "./issues.ts";

export type PostgresStoredRelationType = "blocks" | "related" | "duplicate_of";
export type PostgresRelationType = PostgresStoredRelationType | "blocked_by" | "duplicated_by";
export interface PostgresRelationRow {
  id: string;
  issue_id: string;
  related_id: string;
  type: PostgresStoredRelationType;
  created_at: string;
}
export interface PostgresRelationView {
  id: string;
  type: PostgresRelationType;
  relatedId: string;
  createdAt: string;
}

const INVERSE: Record<PostgresStoredRelationType, PostgresRelationType> = {
  blocks: "blocked_by",
  related: "related",
  duplicate_of: "duplicated_by",
};
const NORMALIZE: Record<
  PostgresRelationType,
  { type: PostgresStoredRelationType; invert: boolean }
> = {
  blocks: { type: "blocks", invert: false },
  blocked_by: { type: "blocks", invert: true },
  related: { type: "related", invert: false },
  duplicate_of: { type: "duplicate_of", invert: false },
  duplicated_by: { type: "duplicate_of", invert: true },
};

export function mapPostgresRelation(view: PostgresRelationView) {
  return { id: view.id, type: view.type, _relatedId: view.relatedId, createdAt: view.createdAt };
}

function viewFromRow(row: PostgresRelationRow, issueId: string): PostgresRelationView {
  return row.issue_id === issueId
    ? { id: row.id, type: row.type, relatedId: row.related_id, createdAt: row.created_at }
    : { id: row.id, type: INVERSE[row.type], relatedId: row.issue_id, createdAt: row.created_at };
}

export async function listPostgresRelations(
  persistence: Persistence | PersistenceTransaction,
  issueId: string,
): Promise<PostgresRelationView[]> {
  const rows = await persistence.many<PostgresRelationRow>(
    "SELECT * FROM issue_relations WHERE issue_id = $1 OR related_id = $1 ORDER BY created_at, id",
    [issueId],
  );
  return rows.map((row) => viewFromRow(row, issueId));
}

export async function getPostgresRelation(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<PostgresRelationRow | null> {
  return persistence.one<PostgresRelationRow>("SELECT * FROM issue_relations WHERE id = $1", [id]);
}

async function assertNoBlockingCycle(
  persistence: Persistence | PersistenceTransaction,
  source: IssueRow,
  target: IssueRow,
): Promise<void> {
  const cycle = await persistence.one(
    `WITH RECURSIVE reachable(id) AS (
       SELECT $1
       UNION
       SELECT issue_relations.related_id
       FROM issue_relations JOIN reachable ON issue_relations.issue_id = reachable.id
       WHERE issue_relations.type = 'blocks'
     ) SELECT 1 FROM reachable WHERE id = $2 LIMIT 1`,
    [target.id, source.id],
  );
  if (cycle) {
    throw apiError(
      "VALIDATION_FAILED",
      `Relation would create a blocking cycle: ${source.team_id}-${source.number} → ${target.team_id}-${target.number}`,
    );
  }
}

export async function createPostgresRelation(
  persistence: Persistence,
  actorId: string,
  input: { issueId: string; relatedIssueId: string; type: PostgresRelationType },
): Promise<{
  view: PostgresRelationView;
  issue: IssueRow;
  relatedIssue: IssueRow;
}> {
  return persistence.transaction(async (tx) => {
    const issue = await getPostgresIssueByRef(tx, input.issueId);
    if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${input.issueId}`);
    const related = await getPostgresIssueByRef(tx, input.relatedIssueId);
    if (!related) throw apiError("NOT_FOUND", `Issue not found: ${input.relatedIssueId}`);
    if (issue.id === related.id)
      throw apiError("VALIDATION_FAILED", "An issue cannot be related to itself");
    const normalized = NORMALIZE[input.type];
    if (!normalized) throw apiError("VALIDATION_FAILED", "Invalid relation type");
    const source = normalized.invert ? related : issue;
    const target = normalized.invert ? issue : related;
    const existing =
      normalized.type === "related"
        ? await tx.one(
            `SELECT id FROM issue_relations WHERE type = 'related'
           AND ((issue_id = $1 AND related_id = $2) OR (issue_id = $2 AND related_id = $1))`,
            [source.id, target.id],
          )
        : await tx.one(
            "SELECT id FROM issue_relations WHERE issue_id = $1 AND related_id = $2 AND type = $3",
            [source.id, target.id, normalized.type],
          );
    if (existing) throw apiError("VALIDATION_FAILED", "Relation already exists");
    if (normalized.type === "blocks") await assertNoBlockingCycle(tx, source, target);
    const id = newId();
    const timestamp = now();
    await tx.execute(
      "INSERT INTO issue_relations (id, issue_id, related_id, type, created_at) VALUES ($1, $2, $3, $4, $5)",
      [id, source.id, target.id, normalized.type, timestamp],
    );
    await tx.execute("UPDATE issues SET updated_at = $1 WHERE id IN ($2, $3)", [
      timestamp,
      source.id,
      target.id,
    ]);
    const payloadSource = JSON.stringify({
      type: normalized.type,
      issue: `${target.team_key}-${target.number}`,
    });
    const payloadTarget = JSON.stringify({
      type: INVERSE[normalized.type],
      issue: `${source.team_key}-${source.number}`,
    });
    for (const [issueId, payload] of [
      [source.id, payloadSource],
      [target.id, payloadTarget],
    ] as const) {
      await tx.execute(
        `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
         VALUES ($1, $2, $3, 'relation_added', $4, $5)`,
        [newId(), issueId, actorId, payload, timestamp],
      );
    }
    return {
      view: viewFromRow(
        {
          id,
          issue_id: source.id,
          related_id: target.id,
          type: normalized.type,
          created_at: timestamp,
        },
        issue.id,
      ),
      issue,
      relatedIssue: related,
    };
  });
}

export async function deletePostgresRelation(
  persistence: Persistence,
  actorId: string,
  id: string,
): Promise<{
  issueId: string;
  relatedId: string;
  type: PostgresStoredRelationType;
  source: IssueRow;
  target: IssueRow;
}> {
  return persistence.transaction(async (tx) => {
    const row = await getPostgresRelation(tx, id);
    if (!row) throw apiError("NOT_FOUND", "Relation not found");
    const source = await getPostgresIssue(tx, row.issue_id);
    const target = await getPostgresIssue(tx, row.related_id);
    if (!source || !target) throw apiError("NOT_FOUND", "Issue not found");
    const timestamp = now();
    await tx.execute("DELETE FROM issue_relations WHERE id = $1", [id]);
    await tx.execute("UPDATE issues SET updated_at = $1 WHERE id IN ($2, $3)", [
      timestamp,
      source.id,
      target.id,
    ]);
    for (const [issueId, payload] of [
      [source.id, { type: row.type, issue: `${target.team_key}-${target.number}` }],
      [target.id, { type: INVERSE[row.type], issue: `${source.team_key}-${source.number}` }],
    ] as const) {
      await tx.execute(
        `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
         VALUES ($1, $2, $3, 'relation_removed', $4, $5)`,
        [newId(), issueId, actorId, JSON.stringify(payload), timestamp],
      );
    }
    return { issueId: row.issue_id, relatedId: row.related_id, type: row.type, source, target };
  });
}
