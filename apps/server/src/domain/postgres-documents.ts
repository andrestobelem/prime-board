// Documents Markdown sobre el backend PostgreSQL (PRB-545).
import type { Persistence, PersistenceTransaction, SqlValue } from "../db/persistence.ts";
import { newId, now } from "../db/util.ts";
import { apiError } from "../graphql/errors.ts";
import type { DocumentTargetInput } from "./documents.ts";

export interface PostgresDocumentRow {
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
  search_vector?: string;
}

export function mapPostgresDocument(row: PostgresDocumentRow) {
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

function targetValues(input: DocumentTargetInput): Record<string, string | null> {
  const values = {
    issue_id: input.issueId?.trim() || null,
    project_id: input.projectId?.trim() || null,
    team_id: input.teamId?.trim() || null,
    initiative_id: input.initiativeId?.trim() || null,
    cycle_id: input.cycleId?.trim() || null,
  };
  const selected = Object.values(values).filter((value) => value !== null);
  if (selected.length > 1) {
    throw apiError("VALIDATION_FAILED", "A document can be linked to only one resource");
  }
  return values;
}

export async function getPostgresDocument(
  persistence: Persistence | PersistenceTransaction,
  id: string,
  workspaceId: string,
): Promise<PostgresDocumentRow | null> {
  return persistence.one<PostgresDocumentRow>(
    "SELECT * FROM documents WHERE id = $1 AND workspace_id = $2",
    [id, workspaceId],
  );
}

export async function listPostgresDocuments(
  persistence: Persistence,
  workspaceId: string,
  options: DocumentTargetInput & { search?: string | null; includeArchived?: boolean } = {},
): Promise<PostgresDocumentRow[]> {
  const params: SqlValue[] = [workspaceId];
  const where = ["workspace_id = $1"];
  const targets: Array<[string, string | null | undefined]> = [
    ["issue_id", options.issueId],
    ["project_id", options.projectId],
    ["team_id", options.teamId],
    ["initiative_id", options.initiativeId],
    ["cycle_id", options.cycleId],
  ];
  for (const [column, value] of targets) {
    if (value !== undefined && value !== null) {
      params.push(value ?? null);
      where.push(`${column} = $${params.length}`);
    }
  }
  if (!options.includeArchived) where.push("archived_at IS NULL");
  const search = options.search?.trim();
  if (search) {
    params.push(search);
    where.push(`lower(title || ' ' || content) LIKE lower('%' || $${params.length} || '%')`);
  }
  return [
    ...(await persistence.many<PostgresDocumentRow>(
      `SELECT * FROM documents WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC`,
      params,
    )),
  ];
}

export async function createPostgresDocument(
  persistence: Persistence,
  workspaceId: string,
  creatorId: string,
  input: DocumentTargetInput & { title: string; content?: string | null },
): Promise<PostgresDocumentRow> {
  const title = input.title.trim();
  if (!title) throw apiError("VALIDATION_FAILED", "Document title cannot be empty");
  const values = targetValues(input);
  const timestamp = now();
  const row = await persistence.one<PostgresDocumentRow>(
    `INSERT INTO documents
      (id, workspace_id, title, content, creator_id, issue_id, project_id, team_id,
       initiative_id, cycle_id, created_at, updated_at, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, NULL)
     RETURNING *`,
    [
      newId(),
      workspaceId,
      title,
      input.content ?? "",
      creatorId,
      values.issue_id ?? null,
      values.project_id ?? null,
      values.team_id ?? null,
      values.initiative_id ?? null,
      values.cycle_id ?? null,
      timestamp,
    ],
  );
  if (!row) throw new Error("PostgreSQL document insert returned no row");
  return row;
}

export async function updatePostgresDocument(
  persistence: Persistence,
  id: string,
  workspaceId: string,
  input: { title?: string | null; content?: string | null; archived?: boolean | null },
): Promise<PostgresDocumentRow> {
  const existing = await getPostgresDocument(persistence, id, workspaceId);
  if (!existing) throw apiError("NOT_FOUND", "Document not found");
  const sets: string[] = [];
  const params: SqlValue[] = [];
  const push = (column: string, value: SqlValue) => {
    sets.push(`${column} = $${params.length + 1}`);
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
    const row = await persistence.one<PostgresDocumentRow>(
      `UPDATE documents SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND workspace_id = $${params.length} RETURNING *`,
      params,
    );
    if (!row) throw apiError("NOT_FOUND", "Document not found");
    return row;
  }
  return existing;
}

export async function postgresDocumentTeamIds(
  persistence: Persistence | PersistenceTransaction,
  target: Pick<
    PostgresDocumentRow,
    "issue_id" | "project_id" | "team_id" | "initiative_id" | "cycle_id"
  >,
): Promise<string[]> {
  if (target.issue_id) {
    const row = await persistence.one<{ team_id: string }>(
      "SELECT team_id FROM issues WHERE id = $1",
      [target.issue_id],
    );
    return row ? [row.team_id] : [];
  }
  if (target.project_id) {
    const rows = await persistence.many<{ team_id: string }>(
      "SELECT team_id FROM project_teams WHERE project_id = $1 ORDER BY team_id",
      [target.project_id],
    );
    return rows.map((row) => row.team_id);
  }
  if (target.team_id) return [target.team_id];
  if (target.cycle_id) {
    const row = await persistence.one<{ team_id: string }>(
      "SELECT team_id FROM cycles WHERE id = $1",
      [target.cycle_id],
    );
    return row ? [row.team_id] : [];
  }
  if (target.initiative_id) {
    const direct = await persistence.many<{ team_id: string }>(
      "SELECT team_id FROM initiative_teams WHERE initiative_id = $1",
      [target.initiative_id],
    );
    const projects = await persistence.many<{ project_id: string }>(
      "SELECT project_id FROM initiative_projects WHERE initiative_id = $1",
      [target.initiative_id],
    );
    const projectTeams: Array<{ team_id: string }> = [];
    for (const project of projects) {
      projectTeams.push(
        ...(await persistence.many<{ team_id: string }>(
          "SELECT team_id FROM project_teams WHERE project_id = $1",
          [project.project_id],
        )),
      );
    }
    return [
      ...new Set([...direct.map((row) => row.team_id), ...projectTeams.map((row) => row.team_id)]),
    ].sort();
  }
  return [];
}
