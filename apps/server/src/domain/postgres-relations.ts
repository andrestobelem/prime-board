import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getPostgresIssue, getPostgresIssueByRef } from "./postgres-issues.ts";
import type { IssueRow } from "./issues.ts";
import type { PostgresWorkspaceContext } from "./postgres-workspace-scope.ts";
import {
  issueIdWorkspaceScope,
  issueRelationWorkspaceScope,
  scopedWorkspacePredicate,
} from "./postgres-workspace-scope.ts";

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
  context?: PostgresWorkspaceContext,
): Promise<PostgresRelationView[]> {
  const scope = scopedWorkspacePredicate(
    context,
    (workspaceParam) => issueRelationWorkspaceScope("issue_relations", workspaceParam),
    "$2",
  );
  const rows = await persistence.many<PostgresRelationRow>(
    `SELECT issue_relations.* FROM issue_relations
      WHERE (issue_relations.issue_id = $1 OR issue_relations.related_id = $1) AND ${scope}
      ORDER BY issue_relations.created_at, issue_relations.id`,
    [issueId, ...(context ? [context.workspaceId] : [])],
  );
  return rows.map((row) => viewFromRow(row, issueId));
}

export async function getPostgresRelation(
  persistence: Persistence | PersistenceTransaction,
  id: string,
  context?: PostgresWorkspaceContext,
): Promise<PostgresRelationRow | null> {
  const scope = scopedWorkspacePredicate(
    context,
    (workspaceParam) => issueRelationWorkspaceScope("issue_relations", workspaceParam),
    "$2",
  );
  return persistence.one<PostgresRelationRow>(
    `SELECT issue_relations.* FROM issue_relations WHERE issue_relations.id = $1 AND ${scope}`,
    [id, ...(context ? [context.workspaceId] : [])],
  );
}

async function assertNoBlockingCycle(
  persistence: Persistence | PersistenceTransaction,
  source: IssueRow,
  target: IssueRow,
  context?: PostgresWorkspaceContext,
): Promise<void> {
  const cycle = await persistence.one(
    `WITH RECURSIVE reachable(id) AS (
       SELECT $1
       UNION
       SELECT issue_relations.related_id
       FROM issue_relations
       JOIN reachable ON issue_relations.issue_id = reachable.id
       JOIN issues AS cycle_source ON cycle_source.id = issue_relations.issue_id
       JOIN issues AS cycle_target ON cycle_target.id = issue_relations.related_id
       WHERE issue_relations.type = 'blocks'
         ${context ? "AND cycle_source.workspace_id = $3 AND cycle_target.workspace_id = $3" : ""}
     ) SELECT 1 FROM reachable WHERE id = $2 LIMIT 1`,
    [target.id, source.id, ...(context ? [context.workspaceId] : [])],
  );
  if (cycle) {
    throw apiError(
      "VALIDATION_FAILED",
      `Relation would create a blocking cycle: ${source.team_key}-${source.number} → ${target.team_key}-${target.number}`,
    );
  }
}

export async function createPostgresRelation(
  persistence: Persistence,
  actorId: string,
  input: { issueId: string; relatedIssueId: string; type: PostgresRelationType },
  context?: PostgresWorkspaceContext,
): Promise<{
  view: PostgresRelationView;
  issue: IssueRow;
  relatedIssue: IssueRow;
}> {
  return persistence.transaction(async (tx) => {
    const issue = await getPostgresIssueByRef(tx, input.issueId, context);
    if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${input.issueId}`);
    const related = await getPostgresIssueByRef(tx, input.relatedIssueId, context);
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
            `SELECT issue_relations.id FROM issue_relations
             JOIN issues AS existing_source ON existing_source.id = issue_relations.issue_id
             JOIN issues AS existing_target ON existing_target.id = issue_relations.related_id
             WHERE issue_relations.type = 'related'
               AND ((issue_relations.issue_id = $1 AND issue_relations.related_id = $2)
                 OR (issue_relations.issue_id = $2 AND issue_relations.related_id = $1))
               ${context ? "AND existing_source.workspace_id = $3 AND existing_target.workspace_id = $3" : ""}`,
            [source.id, target.id, ...(context ? [context.workspaceId] : [])],
          )
        : await tx.one(
            `SELECT issue_relations.id FROM issue_relations
             JOIN issues AS existing_source ON existing_source.id = issue_relations.issue_id
             JOIN issues AS existing_target ON existing_target.id = issue_relations.related_id
             WHERE issue_relations.issue_id = $1 AND issue_relations.related_id = $2
               AND issue_relations.type = $3
               ${context ? "AND existing_source.workspace_id = $4 AND existing_target.workspace_id = $4" : ""}`,
            [source.id, target.id, normalized.type, ...(context ? [context.workspaceId] : [])],
          );
    if (existing) throw apiError("VALIDATION_FAILED", "Relation already exists");
    if (normalized.type === "blocks") await assertNoBlockingCycle(tx, source, target, context);
    const id = newId();
    const timestamp = now();
    if (context) {
      await tx.execute(
        "INSERT INTO issue_relations (workspace_id, id, issue_id, related_id, type, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [context.workspaceId, id, source.id, target.id, normalized.type, timestamp],
      );
    } else {
      await tx.execute(
        "INSERT INTO issue_relations (id, issue_id, related_id, type, created_at) VALUES ($1, $2, $3, $4, $5)",
        [id, source.id, target.id, normalized.type, timestamp],
      );
    }
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
      if (context) {
        await tx.execute(
          `INSERT INTO activity (id, workspace_id, issue_id, actor_id, type, payload, created_at)
           VALUES ($1, $2, $3, $4, 'relation_added', $5, $6)`,
          [newId(), context.workspaceId, issueId, actorId, payload, timestamp],
        );
      } else {
        await tx.execute(
          `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
           VALUES ($1, $2, $3, 'relation_added', $4, $5)`,
          [newId(), issueId, actorId, payload, timestamp],
        );
      }
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
  context?: PostgresWorkspaceContext,
): Promise<{
  issueId: string;
  relatedId: string;
  type: PostgresStoredRelationType;
  source: IssueRow;
  target: IssueRow;
}> {
  return persistence.transaction(async (tx) => {
    const row = await getPostgresRelation(tx, id, context);
    if (!row) throw apiError("NOT_FOUND", "Relation not found");
    const source = await getPostgresIssue(tx, row.issue_id, context);
    const target = await getPostgresIssue(tx, row.related_id, context);
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
      if (context) {
        await tx.execute(
          `INSERT INTO activity (id, workspace_id, issue_id, actor_id, type, payload, created_at)
           VALUES ($1, $2, $3, $4, 'relation_removed', $5, $6)`,
          [newId(), context.workspaceId, issueId, actorId, JSON.stringify(payload), timestamp],
        );
      } else {
        await tx.execute(
          `INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at)
           VALUES ($1, $2, $3, 'relation_removed', $4, $5)`,
          [newId(), issueId, actorId, JSON.stringify(payload), timestamp],
        );
      }
    }
    return { issueId: row.issue_id, relatedId: row.related_id, type: row.type, source, target };
  });
}
