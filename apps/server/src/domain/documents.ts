// Documentos Markdown vinculables a recursos de trabajo (PRB-541).
import type { Database } from "bun:sqlite";
import { apiError } from "../graphql/errors.ts";
import { newId, now } from "../db/util.ts";

export const DOCUMENT_TARGET_FIELDS = [
  "issue_id",
  "project_id",
  "team_id",
  "initiative_id",
  "cycle_id",
] as const;
export type DocumentTargetField = (typeof DOCUMENT_TARGET_FIELDS)[number];

export interface DocumentRow {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
  creator_id: string;
  issue_id: string | null;
  project_id: string | null;
  team_id: string | null;
  initiative_id: string | null;
  cycle_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface DocumentTargetInput {
  issueId?: string | null;
  projectId?: string | null;
  teamId?: string | null;
  initiativeId?: string | null;
  cycleId?: string | null;
}

export function mapDocument(row: DocumentRow) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    creatorId: row.creator_id,
    issueId: row.issue_id,
    projectId: row.project_id,
    teamId: row.team_id,
    initiativeId: row.initiative_id,
    cycleId: row.cycle_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    _row: row,
  };
}

function targetFields(input: DocumentTargetInput): Array<[DocumentTargetField, string]> {
  return [
    ["issue_id", input.issueId ?? ""],
    ["project_id", input.projectId ?? ""],
    ["team_id", input.teamId ?? ""],
    ["initiative_id", input.initiativeId ?? ""],
    ["cycle_id", input.cycleId ?? ""],
  ].filter(([, value]) => typeof value === "string" && value.trim().length > 0) as Array<
    [DocumentTargetField, string]
  >;
}

function targetValues(input: DocumentTargetInput): Record<DocumentTargetField, string | null> {
  const targets = targetFields(input);
  if (targets.length > 1) {
    throw apiError("VALIDATION_FAILED", "A document can be linked to only one resource");
  }
  return {
    issue_id: input.issueId ?? null,
    project_id: input.projectId ?? null,
    team_id: input.teamId ?? null,
    initiative_id: input.initiativeId ?? null,
    cycle_id: input.cycleId ?? null,
  };
}

export function getDocument(db: Database, id: string, workspaceId?: string): DocumentRow | null {
  const query = workspaceId
    ? "SELECT * FROM documents WHERE id = ?1 AND workspace_id = ?2"
    : "SELECT * FROM documents WHERE id = ?1";
  return (
    workspaceId ? db.query(query).get(id, workspaceId) : db.query(query).get(id)
  ) as DocumentRow | null;
}

export function listDocuments(
  db: Database,
  workspaceId: string,
  options: {
    issueId?: string | null;
    projectId?: string | null;
    teamId?: string | null;
    initiativeId?: string | null;
    cycleId?: string | null;
    search?: string | null;
    includeArchived?: boolean;
  } = {},
): DocumentRow[] {
  const where = ["workspace_id = ?1"];
  const params: unknown[] = [workspaceId];
  if (!options.includeArchived) where.push("archived_at IS NULL");
  const targets: Array<[string, string | null | undefined]> = [
    ["issue_id", options.issueId],
    ["project_id", options.projectId],
    ["team_id", options.teamId],
    ["initiative_id", options.initiativeId],
    ["cycle_id", options.cycleId],
  ];
  for (const [column, value] of targets) {
    if (value !== undefined && value !== null) {
      params.push(value);
      where.push(`${column} = ?${params.length}`);
    }
  }
  const search = options.search?.trim();
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push("lower(title || ' ' || content) LIKE ?" + params.length);
  }
  return db
    .query(`SELECT * FROM documents WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC`)
    .all(...(params as never[])) as DocumentRow[];
}

export function createDocument(
  db: Database,
  workspaceId: string,
  creatorId: string,
  input: DocumentTargetInput & { title: string; content?: string | null },
): DocumentRow {
  const title = input.title.trim();
  if (!title) throw apiError("VALIDATION_FAILED", "Document title cannot be empty");
  const values = targetValues(input);
  const id = newId();
  const timestamp = now();
  db.query(
    `INSERT INTO documents
      (id, workspace_id, title, content, creator_id, issue_id, project_id, team_id,
       initiative_id, cycle_id, created_at, updated_at, archived_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, NULL)`,
  ).run(
    id,
    workspaceId,
    title,
    input.content ?? "",
    creatorId,
    values.issue_id,
    values.project_id,
    values.team_id,
    values.initiative_id,
    values.cycle_id,
    timestamp,
  );
  return getDocument(db, id, workspaceId)!;
}

export function updateDocument(
  db: Database,
  id: string,
  workspaceId: string,
  input: { title?: string | null; content?: string | null; archived?: boolean | null },
): DocumentRow {
  const existing = getDocument(db, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Document not found");
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${params.length + 1}`);
    params.push(value);
  };
  if (input.title !== undefined && input.title !== null) {
    const title = input.title.trim();
    if (!title) throw apiError("VALIDATION_FAILED", "Document title cannot be empty");
    push("title", title);
  }
  if (input.content !== undefined && input.content !== null) push("content", input.content);
  if (input.archived === true) push("archived_at", now());
  if (input.archived === false) push("archived_at", null);
  if (sets.length) {
    push("updated_at", now());
    params.push(id, workspaceId);
    db.query(
      `UPDATE documents SET ${sets.join(", ")} WHERE id = ?${params.length - 1} AND workspace_id = ?${params.length}`,
    ).run(...(params as never[]));
  }
  return getDocument(db, id, workspaceId)!;
}
