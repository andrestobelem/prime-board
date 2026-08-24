// Reviews de issues (PRB-205).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { getIssueByRef } from "./issues.ts";

export type ReviewStatus = "requested" | "in_progress" | "approved" | "rejected";

function workspaceClause(column: string, parameter: string): string {
  return `(${column} = ${parameter} OR (${column} IS NULL AND (SELECT count(*) FROM workspace) = 1))`;
}

export interface ReviewRow {
  id: string;
  issue_id: string;
  requester_id: string;
  reviewer_id: string;
  status: ReviewStatus;
  created_at: string;
  updated_at: string;
  workspace_id?: string | null;
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

export function getReview(db: Database, id: string, workspaceId?: string): ReviewRow | null {
  const query = workspaceId
    ? `SELECT * FROM reviews WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`
    : "SELECT * FROM reviews WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as ReviewRow | null;
}

/**
 * Cola del viewer: revisiones donde es reviewer o requester,
 * más recientes primero. La página usa un cursor opaco y conserva los filtros.
 */
export interface ListReviewsOptions {
  openOnly?: boolean;
  first?: number;
  after?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  reviewerId?: string | null;
  olderThanDays?: number | null;
  /** Teams que ya fueron autorizados por el resolver. */
  teamIds?: readonly string[] | null;
  workspaceId?: string | null;
}

export interface ReviewPage {
  rows: ReviewRow[];
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ReviewCursor {
  createdAt: string;
  id: string;
  filterKey: string;
}

function effectiveOlderThanDays(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

function reviewFilterKey(options: ListReviewsOptions): string {
  return JSON.stringify([
    Boolean(options.openOnly),
    options.teamId ?? null,
    options.projectId ?? null,
    options.reviewerId ?? null,
    effectiveOlderThanDays(options.olderThanDays),
    options.workspaceId ?? null,
    options.teamIds ? [...options.teamIds].sort() : null,
    "CREATED_DESC",
  ]);
}

function encodeReviewCursor(createdAt: string, id: string, filterKey: string): string {
  return Buffer.from(JSON.stringify([createdAt, id, filterKey])).toString("base64url");
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
  options: ListReviewsOptions,
  params: unknown[],
): string[] {
  params.push(viewerId);
  const add = (value: unknown): string => {
    params.push(value);
    return `?${params.length}`;
  };
  const clauses = [`(r.reviewer_id = ?1 OR r.requester_id = ?1)`];

  if (options.openOnly) clauses.push("r.status IN ('requested', 'in_progress')");
  if (options.reviewerId) clauses.push(`r.reviewer_id = ${add(options.reviewerId)}`);
  if (options.teamId) clauses.push(`i.team_id = ${add(options.teamId)}`);
  if (options.projectId) clauses.push(`i.project_id = ${add(options.projectId)}`);
  if (options.workspaceId) {
    const workspaceParameter = add(options.workspaceId);
    clauses.push(workspaceClause("r.workspace_id", workspaceParameter));
  }
  if (options.teamIds) {
    if (options.teamIds.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(`i.team_id IN (${options.teamIds.map(add).join(", ")})`);
    }
  }
  const olderThanDays = effectiveOlderThanDays(options.olderThanDays);
  if (olderThanDays != null) {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    clauses.push(`r.created_at <= ${add(cutoff)}`);
  }
  return clauses;
}

export function listReviews(
  db: Database,
  viewerId: string,
  options: ListReviewsOptions = {},
): ReviewPage {
  const first = options.first ?? 50;
  if (!Number.isInteger(first) || first < 1 || first > 250) {
    throw apiError("VALIDATION_FAILED", "first must be between 1 and 250");
  }

  const filterKey = reviewFilterKey(options);
  const params: unknown[] = [];
  const clauses = buildReviewClauses(viewerId, options, params);
  if (options.after != null) {
    const cursor = decodeReviewCursor(options.after);
    if (!cursor || cursor.filterKey !== filterKey) {
      throw apiError("VALIDATION_FAILED", "Invalid review cursor");
    }

    // El cursor debe seguir perteneciendo a la misma conexión. Así no se
    // reinicia la página ni se acepta un cursor de otra combinación de filtros.
    const cursorParams: unknown[] = [];
    const cursorClauses = buildReviewClauses(viewerId, options, cursorParams);
    cursorParams.push(cursor.id);
    const cursorRow = db
      .query(
        `SELECT r.created_at
         FROM reviews r
         JOIN issues i ON i.id = r.issue_id
         WHERE ${cursorClauses.join(" AND ")} AND r.id = ?${cursorParams.length}`,
      )
      .get(...(cursorParams as never[])) as { created_at: string } | null;
    if (!cursorRow || cursorRow.created_at !== cursor.createdAt) {
      throw apiError("VALIDATION_FAILED", "Invalid review cursor");
    }

    const createdAtParam = params.length + 1;
    params.push(cursor.createdAt);
    const idParam = params.length + 1;
    params.push(cursor.id);
    clauses.push(`(r.created_at, r.id) < (?${createdAtParam}, ?${idParam})`);
  }

  const rows = db
    .query(
      `SELECT r.*
       FROM reviews r
       JOIN issues i ON i.id = r.issue_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ${first + 1}`,
    )
    .all(...(params as never[])) as ReviewRow[];
  const page = rows.slice(0, first);
  const last = page[page.length - 1];
  return {
    rows: page,
    hasNextPage: rows.length > first,
    endCursor: last ? encodeReviewCursor(last.created_at, last.id, filterKey) : null,
  };
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
  workspaceId?: string,
): ReviewRow {
  const issue =
    getIssueByRef(db, input.issueId, workspaceId) ??
    (workspaceId &&
    (db.query("SELECT count(*) AS count FROM workspace").get() as { count: number }).count === 1
      ? getIssueByRef(db, input.issueId)
      : null);
  if (!issue) throw apiError("NOT_FOUND", "Issue not found");
  const reviewer = workspaceId
    ? db
        .query(
          `SELECT actors.id FROM actors
           JOIN workspace_memberships ON workspace_memberships.actor_id = actors.id
            AND workspace_memberships.workspace_id = ?2
           WHERE actors.id = ?1`,
        )
        .get(input.reviewerId, workspaceId)
    : db.query("SELECT id FROM actors WHERE id = ?1").get(input.reviewerId);
  if (!reviewer) throw apiError("NOT_FOUND", "Reviewer not found");
  const id = newId();
  const timestamp = now();
  db.query(
    `INSERT INTO reviews
      (id, issue_id, requester_id, reviewer_id, status, created_at, updated_at, workspace_id)
     VALUES (?1, ?2, ?3, ?4, 'requested', ?5, ?5, ?6)`,
  ).run(id, issue.id, requesterId, input.reviewerId, timestamp, workspaceId ?? null);
  return getReview(db, id, workspaceId)!;
}

export function updateReview(
  db: Database,
  id: string,
  viewerId: string,
  input: { status?: string | null; reviewerId?: string | null },
  allowAdmin = false,
  workspaceId?: string,
): ReviewRow {
  const existing = getReview(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Review not found");
  if (!allowAdmin && existing.reviewer_id !== viewerId && existing.requester_id !== viewerId) {
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
    const reviewer = workspaceId
      ? db
          .query(
            `SELECT actors.id FROM actors
             JOIN workspace_memberships ON workspace_memberships.actor_id = actors.id
              AND workspace_memberships.workspace_id = ?2
             WHERE actors.id = ?1`,
          )
          .get(input.reviewerId, workspaceId)
      : db.query("SELECT id FROM actors WHERE id = ?1").get(input.reviewerId);
    if (!reviewer) {
      throw apiError("NOT_FOUND", "Reviewer not found");
    }
    push("reviewer_id", input.reviewerId);
  }

  if (sets.length > 0) {
    push("updated_at", now());
    params.push(id);
    const workspaceFilter = workspaceId
      ? ` AND ${workspaceClause("workspace_id", `?${params.length + 1}`)}`
      : "";
    if (workspaceId) params.push(workspaceId);
    db.query(
      `UPDATE reviews SET ${sets.join(", ")} WHERE id = ?${params.length - (workspaceId ? 1 : 0)}${workspaceFilter}`,
    ).run(...(params as never[]));
  }
  return getReview(db, id, workspaceId)!;
}

export function deleteReview(
  db: Database,
  id: string,
  viewerId: string,
  allowAdmin = false,
  workspaceId?: string,
): boolean {
  const existing = getReview(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Review not found");
  if (!allowAdmin && existing.requester_id !== viewerId && existing.reviewer_id !== viewerId) {
    throw apiError("NOT_FOUND", "Review not found");
  }
  if (workspaceId) {
    db.query(`DELETE FROM reviews WHERE id = ?1 AND ${workspaceClause("workspace_id", "?2")}`).run(
      id,
      workspaceId,
    );
  } else {
    db.query("DELETE FROM reviews WHERE id = ?1").run(id);
  }
  return true;
}
