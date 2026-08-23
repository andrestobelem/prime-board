// Resolvers de Documents (PRB-541). El contenido se conserva como Markdown.
import {
  createDocument,
  getDocument,
  listDocuments,
  mapDocument,
  updateDocument,
  type DocumentRow,
  type DocumentTargetInput,
} from "../domain/documents.ts";
import { getCycle, mapCycle } from "../domain/cycles.ts";
import { getInitiative, canViewInitiative, mapInitiative } from "../domain/initiatives.ts";
import { mapActor } from "../domain/actors.ts";
import { mapIssue } from "../domain/issues.ts";
import { mapProject } from "../domain/projects.ts";
import { mapTeam } from "../domain/teams.ts";
import {
  lookupActor,
  lookupIssueById,
  lookupProject,
  lookupTeam,
  requireIssue,
  requireProject,
  requireTeam,
} from "../domain/workspace-guards.ts";
import {
  assertCanManageIssue,
  assertCanManageProject,
  canAccessProject,
  canAccessTeam,
  apiKeyTeamsWithinLimit,
  isWorkspaceAdmin,
} from "../auth/permissions.ts";
import { apiError, requireViewer } from "./errors.ts";
import type { Context } from "./context.ts";
import {
  createPostgresDocument,
  getPostgresDocument,
  listPostgresDocuments,
  mapPostgresDocument,
  postgresDocumentTeamIds,
  updatePostgresDocument,
  type PostgresDocumentRow,
} from "../domain/postgres-documents.ts";
import { getPostgresActor, mapPostgresActor } from "../domain/postgres-actors.ts";
import { getPostgresIssueByRef } from "../domain/postgres-issues.ts";
import {
  canDiscoverPostgresTeam,
  canWritePostgresTeam,
  getPostgresTeam,
  isPostgresTeamMember,
  mapPostgresTeam,
} from "../domain/postgres-teams.ts";
import {
  getPostgresCycle,
  getPostgresInitiative,
  getPostgresProject,
  listPostgresInitiativeTeamIds,
} from "../domain/postgres-planning.ts";

const TARGET_KEYS = ["issueId", "projectId", "teamId", "initiativeId", "cycleId"] as const;

function targetInput(args: Record<string, unknown>): DocumentTargetInput {
  const values = Object.fromEntries(
    TARGET_KEYS.map((key) => {
      const value = args[key];
      return [key, typeof value === "string" && value.trim() ? value : null];
    }),
  ) as DocumentTargetInput;
  const selected = TARGET_KEYS.filter((key) => values[key] !== null && values[key] !== undefined);
  if (selected.length > 1) {
    throw apiError("VALIDATION_FAILED", "A document can be linked to only one resource");
  }
  return values;
}

async function normalizePostgresTargetInput(
  context: Context,
  input: DocumentTargetInput,
): Promise<DocumentTargetInput> {
  if (!context.persistence || !input.issueId) return input;
  const issue = await getPostgresIssueByRef(context.persistence, input.issueId);
  return issue ? { ...input, issueId: issue.id } : input;
}

async function postgresInitiativeVisible(context: Context, initiativeId: string): Promise<boolean> {
  if (!context.persistence) return false;
  const teams = await listPostgresInitiativeTeamIds(context.persistence, initiativeId);
  if (!teams.length) return !context.auth?.teamIds;
  if (!apiKeyTeamsWithinLimit(context.auth, teams)) return false;
  const viewer = requireViewer(context);
  if (isWorkspaceAdmin(viewer)) return true;
  for (const teamId of teams) {
    if (!(await isPostgresTeamMember(context.persistence, teamId, viewer.id))) return false;
  }
  return true;
}

async function assertPostgresInitiativeAccess(
  context: Context,
  initiativeId: string,
): Promise<void> {
  if (!context.persistence) return;
  const initiative = await getPostgresInitiative(context.persistence, initiativeId);
  if (!initiative) throw apiError("NOT_FOUND", "Initiative not found");
  const teams = await listPostgresInitiativeTeamIds(context.persistence, initiativeId);
  if (!teams.length) {
    if (context.auth?.teamIds) {
      throw apiError("UNAUTHORIZED", "This operation requires an unrestricted API key");
    }
    return;
  }
  if (!apiKeyTeamsWithinLimit(context.auth, teams)) {
    throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
  }
  const viewer = requireViewer(context);
  if (isWorkspaceAdmin(viewer)) return;
  for (const teamId of teams) {
    if (!(await isPostgresTeamMember(context.persistence, teamId, viewer.id))) {
      throw apiError("NOT_FOUND", "Initiative not found");
    }
  }
}

async function postgresDocumentVisible(
  context: Context,
  row: PostgresDocumentRow,
): Promise<boolean> {
  if (!context.persistence) return false;
  if (row.initiative_id) return postgresInitiativeVisible(context, row.initiative_id);
  const teams = await postgresDocumentTeamIds(context.persistence, row);
  if (!teams.length) {
    if (row.issue_id || row.project_id || row.team_id || row.cycle_id) return false;
    return !context.auth?.teamIds;
  }
  if (!apiKeyTeamsWithinLimit(context.auth, teams)) return false;
  const viewer = requireViewer(context);
  for (const teamId of teams) {
    const team = await getPostgresTeam(context.persistence, { id: teamId });
    if (!team || !(await canDiscoverPostgresTeam(context.persistence, viewer, team))) return false;
  }
  return true;
}

async function assertPostgresTeamWrite(context: Context, teamId: string): Promise<void> {
  if (!context.persistence) return;
  const viewer = requireViewer(context);
  const team = await getPostgresTeam(context.persistence, { id: teamId });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (!(await canDiscoverPostgresTeam(context.persistence, viewer, team))) {
    throw apiError("NOT_FOUND", "Team resource not found");
  }
  if (team.archived_at) throw apiError("VALIDATION_FAILED", "Team is archived");
  if (!apiKeyTeamsWithinLimit(context.auth, [teamId])) {
    throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
  }
  if (!(await canWritePostgresTeam(context.persistence, viewer, teamId))) {
    throw apiError("UNAUTHORIZED", "Team access policy does not allow this operation");
  }
}

async function assertPostgresTargetWriteAccess(
  context: Context,
  input: DocumentTargetInput,
): Promise<DocumentTargetInput> {
  if (!context.persistence) return input;
  if (input.issueId) {
    const issue = await getPostgresIssueByRef(context.persistence, input.issueId);
    if (!issue) throw apiError("NOT_FOUND", `Issue not found: ${input.issueId}`);
    await assertPostgresTeamWrite(context, issue.team_id);
    return { ...input, issueId: issue.id };
  }
  if (input.teamId) {
    await assertPostgresTeamWrite(context, input.teamId);
    return input;
  }
  if (input.projectId) {
    const project = await context.persistence.one<{ id: string }>(
      "SELECT id FROM projects WHERE id = $1",
      [input.projectId],
    );
    if (!project) throw apiError("NOT_FOUND", "Project not found");
    const teams = await postgresDocumentTeamIds(context.persistence, {
      issue_id: null,
      project_id: project.id,
      team_id: null,
      initiative_id: null,
      cycle_id: null,
    });
    if (!teams.length) throw apiError("UNAUTHORIZED", "Project has no accessible Team");
    for (const teamId of teams) await assertPostgresTeamWrite(context, teamId);
    return { ...input, projectId: project.id };
  }
  if (input.initiativeId) {
    await assertPostgresInitiativeAccess(context, input.initiativeId);
    return input;
  }
  if (input.cycleId) {
    const cycle = await context.persistence.one<{ id: string; team_id: string }>(
      "SELECT id, team_id FROM cycles WHERE id = $1",
      [input.cycleId],
    );
    if (!cycle) throw apiError("NOT_FOUND", "Cycle not found");
    await assertPostgresTeamWrite(context, cycle.team_id);
    return { ...input, cycleId: cycle.id };
  }
  if (context.auth?.teamIds) {
    throw apiError("UNAUTHORIZED", "This operation requires an unrestricted API key");
  }
  return input;
}

function postgresDocumentTarget(row: PostgresDocumentRow): DocumentTargetInput {
  return {
    issueId: row.issue_id,
    projectId: row.project_id,
    teamId: row.team_id,
    initiativeId: row.initiative_id,
    cycleId: row.cycle_id,
  };
}

async function assertPostgresDocumentWriteAccess(
  context: Context,
  row: PostgresDocumentRow,
): Promise<void> {
  const target = postgresDocumentTarget(row);
  if (Object.values(target).some((value) => value)) {
    await assertPostgresTargetWriteAccess(context, target);
    return;
  }
  const viewer = requireViewer(context);
  if (!isWorkspaceAdmin(viewer) && viewer.id !== row.creator_id) {
    throw apiError(
      "UNAUTHORIZED",
      "Only the document creator or a Workspace admin can edit a global document",
    );
  }
  if (context.auth?.teamIds) {
    throw apiError("UNAUTHORIZED", "This operation requires an unrestricted API key");
  }
}

function mapPostgresProject(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    leadId: row.lead_id,
    targetDate: row.target_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapPostgresCycle(row: Record<string, unknown>) {
  return {
    id: row.id,
    teamId: row.team_id,
    number: row.number,
    name: row.name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapPostgresInitiative(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    state: row.state,
    targetDate: row.target_date,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function targetTeamIds(context: Context, row: DocumentRow): string[] {
  if (row.issue_id) {
    const issue = lookupIssueById(context, row.issue_id);
    return issue ? [issue.team_id] : [];
  }
  if (row.project_id) {
    return context.db
      .query("SELECT team_id FROM project_teams WHERE project_id = ?1 ORDER BY team_id")
      .all(row.project_id)
      .map((candidate) => (candidate as { team_id: string }).team_id);
  }
  if (row.team_id) return [row.team_id];
  if (row.initiative_id) {
    const direct = context.db
      .query("SELECT team_id FROM initiative_teams WHERE initiative_id = ?1")
      .all(row.initiative_id)
      .map((candidate) => (candidate as { team_id: string }).team_id);
    const projects = context.db
      .query("SELECT project_id FROM initiative_projects WHERE initiative_id = ?1")
      .all(row.initiative_id)
      .flatMap((candidate) =>
        context.db
          .query("SELECT team_id FROM project_teams WHERE project_id = ?1")
          .all((candidate as { project_id: string }).project_id)
          .map((team) => (team as { team_id: string }).team_id),
      );
    return [...new Set([...direct, ...projects])];
  }
  if (row.cycle_id) {
    const cycle = getCycle(context.db, row.cycle_id);
    return cycle ? [cycle.team_id] : [];
  }
  return [];
}

function documentVisible(context: Context, row: DocumentRow): boolean {
  if (row.issue_id) {
    const issue = lookupIssueById(context, row.issue_id);
    return Boolean(
      issue &&
      canAccessTeam(context.db, requireViewer(context), issue.team_id) &&
      apiKeyTeamsWithinLimit(context.auth, [issue.team_id]),
    );
  }
  if (row.project_id) {
    const project = lookupProject(context, row.project_id);
    const teams = project ? targetTeamIds(context, row) : [];
    return Boolean(
      project &&
      canAccessProject(context.db, requireViewer(context), project.id) &&
      apiKeyTeamsWithinLimit(context.auth, teams),
    );
  }
  if (row.team_id) {
    return (
      canAccessTeam(context.db, requireViewer(context), row.team_id) &&
      apiKeyTeamsWithinLimit(context.auth, [row.team_id])
    );
  }
  if (row.initiative_id) {
    return (
      canViewInitiative(
        context.db,
        row.initiative_id,
        requireViewer(context),
        context.workspace.workspaceId,
      ) && apiKeyTeamsWithinLimit(context.auth, targetTeamIds(context, row))
    );
  }
  if (row.cycle_id) {
    const cycle = getCycle(context.db, row.cycle_id);
    return Boolean(
      cycle &&
      canAccessTeam(context.db, requireViewer(context), cycle.team_id) &&
      apiKeyTeamsWithinLimit(context.auth, [cycle.team_id]),
    );
  }
  return !context.auth?.teamIds;
}

function assertTargetWriteAccess(
  context: Context,
  input: DocumentTargetInput,
): DocumentTargetInput {
  const viewer = requireViewer(context);
  if (input.issueId) {
    const issue = requireIssue(context, input.issueId);
    assertCanManageIssue(context.db, viewer, issue.team_id);
    return { ...input, issueId: issue.id };
  }
  if (input.projectId) {
    const project = requireProject(context, input.projectId);
    assertCanManageProject(context.db, viewer, project.id);
    return { ...input, projectId: project.id };
  }
  if (input.teamId) {
    const team = requireTeam(context, { id: input.teamId });
    assertCanManageIssue(context.db, viewer, team.id);
    return { ...input, teamId: team.id };
  }
  if (input.initiativeId) {
    const initiative = getInitiative(context.db, input.initiativeId, context.workspace.workspaceId);
    if (
      !initiative ||
      !canViewInitiative(context.db, initiative.id, viewer, context.workspace.workspaceId)
    ) {
      throw apiError("NOT_FOUND", "Initiative not found");
    }
    for (const teamId of targetTeamIds(context, {
      ...initiative,
      issue_id: null,
      project_id: null,
      team_id: null,
      initiative_id: initiative.id,
      cycle_id: null,
    } as unknown as DocumentRow))
      assertCanManageIssue(context.db, viewer, teamId);
    return { ...input, initiativeId: initiative.id };
  }
  if (input.cycleId) {
    const cycle = getCycle(context.db, input.cycleId);
    if (!cycle) throw apiError("NOT_FOUND", "Cycle not found");
    assertCanManageIssue(context.db, viewer, cycle.team_id);
    return { ...input, cycleId: cycle.id };
  }
  // Global documents are visible to Workspace members. The creator owns the
  // document for later edits; Workspace admins can manage every document.
  return input;
}

function assertDocumentWriteAccess(context: Context, row: DocumentRow): void {
  if (row.issue_id) {
    assertTargetWriteAccess(context, { issueId: row.issue_id });
    return;
  }
  if (row.project_id) {
    assertTargetWriteAccess(context, { projectId: row.project_id });
    return;
  }
  if (row.team_id) {
    assertTargetWriteAccess(context, { teamId: row.team_id });
    return;
  }
  if (row.initiative_id) {
    assertTargetWriteAccess(context, { initiativeId: row.initiative_id });
    return;
  }
  if (row.cycle_id) {
    assertTargetWriteAccess(context, { cycleId: row.cycle_id });
    return;
  }
  const viewer = requireViewer(context);
  if (!isWorkspaceAdmin(viewer) && viewer.id !== row.creator_id) {
    throw apiError(
      "UNAUTHORIZED",
      "Only the document creator or a Workspace admin can edit a global document",
    );
  }
}

export const documentResolvers = {
  Document: {
    creator: async (document: { creatorId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, document.creatorId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, document.creatorId)!);
    },
    issue: async (
      document: { _row: DocumentRow | PostgresDocumentRow },
      _args: unknown,
      context: Context,
    ) => {
      if (!document._row.issue_id) return null;
      if (context.persistence) {
        const issue = await getPostgresIssueByRef(context.persistence, document._row.issue_id);
        return issue &&
          (await postgresDocumentVisible(context, document._row as PostgresDocumentRow))
          ? mapIssue(issue)
          : null;
      }
      const issue = lookupIssueById(context, document._row.issue_id);
      return issue && documentVisible(context, document._row as DocumentRow)
        ? mapIssue(issue)
        : null;
    },
    project: async (
      document: { _row: DocumentRow | PostgresDocumentRow },
      _args: unknown,
      context: Context,
    ) => {
      if (!document._row.project_id) return null;
      if (context.persistence) {
        const project = await getPostgresProject(context.persistence, document._row.project_id);
        return project &&
          (await postgresDocumentVisible(context, document._row as PostgresDocumentRow))
          ? mapPostgresProject(project as unknown as Record<string, unknown>)
          : null;
      }
      const project = lookupProject(context, document._row.project_id);
      return project && documentVisible(context, document._row as DocumentRow)
        ? mapProject(project)
        : null;
    },
    team: async (
      document: { _row: DocumentRow | PostgresDocumentRow },
      _args: unknown,
      context: Context,
    ) => {
      if (!document._row.team_id) return null;
      if (context.persistence) {
        const team = await getPostgresTeam(context.persistence, { id: document._row.team_id });
        return team &&
          (await postgresDocumentVisible(context, document._row as PostgresDocumentRow))
          ? mapPostgresTeam(team)
          : null;
      }
      const team = lookupTeam(context, { id: document._row.team_id });
      return team && documentVisible(context, document._row as DocumentRow) ? mapTeam(team) : null;
    },
    initiative: async (
      document: { _row: DocumentRow | PostgresDocumentRow },
      _args: unknown,
      context: Context,
    ) => {
      if (!document._row.initiative_id) return null;
      if (context.persistence) {
        const initiative = await getPostgresInitiative(
          context.persistence,
          document._row.initiative_id,
        );
        return initiative &&
          (await postgresDocumentVisible(context, document._row as PostgresDocumentRow))
          ? mapPostgresInitiative(initiative as unknown as Record<string, unknown>)
          : null;
      }
      const initiative = getInitiative(
        context.db,
        document._row.initiative_id,
        context.workspace.workspaceId,
      );
      return initiative && documentVisible(context, document._row as DocumentRow)
        ? mapInitiative(initiative)
        : null;
    },
    cycle: async (
      document: { _row: DocumentRow | PostgresDocumentRow },
      _args: unknown,
      context: Context,
    ) => {
      if (!document._row.cycle_id) return null;
      if (context.persistence) {
        const cycle = await getPostgresCycle(context.persistence, document._row.cycle_id);
        return cycle &&
          (await postgresDocumentVisible(context, document._row as PostgresDocumentRow))
          ? mapPostgresCycle(cycle as unknown as Record<string, unknown>)
          : null;
      }
      const cycle = getCycle(context.db, document._row.cycle_id);
      return cycle && documentVisible(context, document._row as DocumentRow)
        ? mapCycle(cycle)
        : null;
    },
    url: (document: { id: string }, _args: unknown, context: Context) =>
      `http://localhost:${context.config.port}/document/${document.id}`,
  },
  Query: {
    documents: async (_parent: unknown, args: Record<string, unknown>, context: Context) => {
      const input = targetInput(args);
      if (context.persistence) {
        const normalized = await normalizePostgresTargetInput(context, input);
        const rows = await listPostgresDocuments(
          context.persistence,
          context.workspace.workspaceId,
          {
            ...normalized,
            search: typeof args.search === "string" ? args.search : null,
            includeArchived: Boolean(args.includeArchived),
          },
        );
        const visible = await Promise.all(
          rows.map(async (row) =>
            (await postgresDocumentVisible(context, row)) ? mapPostgresDocument(row) : null,
          ),
        );
        return visible.filter((row): row is ReturnType<typeof mapPostgresDocument> => row !== null);
      }
      const rows = listDocuments(context.db, context.workspace.workspaceId, {
        ...input,
        search: typeof args.search === "string" ? args.search : null,
        includeArchived: Boolean(args.includeArchived),
      });
      return rows.filter((row) => documentVisible(context, row)).map(mapDocument);
    },
    document: async (_parent: unknown, args: { id: string }, context: Context) => {
      if (context.persistence) {
        const row = await getPostgresDocument(
          context.persistence,
          args.id,
          context.workspace.workspaceId,
        );
        return row && (await postgresDocumentVisible(context, row))
          ? mapPostgresDocument(row)
          : null;
      }
      const row = getDocument(context.db, args.id, context.workspace.workspaceId);
      return row && documentVisible(context, row) ? mapDocument(row) : null;
    },
  },
  Mutation: {
    documentCreate: async (
      _parent: unknown,
      args: { input: DocumentTargetInput & { title: string; content?: string | null } },
      context: Context,
    ) => {
      const input = targetInput(args.input as unknown as Record<string, unknown>);
      if (context.persistence) {
        const normalizedInput = await assertPostgresTargetWriteAccess(context, input);
        const document = await createPostgresDocument(
          context.persistence,
          context.workspace.workspaceId,
          requireViewer(context).id,
          { ...normalizedInput, title: args.input.title, content: args.input.content },
        );
        return { success: true, document: mapPostgresDocument(document) };
      }
      const normalizedInput = assertTargetWriteAccess(context, input);
      const document = createDocument(
        context.db,
        context.workspace.workspaceId,
        requireViewer(context).id,
        { ...normalizedInput, title: args.input.title, content: args.input.content },
      );
      return { success: true, document: mapDocument(document) };
    },
    documentUpdate: async (
      _parent: unknown,
      args: {
        id: string;
        input: { title?: string | null; content?: string | null; archived?: boolean | null };
      },
      context: Context,
    ) => {
      if (context.persistence) {
        const existing = await getPostgresDocument(
          context.persistence,
          args.id,
          context.workspace.workspaceId,
        );
        if (!existing || !(await postgresDocumentVisible(context, existing))) {
          throw apiError("NOT_FOUND", "Document not found");
        }
        await assertPostgresDocumentWriteAccess(context, existing);
        return {
          success: true,
          document: mapPostgresDocument(
            await updatePostgresDocument(
              context.persistence,
              args.id,
              context.workspace.workspaceId,
              args.input,
            ),
          ),
        };
      }
      const existing = getDocument(context.db, args.id, context.workspace.workspaceId);
      if (!existing || !documentVisible(context, existing))
        throw apiError("NOT_FOUND", "Document not found");
      assertDocumentWriteAccess(context, existing);
      return {
        success: true,
        document: mapDocument(
          updateDocument(context.db, args.id, context.workspace.workspaceId, args.input),
        ),
      };
    },
    documentArchive: async (_parent: unknown, args: { id: string }, context: Context) => {
      if (context.persistence) {
        const existing = await getPostgresDocument(
          context.persistence,
          args.id,
          context.workspace.workspaceId,
        );
        if (!existing || !(await postgresDocumentVisible(context, existing)))
          throw apiError("NOT_FOUND", "Document not found");
        await assertPostgresDocumentWriteAccess(context, existing);
        return {
          success: true,
          document: mapPostgresDocument(
            await updatePostgresDocument(
              context.persistence,
              args.id,
              context.workspace.workspaceId,
              { archived: true },
            ),
          ),
        };
      }
      const existing = getDocument(context.db, args.id, context.workspace.workspaceId);
      if (!existing || !documentVisible(context, existing))
        throw apiError("NOT_FOUND", "Document not found");
      assertDocumentWriteAccess(context, existing);
      return {
        success: true,
        document: mapDocument(
          updateDocument(context.db, args.id, context.workspace.workspaceId, { archived: true }),
        ),
      };
    },
    documentUnarchive: async (_parent: unknown, args: { id: string }, context: Context) => {
      if (context.persistence) {
        const existing = await getPostgresDocument(
          context.persistence,
          args.id,
          context.workspace.workspaceId,
        );
        if (!existing || !(await postgresDocumentVisible(context, existing)))
          throw apiError("NOT_FOUND", "Document not found");
        await assertPostgresDocumentWriteAccess(context, existing);
        return {
          success: true,
          document: mapPostgresDocument(
            await updatePostgresDocument(
              context.persistence,
              args.id,
              context.workspace.workspaceId,
              { archived: false },
            ),
          ),
        };
      }
      const existing = getDocument(context.db, args.id, context.workspace.workspaceId);
      if (!existing || !documentVisible(context, existing))
        throw apiError("NOT_FOUND", "Document not found");
      assertDocumentWriteAccess(context, existing);
      return {
        success: true,
        document: mapDocument(
          updateDocument(context.db, args.id, context.workspace.workspaceId, { archived: false }),
        ),
      };
    },
  },
};
