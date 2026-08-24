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
  workspace_id: string | null;
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

export function listComments(db: Database, issueId: string, workspaceId?: string): CommentRow[] {
  const query = workspaceId
    ? "SELECT * FROM comments WHERE issue_id = ?1 AND workspace_id = ?2 ORDER BY created_at, id"
    : "SELECT * FROM comments WHERE issue_id = ?1 ORDER BY created_at, id";
  return (
    workspaceId ? db.query(query).all(issueId, workspaceId) : db.query(query).all(issueId)
  ) as CommentRow[];
}

export function getComment(db: Database, id: string, workspaceId?: string): CommentRow | null {
  const query = workspaceId
    ? "SELECT * FROM comments WHERE id = ?1 AND workspace_id = ?2"
    : "SELECT * FROM comments WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as CommentRow | null;
}

export function createComment(
  db: Database,
  actorId: string,
  input: { issueId: string; body: string; createdAt?: string | null; authorId?: string | null },
  workspaceId?: string,
): CommentRow {
  const issue = getIssueByRef(db, input.issueId, workspaceId);
  if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${input.issueId}`);
  const body = input.body.trim();
  if (!body) throw apiError("VALIDATION_FAILED", "Comment body cannot be empty");

  if (input.createdAt != null) parseDateTime(input.createdAt, "createdAt");
  const author = input.authorId ?? actorId;
  const authorRow = workspaceId
    ? db
        .query(
          `SELECT actors.id FROM actors
           JOIN workspace_memberships
             ON workspace_memberships.actor_id = actors.id
            AND workspace_memberships.workspace_id = ?2
           WHERE actors.id = ?1`,
        )
        .get(author, workspaceId)
    : db.query("SELECT id FROM actors WHERE id = ?1").get(author);
  if (!authorRow) throw apiError("NOT_FOUND", "Comment author not found");
  const timestamp = input.createdAt ?? now();

  const id = newId();
  db.transaction(() => {
    db.query(
      `INSERT INTO comments (id, issue_id, actor_id, body, created_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).run(id, issue.id, author, body, timestamp, workspaceId ?? null);
    // Los comentarios forman parte de la actividad observable del issue y deben
    // mover el cursor de updatedAt para la sincronización incremental.
    if (workspaceId) {
      db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2 AND workspace_id = ?3").run(
        now(),
        issue.id,
        workspaceId,
      );
    } else {
      db.query("UPDATE issues SET updated_at = ?1 WHERE id = ?2").run(now(), issue.id);
    }
    // El body va en el evento para que el log pueda reconstruir el comentario.
    recordActivity(
      db,
      issue.id,
      author,
      "commented",
      { commentId: id, body },
      input.createdAt ?? undefined,
      workspaceId,
    );
  })();
  const comment = getComment(db, id, workspaceId);
  if (!comment) throw apiError("NOT_FOUND", `Comment not found: ${id}`);
  return comment;
}
