import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getPostgresActor } from "./postgres-actors.ts";
import { getPostgresIssueByRef } from "./postgres-issues.ts";
import type { ReviewRow, ReviewStatus } from "./reviews.ts";

export interface PostgresReviewListOptions {
  openOnly?: boolean;
  first?: number;
  after?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  reviewerId?: string | null;
  olderThanDays?: number | null;
  /** Teams already authorized by the resolver. */
  teamIds?: readonly string[] | null;
}

export interface PostgresReviewPage {
  rows: ReviewRow[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function reviewLimit(first: number | null | undefined): number {
  const value = first ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > 250) {
    throw apiError("VALIDATION_FAILED", "first must be between 1 and 250");
  }
  return value;
}

function effectiveOlderThanDays(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

function reviewFilterKey(options: PostgresReviewListOptions): string {
  return JSON.stringify([
    Boolean(options.openOnly),
    options.teamId ?? null,
    options.projectId ?? null,
    options.reviewerId ?? null,
    effectiveOlderThanDays(options.olderThanDays),
    options.teamIds ? [...options.teamIds].sort() : null,
    "CREATED_DESC",
  ]);
}

function reviewTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function encodeReviewCursor(createdAt: string | Date, id: string, filterKey: string): string {
  return Buffer.from(JSON.stringify([reviewTimestamp(createdAt), id, filterKey])).toString(
    "base64url",
  );
}

interface ReviewCursor {
  createdAt: string;
  id: string;
  filterKey: string;
}

function decodeReviewCursor(cursor: string): ReviewCursor | null {
  try {
    if (Buffer.from(cursor, "base64url").toString("base64url") !== cursor) return null;
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string" ||
      !parsed[0] ||
      !parsed[1] ||
      !parsed[2]
    ) {
      return null;
    }
    return { createdAt: parsed[0], id: parsed[1], filterKey: parsed[2] };
  } catch {
    return null;
  }
}

function buildReviewClauses(
  viewerId: string,
  options: PostgresReviewListOptions,
  params: SqlValue[],
): string[] {
  params.push(viewerId);
  const add = (value: SqlValue): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const clauses = ["(reviews.reviewer_id = $1 OR reviews.requester_id = $1)"];

  if (options.openOnly) clauses.push("reviews.status IN ('requested', 'in_progress')");
  if (options.reviewerId) clauses.push(`reviews.reviewer_id = ${add(options.reviewerId)}`);
  if (options.teamId) clauses.push(`issues.team_id = ${add(options.teamId)}`);
  if (options.projectId) clauses.push(`issues.project_id = ${add(options.projectId)}`);
  if (options.teamIds) {
    if (options.teamIds.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(`issues.team_id IN (${options.teamIds.map(add).join(", ")})`);
    }
  }
  const olderThanDays = effectiveOlderThanDays(options.olderThanDays);
  if (olderThanDays != null) {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    clauses.push(`reviews.created_at <= ${add(cutoff)}`);
  }
  return clauses;
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
): Promise<PostgresReviewPage> {
  const first = reviewLimit(options.first);
  const filterKey = reviewFilterKey(options);
  const params: SqlValue[] = [];
  const clauses = buildReviewClauses(viewerId, options, params);

  if (options.after != null) {
    const cursor = decodeReviewCursor(options.after);
    if (!cursor || cursor.filterKey !== filterKey) {
      throw apiError("VALIDATION_FAILED", "Invalid review cursor");
    }

    // The cursor must still belong to the same connection and filter.
    const cursorParams: SqlValue[] = [];
    const cursorClauses = buildReviewClauses(viewerId, options, cursorParams);
    cursorParams.push(cursor.id);
    const cursorRow = await persistence.one<{ created_at: string | Date }>(
      `SELECT reviews.created_at
       FROM reviews
       JOIN issues ON issues.id = reviews.issue_id
       WHERE ${cursorClauses.join(" AND ")} AND reviews.id = $${cursorParams.length}`,
      cursorParams,
    );
    if (!cursorRow || reviewTimestamp(cursorRow.created_at) !== cursor.createdAt) {
      throw apiError("VALIDATION_FAILED", "Invalid review cursor");
    }

    const createdAtParam = params.length + 1;
    params.push(cursor.createdAt);
    const idParam = params.length + 1;
    params.push(cursor.id);
    clauses.push(`(reviews.created_at, reviews.id) < ($${createdAtParam}, $${idParam})`);
  }

  const rows = await persistence.many<ReviewRow>(
    `SELECT reviews.*
     FROM reviews
     JOIN issues ON issues.id = reviews.issue_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY reviews.created_at DESC, reviews.id DESC
     LIMIT ${first + 1}`,
    params,
  );
  const page = [...rows].slice(0, first);
  const last = page[page.length - 1];
  return {
    rows: page,
    hasNextPage: rows.length > first,
    endCursor: last ? encodeReviewCursor(last.created_at, last.id, filterKey) : null,
  };
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
