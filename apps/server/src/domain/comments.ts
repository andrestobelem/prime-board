// Dominio de comentarios: markdown plano sobre issues (spec §3).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";
import { recordActivity } from "./activity.ts";
import { getIssueByRef } from "./issues.ts";
import { parseDateTime } from "./datetime.ts";

export interface CommentRow {
  id: string;
  issue_id: string;
  actor_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
}

export function mapComment(row: CommentRow) {
  return {
    id: row.id,
    body: row.body,
    actorId: row.actor_id,
    issueId: row.issue_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

export function listComments(db: Database, issueId: string): CommentRow[] {
  return db
    .query("SELECT * FROM comments WHERE issue_id = ?1 ORDER BY created_at, id")
    .all(issueId) as CommentRow[];
}

export function createComment(
  db: Database,
  actorId: string,
  input: { issueId: string; body: string; createdAt?: string | null; authorId?: string | null },
): CommentRow {
  const issue = getIssueByRef(db, input.issueId);
  if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${input.issueId}`);
  const body = input.body.trim();
  if (!body) throw apiError("VALIDATION_FAILED", "Comment body cannot be empty");

  if (input.createdAt != null) parseDateTime(input.createdAt, "createdAt");
  if (
    input.authorId != null &&
    !db.query("SELECT id FROM actors WHERE id = ?1").get(input.authorId)
  ) {
    throw apiError("NOT_FOUND", "Comment author not found");
  }
  const author = input.authorId ?? actorId;
  const timestamp = input.createdAt ?? now();

  const id = newId();
  db.transaction(() => {
    db.query(
      "INSERT INTO comments (id, issue_id, actor_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).run(id, issue.id, author, body, timestamp);
    // Los comentarios forman parte de la actividad observable del issue y deben
    // mover el cursor de updatedAt para la sincronización incremental.
    db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2").run(now(), issue.id);
    // El body va en el evento para que el log pueda reconstruir el comentario.
    recordActivity(
      db,
      issue.id,
      author,
      "commented",
      { commentId: id, body },
      input.createdAt ?? undefined,
    );
  })();
  return db.query("SELECT * FROM comments WHERE id = ?1").get(id) as CommentRow;
}
