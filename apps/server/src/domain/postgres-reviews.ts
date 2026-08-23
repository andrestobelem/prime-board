import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getPostgresActor } from "./postgres-actors.ts";
import { getPostgresIssueByRef } from "./postgres-issues.ts";
import type { ReviewRow, ReviewStatus } from "./reviews.ts";

export interface PostgresReviewListOptions {
  openOnly?: boolean;
  first?: number;
  teamId?: string | null;
  projectId?: string | null;
  reviewerId?: string | null;
  olderThanDays?: number | null;
}

function reviewLimit(first: number | null | undefined): number {
  return Math.min(Math.max(first ?? 50, 1), 100);
}

function reviewStatus(status: string): ReviewStatus {
  switch (status.toLowerCase()) {
    case "requested":
      return "requested";
    case "in_progress":
      return "in_progress";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    default:
      throw apiError("VALIDATION_FAILED", `Invalid review status: ${status}`);
  }
}

function assertReviewParticipant(review: ReviewRow, viewerId: string, allowAdmin: boolean): void {
  if (!allowAdmin && review.reviewer_id !== viewerId && review.requester_id !== viewerId) {
    throw apiError("NOT_FOUND", "Review not found");
  }
}

export function mapPostgresReview(row: ReviewRow) {
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

export async function getPostgresReview(
  persistence: Persistence | PersistenceTransaction,
  id: string,
): Promise<ReviewRow | null> {
  return persistence.one<ReviewRow>("SELECT * FROM reviews WHERE id = $1", [id]);
}

/** Reviews visibles al viewer, ordenadas de más recientes a más antiguas. */
export async function listPostgresReviews(
  persistence: Persistence,
  viewerId: string,
  options: PostgresReviewListOptions = {},
): Promise<ReviewRow[]> {
  const clauses = ["(reviews.reviewer_id = $1 OR reviews.requester_id = $1)"];
  const params: Array<string | number> = [viewerId];

  if (options.openOnly) {
    clauses.push("reviews.status IN ('requested', 'in_progress')");
  }
  if (options.reviewerId) {
    params.push(options.reviewerId);
    clauses.push(`reviews.reviewer_id = $${params.length}`);
  }
  if (options.teamId) {
    params.push(options.teamId);
    clauses.push(`issues.team_id = $${params.length}`);
  }
  if (options.projectId) {
    params.push(options.projectId);
    clauses.push(`issues.project_id = $${params.length}`);
  }
  if (options.olderThanDays != null && options.olderThanDays > 0) {
    params.push(new Date(Date.now() - options.olderThanDays * 86_400_000).toISOString());
    clauses.push(`reviews.created_at <= $${params.length}`);
  }

  params.push(reviewLimit(options.first));
  return [
    ...(await persistence.many<ReviewRow>(
      `SELECT reviews.*
       FROM reviews
       JOIN issues ON issues.id = reviews.issue_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY reviews.created_at DESC, reviews.id DESC
       LIMIT $${params.length}`,
      params,
    )),
  ];
}

export async function createPostgresReview(
  persistence: Persistence,
  requesterId: string,
  input: { issueId: string; reviewerId: string },
): Promise<ReviewRow> {
  return persistence.transaction(async (tx) => {
    const issue = await getPostgresIssueByRef(tx, input.issueId);
    if (!issue) throw apiError("NOT_FOUND", "Issue not found");
    const reviewer = await getPostgresActor(tx, input.reviewerId);
    if (!reviewer) throw apiError("NOT_FOUND", "Reviewer not found");

    const id = newId();
    const timestamp = now();
    await tx.execute(
      `INSERT INTO reviews
       (id, issue_id, requester_id, reviewer_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'requested', $5, $5)`,
      [id, issue.id, requesterId, input.reviewerId, timestamp],
    );
    const review = await getPostgresReview(tx, id);
    if (!review) throw new Error("PostgreSQL review insert returned no row");
    return review;
  });
}

export async function updatePostgresReview(
  persistence: Persistence,
  id: string,
  viewerId: string,
  input: { status?: string | null; reviewerId?: string | null },
  allowAdmin = false,
): Promise<ReviewRow> {
  return persistence.transaction(async (tx) => {
    const existing = await tx.one<ReviewRow>("SELECT * FROM reviews WHERE id = $1 FOR UPDATE", [
      id,
    ]);
    if (!existing) throw apiError("NOT_FOUND", "Review not found");
    assertReviewParticipant(existing, viewerId, allowAdmin);

    const sets: string[] = [];
    const params: Array<string | null> = [];
    const push = (column: string, value: string | null) => {
      sets.push(`${column} = $${params.length + 1}`);
      params.push(value);
    };

    if (input.status != null) push("status", reviewStatus(input.status));
    if (input.reviewerId !== undefined && input.reviewerId !== null) {
      const reviewer = await getPostgresActor(tx, input.reviewerId);
      if (!reviewer) throw apiError("NOT_FOUND", "Reviewer not found");
      push("reviewer_id", input.reviewerId);
    }
    if (sets.length === 0) return existing;

    const timestamp = now();
    push("updated_at", timestamp);
    params.push(id);
    const review = await tx.one<ReviewRow>(
      `UPDATE reviews SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    if (!review) throw apiError("NOT_FOUND", "Review not found");
    return review;
  });
}

export async function deletePostgresReview(
  persistence: Persistence,
  id: string,
  viewerId: string,
  allowAdmin = false,
): Promise<boolean> {
  return persistence.transaction(async (tx) => {
    const existing = await tx.one<ReviewRow>("SELECT * FROM reviews WHERE id = $1 FOR UPDATE", [
      id,
    ]);
    if (!existing) throw apiError("NOT_FOUND", "Review not found");
    assertReviewParticipant(existing, viewerId, allowAdmin);
    await tx.execute("DELETE FROM reviews WHERE id = $1", [id]);
    return true;
  });
}
