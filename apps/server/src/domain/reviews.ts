// Reviews de issues (PRB-205).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getIssueByRef } from "./issues.ts";

export type ReviewStatus = "requested" | "in_progress" | "approved" | "rejected";

export interface ReviewRow {
  id: string;
  issue_id: string;
  requester_id: string;
  reviewer_id: string;
  status: ReviewStatus;
  created_at: string;
  updated_at: string;
}

export function mapReview(row: ReviewRow) {
  return {
    id: row.id,
    issueId: row.issue_id,
    requesterId: row.requester_id,
    reviewerId: row.reviewer_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getReview(db: Database, id: string): ReviewRow | null {
  return db.query("SELECT * FROM reviews WHERE id = ?1").get(id) as ReviewRow | null;
}

/**
 * Cola del viewer: revisiones donde es reviewer o requester,
 * más recientes primero. Opcionalmente solo status abiertos.
 */
export function listReviews(
  db: Database,
  viewerId: string,
  opts: {
    openOnly?: boolean;
    first?: number;
    teamId?: string | null;
    projectId?: string | null;
    reviewerId?: string | null;
    olderThanDays?: number | null;
  } = {},
): ReviewRow[] {
  const first = Math.min(Math.max(opts.first ?? 50, 1), 100);
  const openOnly = opts.openOnly ?? false;
  const clauses = ["(r.reviewer_id = ?1 OR r.requester_id = ?1)"];
  const params: unknown[] = [viewerId];

  if (openOnly) {
    clauses.push("r.status IN ('requested', 'in_progress')");
  }
  if (opts.reviewerId) {
    params.push(opts.reviewerId);
    clauses.push(`r.reviewer_id = ?${params.length}`);
  }
  if (opts.teamId) {
    params.push(opts.teamId);
    clauses.push(`i.team_id = ?${params.length}`);
  }
  if (opts.projectId) {
    params.push(opts.projectId);
    clauses.push(`i.project_id = ?${params.length}`);
  }
  if (opts.olderThanDays != null && opts.olderThanDays > 0) {
    const cutoff = new Date(Date.now() - opts.olderThanDays * 86_400_000).toISOString();
    params.push(cutoff);
    clauses.push(`r.created_at <= ?${params.length}`);
  }

  params.push(first);
  return db
    .query(
      `SELECT r.*
       FROM reviews r
       JOIN issues i ON i.id = r.issue_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?${params.length}`,
    )
    .all(...(params as never[])) as ReviewRow[];
}

function resolveStatus(status: string): ReviewStatus {
  const normalized = status.toLowerCase() as ReviewStatus;
  if (
    normalized !== "requested" &&
    normalized !== "in_progress" &&
    normalized !== "approved" &&
    normalized !== "rejected"
  ) {
    throw apiError("VALIDATION_FAILED", `Invalid review status: ${status}`);
  }
  return normalized;
}

export function createReview(
  db: Database,
  requesterId: string,
  input: { issueId: string; reviewerId: string },
): ReviewRow {
  const issue = getIssueByRef(db, input.issueId);
  if (!issue) throw apiError("NOT_FOUND", "Issue not found");
  if (!db.query("SELECT id FROM actors WHERE id = ?1").get(input.reviewerId)) {
    throw apiError("NOT_FOUND", "Reviewer not found");
  }
  const id = newId();
  const timestamp = now();
  db.query(
    `INSERT INTO reviews
      (id, issue_id, requester_id, reviewer_id, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'requested', ?5, ?5)`,
  ).run(id, issue.id, requesterId, input.reviewerId, timestamp);
  return getReview(db, id)!;
}

export function updateReview(
  db: Database,
  id: string,
  viewerId: string,
  input: { status?: string | null; reviewerId?: string | null },
): ReviewRow {
  const existing = getReview(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Review not found");
  if (existing.reviewer_id !== viewerId && existing.requester_id !== viewerId) {
    throw apiError("NOT_FOUND", "Review not found");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };

  if (input.status != null) push("status", resolveStatus(input.status));
  if (input.reviewerId !== undefined && input.reviewerId !== null) {
    if (!db.query("SELECT id FROM actors WHERE id = ?1").get(input.reviewerId)) {
      throw apiError("NOT_FOUND", "Reviewer not found");
    }
    push("reviewer_id", input.reviewerId);
  }

  if (sets.length > 0) {
    push("updated_at", now());
    params.push(id);
    db.query(`UPDATE reviews SET ${sets.join(", ")} WHERE id = ?${params.length}`).run(
      ...(params as never[]),
    );
  }
  return getReview(db, id)!;
}

export function deleteReview(db: Database, id: string, viewerId: string): boolean {
  const existing = getReview(db, id);
  if (!existing) throw apiError("NOT_FOUND", "Review not found");
  if (existing.requester_id !== viewerId && existing.reviewer_id !== viewerId) {
    throw apiError("NOT_FOUND", "Review not found");
  }
  db.query("DELETE FROM reviews WHERE id = ?1").run(id);
  return true;
}
