// Resolvers raíz del esquema. Se ensamblan por dominio a medida que crece la API.
import { GraphQLScalarType, Kind } from "graphql";
import {
  createActor,
  updateActor,
  createApiKey,
  rotateApiKey,
  deleteApiKey,
  listApiKeys,
  getApiKey,
  mapActor,
  mapApiKey,
  apiKeyMetadata,
  listApiKeyScopes,
  listApiKeyTeamIds,
  createActorInvitation,
  listActorInvitations,
  mapActorInvitation,
  revokeActorInvitation,
  acceptActorInvitation,
  suspendActor,
  reactivateActor,
  leaveActor,
  revokeActor,
} from "../domain/actors.ts";
import {
  createPostgresActor,
  getPostgresActor,
  getPostgresWorkspace,
  listPostgresActors,
  listPostgresApiKeys,
  leavePostgresActor,
  mapPostgresActor,
  mapPostgresApiKey,
  reactivatePostgresActor,
  revokePostgresActor,
  suspendPostgresActor,
  updatePostgresActor,
  updatePostgresWorkspace,
} from "../domain/postgres-actors.ts";
import {
  acceptPostgresActorInvitation,
  createPostgresActorInvitation,
  createPostgresApiKey,
  deletePostgresApiKey,
  getPostgresApiKey,
  listPostgresActorInvitations,
  postgresApiKeyMetadata,
  revokePostgresActorInvitation,
  rotatePostgresApiKey,
} from "../domain/postgres-credentials.ts";
import {
  archivePostgresTeam,
  assertPostgresTeamActive,
  canDiscoverPostgresTeam,
  createPostgresTeam,
  createPostgresTeamMembership,
  createPostgresWorkflowState,
  deletePostgresTeam,
  deletePostgresTeamMembership,
  deletePostgresWorkflowState,
  getPostgresDefaultState,
  getPostgresTeam,
  getPostgresTeamMembership,
  getPostgresWorkflowState,
  isPostgresTeamMember,
  isPostgresTeamOwner,
  listPostgresTeamMemberships,
  listPostgresTeamStates,
  listPostgresTeams,
  mapPostgresTeam,
  mapPostgresTeamMembership,
  mapPostgresWorkflowState,
  updatePostgresTeam,
  updatePostgresWorkflowState,
} from "../domain/postgres-teams.ts";
import {
  archiveTeam,
  assertTeamActive,
  createTeam,
  deleteTeam,
  createWorkflowState,
  getDefaultState,
  getWorkflowState,
  listTeamStates,
  mapTeam,
  mapWorkflowState,
  deleteWorkflowState,
  updateTeam,
  updateWorkflowState,
  type TeamRow,
  type TeamUpdateInput,
} from "../domain/teams.ts";
import type { Context } from "./context.ts";
import {
  assertActiveWorkspace,
  listActorsInWorkspace,
  listWebhooksInWorkspace,
  lookupActor,
  lookupIssue,
  lookupIssueById,
  lookupProject,
  lookupTeam,
  requireActor,
  requireIssue,
  requireProject,
  requireTeam,
  requireWebhook,
  scopeWorkspaceRow,
  scopeWorkspaceRows,
} from "../domain/workspace-guards.ts";
import { apiError, requireViewer } from "./errors.ts";
import {
  assertCanManageActor,
  assertCanManageApiKey,
  assertApiKeyScope,
  apiKeyTeamsWithinLimit,
  assertChildApiKey,
  assertUnrestrictedApiKey,
  assertCanManageIssue,
  assertCanAssignToTeam,
  assertCanManageTeam,
  canAccessProject,
  canAccessTeam,
  canDiscoverTeam,
  canWriteTeam,
  assertCanAccessTeam,
  assertWorkspaceAdmin,
  isWorkspaceAdmin,
} from "../auth/permissions.ts";
import { withRepoSyncDispatch } from "./repo-sync-dispatch.ts";
import { withApiKeyScopes } from "../auth/scope-dispatch.ts";
import { parseDateTime } from "../domain/datetime.ts";
import { newId } from "../db/util.ts";
import { issueEventData, issueResolvers } from "./issue-resolvers.ts";
import { projectResolvers } from "./project-resolvers.ts";
import {
  createLabel,
  deleteLabel,
  getLabel,
  listLabels,
  mapLabel,
  updateLabel,
} from "../domain/labels.ts";
import { createWebhook, deleteWebhook, mapWebhook } from "../domain/webhooks.ts";
import { listProjectTeamIds, listProjects, mapProject } from "../domain/projects.ts";
import {
  canAccessSavedView,
  createSavedView,
  deleteSavedView,
  duplicateSavedView,
  getSavedView,
  listSavedViews,
  mapSavedView,
  updateSavedView,
} from "../domain/saved-views.ts";
import {
  archiveInboxItem,
  countUnreadInboxActivity,
  listInboxActivity,
  listInboxActivityPage,
  markInboxRead,
} from "../domain/inbox.ts";
import {
  createFavorite,
  deleteFavorite,
  listFavorites,
  mapFavorite,
  reorderFavorite,
} from "../domain/favorites.ts";
import { mapActivity } from "../domain/activity.ts";
import { mapIssue } from "../domain/issues.ts";
import {
  carryOverCycle,
  createCycle,
  cycleProgress,
  deleteCycle,
  getCycle,
  listCycles,
  mapCycle,
  updateCycle,
} from "../domain/cycles.ts";
import {
  createReview,
  deleteReview,
  getReview,
  listReviews,
  mapReview,
  updateReview,
} from "../domain/reviews.ts";
import {
  canViewInitiative,
  createInitiative,
  deleteInitiative,
  getInitiative,
  initiativeProgress,
  listInitiativeProjectIds,
  listInitiativeTeamIds,
  listInitiatives,
  mapInitiative,
  updateInitiative,
} from "../domain/initiatives.ts";
import {
  createTeamMembership,
  deleteTeamMembership,
  isTeamMember,
  listTeamMemberships,
  mapTeamMembership,
} from "../domain/team-memberships.ts";
import {
  getWorkspace,
  listWorkspaceAccess,
  mapWorkspace,
  updateWorkspace,
} from "../domain/workspaces.ts";
import { seedWorkspace } from "../db/seed.ts";
import {
  createPostgresLabel,
  deletePostgresLabel,
  getPostgresLabel,
  listPostgresLabels,
  mapPostgresLabel,
  updatePostgresLabel,
} from "../domain/postgres-labels.ts";

// Scalars passthrough: los timestamps viajan como strings ISO-8601 UTC.
const DateTime = new GraphQLScalarType({
  name: "DateTime",
  serialize: (value) => value,
  parseValue: (value) => {
    parseDateTime(value, "DateTime");
    return value;
  },
  parseLiteral: (ast) => {
    if (ast.kind !== Kind.STRING) {
      throw apiError("VALIDATION_FAILED", "DateTime must be a valid ISO-8601 date");
    }
    parseDateTime(ast.value, "DateTime");
    return ast.value;
  },
});

const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  serialize: (value) => value,
  parseValue: (value) => value,
});

function assertWorkspaceAdminInContext(
  context: Context,
  viewer: ReturnType<typeof requireViewer>,
): void {
  if (context.auth?.workspaceRole !== "admin") {
    throw apiError("UNAUTHORIZED", "Workspace admin permission is required");
  }
  if (context.persistence) return;
  const access = listWorkspaceAccess(context.db, viewer.id, context.auth?.keyId ?? "local").find(
    (workspace) => workspace.id === context.workspace.workspaceId,
  );
  if (!access || access.status !== "active" || access.role !== "admin") {
    throw apiError("UNAUTHORIZED", "Workspace admin permission is required");
  }
}

function emitBulkIssueUpdates(
  context: Context,
  viewer: ReturnType<typeof requireViewer>,
  issueIds: string[],
  changes: Record<string, { from: unknown; to: unknown }>,
): void {
  for (const issueId of issueIds) {
    const issue = lookupIssueById(context, issueId);
    if (issue) context.events.emit("issue.updated", viewer, issueEventData(issue), changes);
  }
}

export const resolvers = {
  DateTime,
  JSON: JSONScalar,
  ActorType: { HUMAN: "human", AGENT: "agent" },
  ActorWorkspaceRole: { ADMIN: "admin", MEMBER: "member" },
  ActorStatus: { ACTIVE: "active", SUSPENDED: "suspended", LEFT: "left" },
  TeamVisibility: { PUBLIC: "public", PRIVATE: "private" },
  TeamAccessPolicy: {
    WORKSPACE_MEMBERS: "workspace_members",
    TEAM_MEMBERS: "team_members",
  },
  ApiKeyScope: { READ: "read", WRITE: "write", ADMIN: "admin" },
  ActorInvitationStatus: {
    PENDING: "pending",
    ACCEPTED: "accepted",
    REVOKED: "revoked",
    EXPIRED: "expired",
  },
  StateType: {
    TRIAGE: "triage",
    BACKLOG: "backlog",
    UNSTARTED: "unstarted",
    STARTED: "started",
    COMPLETED: "completed",
    CANCELED: "canceled",
  },
  IssueRelationType: {
    BLOCKS: "blocks",
    BLOCKED_BY: "blocked_by",
    RELATED: "related",
    DUPLICATE_OF: "duplicate_of",
    DUPLICATED_BY: "duplicated_by",
  },
  ProjectState: {
    BACKLOG: "backlog",
    PLANNED: "planned",
    STARTED: "started",
    PAUSED: "paused",
    COMPLETED: "completed",
    CANCELED: "canceled",
  },
  SavedViewScope: {
    PERSONAL: "personal",
    TEAM: "team",
    WORKSPACE: "workspace",
  },
  CycleState: {
    UPCOMING: "upcoming",
    ACTIVE: "active",
    COMPLETED: "completed",
  },
  ReviewStatus: {
    REQUESTED: "requested",
    IN_PROGRESS: "in_progress",
    APPROVED: "approved",
    REJECTED: "rejected",
  },
  InitiativeState: {
    PLANNED: "planned",
    ACTIVE: "active",
    COMPLETED: "completed",
    CANCELED: "canceled",
  },
  TeamMembershipRole: {
    OWNER: "owner",
    MEMBER: "member",
  },

  Team: {
    states: async (team: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const row = await getPostgresTeam(context.persistence, { id: team.id });
        return row && (await canDiscoverPostgresTeam(context.persistence, viewer, row))
          ? (await listPostgresTeamStates(context.persistence, team.id)).map(
              mapPostgresWorkflowState,
            )
          : [];
      }
      return canAccessTeam(context.db, viewer, team.id)
        ? listTeamStates(context.db, team.id).map(mapWorkflowState)
        : [];
    },
    defaultState: async (
      team: { _row: TeamRow; id?: string },
      _args: unknown,
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const row = await getPostgresTeam(context.persistence, { id: team._row?.id ?? team.id });
        return row && (await canDiscoverPostgresTeam(context.persistence, viewer, row))
          ? mapPostgresWorkflowState(await getPostgresDefaultState(context.persistence, row))
          : null;
      }
      return canAccessTeam(context.db, viewer, team._row.id)
        ? mapWorkflowState(getDefaultState(context.db, team._row))
        : null;
    },
    labels: async (team: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const row = await getPostgresTeam(context.persistence, { id: team.id });
        return row && (await canDiscoverPostgresTeam(context.persistence, viewer, row))
          ? (await listPostgresLabels(context.persistence, team.id)).map(mapPostgresLabel)
          : [];
      }
      return canAccessTeam(context.db, viewer, team.id)
        ? listLabels(context.db, team.id).map(mapLabel)
        : [];
    },
    projects: (team: { id: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        throw apiError(
          "VALIDATION_FAILED",
          "Team projects are not yet available with PostgreSQL persistence",
        );
      }
      return listProjects(context.db, null, team.id)
        .filter((project) => canAccessProject(context.db, requireViewer(context), project.id))
        .filter((project) =>
          apiKeyTeamsWithinLimit(context.auth, listProjectTeamIds(context.db, project.id)),
        )
        .map(mapProject);
    },
    cycles: (team: { id: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        throw apiError(
          "VALIDATION_FAILED",
          "Team cycles are not yet available with PostgreSQL persistence",
        );
      }
      return canAccessTeam(context.db, requireViewer(context), team.id)
        ? listCycles(context.db, team.id).map(mapCycle)
        : [];
    },
    memberships: async (team: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const row = await getPostgresTeam(context.persistence, { id: team.id });
        if (!row || !(await canDiscoverPostgresTeam(context.persistence, viewer, row))) return [];
        if (
          !isWorkspaceAdmin(viewer) &&
          !(await isPostgresTeamMember(context.persistence, team.id, viewer.id))
        ) {
          return [];
        }
        return (await listPostgresTeamMemberships(context.persistence, team.id)).map(
          mapPostgresTeamMembership,
        );
      }
      return isWorkspaceAdmin(viewer) || isTeamMember(context.db, team.id, viewer.id)
        ? listTeamMemberships(context.db, team.id).map(mapTeamMembership)
        : [];
    },
  },

  TeamMembership: {
    team: async (membership: { teamId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const team = await getPostgresTeam(context.persistence, { id: membership.teamId });
        return team ? mapPostgresTeam(team) : null;
      }
      return mapTeam(lookupTeam(context, { id: membership.teamId })!);
    },
    actor: async (membership: { actorId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, membership.actorId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, membership.actorId)!);
    },
  },

  Issue: issueResolvers.Issue,
  IssueRelation: issueResolvers.IssueRelation,
  Project: projectResolvers.Project,
  ProjectStatusUpdate: projectResolvers.ProjectStatusUpdate,
  ProjectUpdateHealth: projectResolvers.ProjectUpdateHealth,
  Milestone: projectResolvers.Milestone,
  Comment: issueResolvers.Comment,
  Activity: issueResolvers.Activity,

  Favorite: {
    project: (favorite: { projectId: string | null }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (!favorite.projectId) return null;
      const project = lookupProject(context, favorite.projectId);
      return project && canAccessProject(context.db, viewer, project.id)
        ? mapProject(project)
        : null;
    },
    savedView: (favorite: { savedViewId: string | null }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (!favorite.savedViewId) return null;
      const view = getSavedView(context.db, favorite.savedViewId);
      return view && canAccessSavedView(context.db, view, viewer.id) ? mapSavedView(view) : null;
    },
  },

  SavedView: {
    team: (view: { teamId: string | null }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (!view.teamId) return null;
      const row = lookupTeam(context, { id: view.teamId });
      return row && canAccessTeam(context.db, viewer, row.id) ? mapTeam(row) : null;
    },
    owner: (view: { ownerId: string }, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, view.ownerId)!),
  },

  InboxItem: {
    actor: (item: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, item.actorId)!),
    issue: (item: { issueId: string }, _args: unknown, context: Context) =>
      mapIssue(lookupIssueById(context, item.issueId)!),
  },

  Cycle: {
    team: (cycle: { teamId: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      const team = lookupTeam(context, { id: cycle.teamId });
      return team && canAccessTeam(context.db, viewer, team.id) ? mapTeam(team) : null;
    },
    progress: (cycle: { id: string }, _args: unknown, context: Context) =>
      cycleProgress(context.db, cycle.id).progress,
    completedIssues: (cycle: { id: string }, _args: unknown, context: Context) =>
      cycleProgress(context.db, cycle.id).completedIssues,
    totalIssues: (cycle: { id: string }, _args: unknown, context: Context) =>
      cycleProgress(context.db, cycle.id).totalIssues,
  },

  Review: {
    issue: (review: { issueId: string }, _args: unknown, context: Context) =>
      mapIssue(lookupIssueById(context, review.issueId)!),
    requester: (review: { requesterId: string }, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, review.requesterId)!),
    reviewer: (review: { reviewerId: string }, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, review.reviewerId)!),
  },

  Initiative: {
    projects: (initiative: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      return listInitiativeProjectIds(context.db, initiative.id, context.workspace.workspaceId)
        .map((projectId) => lookupProject(context, projectId))
        .filter((row) => row && canAccessProject(context.db, viewer, row.id))
        .map((row) => mapProject(row!));
    },
    teams: (initiative: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      return listInitiativeTeamIds(context.db, initiative.id, context.workspace.workspaceId)
        .map((teamId) => lookupTeam(context, { id: teamId }))
        .filter((row) => row && canAccessTeam(context.db, viewer, row.id))
        .map((row) => mapTeam(row!));
    },
    owner: (initiative: { ownerId: string | null }, _args: unknown, context: Context) =>
      initiative.ownerId ? mapActor(lookupActor(context, initiative.ownerId)!) : null,
    progress: (initiative: { id: string }, _args: unknown, context: Context) =>
      initiativeProgress(context.db, initiative.id, context.workspace.workspaceId).progress,
    completedIssues: (initiative: { id: string }, _args: unknown, context: Context) =>
      initiativeProgress(context.db, initiative.id, context.workspace.workspaceId).completedIssues,
    totalIssues: (initiative: { id: string }, _args: unknown, context: Context) =>
      initiativeProgress(context.db, initiative.id, context.workspace.workspaceId).totalIssues,
  },

  ApiKey: {
    actor: async (apiKey: { actorId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, apiKey.actorId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, apiKey.actorId)!);
    },
  },

  Actor: {
    apiKeys: async (actor: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (!isWorkspaceAdmin(viewer) && viewer.id !== actor.id) return [];
      if (context.persistence) {
        return (await listPostgresApiKeys(context.persistence, actor.id)).map(mapPostgresApiKey);
      }
      return listApiKeys(context.db, actor.id).map((row) =>
        mapApiKey(row, context.db, context.workspace.workspaceId),
      );
    },
    workspaces: async (actor: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (viewer.id !== actor.id && !isWorkspaceAdmin(viewer)) return [];
      if (context.persistence) {
        const row = await getPostgresWorkspace(context.persistence, context.workspace.workspaceId);
        return row
          ? [
              {
                id: row.id,
                name: row.name,
                urlKey: row.url_key,
                createdAt: row.created_at,
                role: viewer.workspace_role,
                status: viewer.status,
                isDefault: true,
              },
            ]
          : [];
      }
      return listWorkspaceAccess(context.db, actor.id, context.auth?.keyId ?? "local").map(
        mapWorkspace,
      );
    },
  },

  ActorInvitation: {
    invitedBy: async (invitation: { invitedById: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, invitation.invitedById);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, invitation.invitedById)!);
    },
    actor: async (invitation: { actorId: string | null }, _args: unknown, context: Context) => {
      if (!invitation.actorId) return null;
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, invitation.actorId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, invitation.actorId)!);
    },
  },

  Query: withApiKeyScopes(
    {
      ...issueResolvers.Query,
      ...projectResolvers.Query,
      viewer: (_parent: unknown, _args: unknown, context: Context) =>
        mapActor(requireViewer(context)),
      workspaces: async (_parent: unknown, _args: unknown, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const row = await getPostgresWorkspace(
            context.persistence,
            context.workspace.workspaceId,
          );
          return row
            ? [
                {
                  id: row.id,
                  name: row.name,
                  urlKey: row.url_key,
                  createdAt: row.created_at,
                  role: viewer.workspace_role,
                  status: viewer.status,
                  isDefault: true,
                },
              ]
            : [];
        }
        return listWorkspaceAccess(context.db, viewer.id, context.auth?.keyId ?? "local").map(
          mapWorkspace,
        );
      },
      workspace: async (_parent: unknown, _args: unknown, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const row = await getPostgresWorkspace(
            context.persistence,
            context.workspace.workspaceId,
          );
          if (!row) throw apiError("NOT_FOUND", "Workspace is not initialized");
          return {
            id: row.id,
            name: row.name,
            urlKey: row.url_key,
            createdAt: row.created_at,
            role: viewer.workspace_role,
            status: viewer.status,
            isDefault: true,
          };
        }
        const row = getWorkspace(context.db, context.workspace.workspaceId);
        if (!row) throw apiError("NOT_FOUND", "Workspace is not initialized");
        const access = listWorkspaceAccess(
          context.db,
          viewer.id,
          context.auth?.keyId ?? "local",
        ).find((item) => item.id === row.id);
        if (!access) throw apiError("NOT_FOUND", "Workspace not found");
        return mapWorkspace(access);
      },
      teams: async (
        _parent: unknown,
        args: { includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const rows = await listPostgresTeams(context.persistence, Boolean(args.includeArchived));
          return (
            await Promise.all(
              rows.map(async (team) =>
                (await canDiscoverPostgresTeam(context.persistence!, viewer, team))
                  ? mapPostgresTeam(team)
                  : null,
              ),
            )
          ).filter((team): team is ReturnType<typeof mapPostgresTeam> => team !== null);
        }
        assertActiveWorkspace(context);
        const rows = context.db
          .query(
            `SELECT * FROM teams ${args.includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at`,
          )
          .all() as TeamRow[];
        return scopeWorkspaceRows(context, rows)
          .filter((team) => canDiscoverTeam(context.db, viewer, team.id))
          .map(mapTeam);
      },
      team: async (
        _parent: unknown,
        args: { id?: string; key?: string; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const row = await getPostgresTeam(context.persistence, args);
          if (row?.archived_at && !args.includeArchived) return null;
          return row &&
            (await canDiscoverPostgresTeam(context.persistence, viewer, row)) &&
            apiKeyTeamsWithinLimit(context.auth, [row.id])
            ? mapPostgresTeam(row)
            : null;
        }
        const row = lookupTeam(context, args);
        if (row?.archived_at && !args.includeArchived) return null;
        return row && canDiscoverTeam(context.db, viewer, row.id) ? mapTeam(row) : null;
      },
      actors: async (_parent: unknown, args: { type?: string }, context: Context) => {
        requireViewer(context);
        if (context.persistence) {
          return (await listPostgresActors(context.persistence, args.type)).map(mapPostgresActor);
        }
        return listActorsInWorkspace(context, args.type).map(mapActor);
      },
      actorInvitations: async (
        _parent: unknown,
        args: { includeRevoked?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        assertWorkspaceAdmin(viewer);
        if (context.persistence) {
          return (
            await listPostgresActorInvitations(context.persistence, Boolean(args.includeRevoked))
          ).map(mapActorInvitation);
        }
        return listActorInvitations(context.db, Boolean(args.includeRevoked)).map(
          mapActorInvitation,
        );
      },
      teamMemberships: async (_parent: unknown, args: { teamId: string }, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const team = await getPostgresTeam(context.persistence, { id: args.teamId });
          if (!team || team.archived_at) return [];
          if (
            !(await canDiscoverPostgresTeam(context.persistence, viewer, team)) ||
            (!isWorkspaceAdmin(viewer) &&
              !(await isPostgresTeamMember(context.persistence, team.id, viewer.id)))
          ) {
            return [];
          }
          return (await listPostgresTeamMemberships(context.persistence, args.teamId)).map(
            mapPostgresTeamMembership,
          );
        }
        const team = lookupTeam(context, { id: args.teamId });
        if (team?.archived_at) return [];
        if (!team || !(isWorkspaceAdmin(viewer) || isTeamMember(context.db, team.id, viewer.id))) {
          return [];
        }
        return scopeWorkspaceRows(context, listTeamMemberships(context.db, args.teamId)).map(
          mapTeamMembership,
        );
      },
      labels: async (_parent: unknown, args: { team?: string }, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const team = args.team
            ? await getPostgresTeam(context.persistence, { id: args.team })
            : null;
          if (
            args.team &&
            (!team || !(await canDiscoverPostgresTeam(context.persistence, viewer, team)))
          ) {
            return [];
          }
          if (team?.archived_at) {
            return (await listPostgresLabels(context.persistence))
              .filter((label) => label.team_id == null)
              .map(mapPostgresLabel);
          }
          const labels = await listPostgresLabels(context.persistence, team?.id ?? null);
          const visible = [];
          for (const label of labels) {
            if (!label.team_id) {
              visible.push(label);
              continue;
            }
            const labelTeam = await getPostgresTeam(context.persistence, { id: label.team_id });
            if (
              labelTeam &&
              (await canDiscoverPostgresTeam(context.persistence, viewer, labelTeam))
            ) {
              visible.push(label);
            }
          }
          return visible.map(mapPostgresLabel);
        }
        const team = args.team ? lookupTeam(context, { id: args.team }) : null;
        if (args.team && (!team || !canAccessTeam(context.db, viewer, team.id))) return [];
        // Selectors omit inaccessible and archived Team labels while preserving workspace labels.
        return scopeWorkspaceRows(
          context,
          listLabels(context.db, team?.archived_at ? null : args.team),
        )
          .filter(
            (label) => label.team_id == null || canAccessTeam(context.db, viewer, label.team_id),
          )
          .filter((label) => !team?.archived_at || label.team_id == null)
          .map(mapLabel);
      },
      webhooks: (_parent: unknown, _args: unknown, context: Context) => {
        const viewer = requireViewer(context);
        return listWebhooksInWorkspace(context, viewer.id, isWorkspaceAdmin(viewer)).map(
          mapWebhook,
        );
      },
      savedViews: (
        _parent: unknown,
        args: { teamId?: string | null; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (args.teamId) {
          const team = lookupTeam(context, { id: args.teamId });
          if (team?.archived_at && !args.includeArchived) return [];
        }
        return scopeWorkspaceRows(
          context,
          listSavedViews(context.db, viewer.id, args.teamId, Boolean(args.includeArchived)),
        ).map(mapSavedView);
      },
      savedView: (_parent: unknown, args: { id: string }, context: Context) => {
        const viewer = requireViewer(context);
        const row = getSavedView(context.db, args.id);
        if (!row) return null;
        scopeWorkspaceRow(context, row);
        if (!canAccessSavedView(context.db, row, viewer.id)) return null;
        return mapSavedView(row);
      },
      favorites: (_parent: unknown, _args: unknown, context: Context) => {
        const viewer = requireViewer(context);
        return scopeWorkspaceRows(context, listFavorites(context.db, viewer.id)).map(mapFavorite);
      },
      inbox: (
        _parent: unknown,
        args: { first?: number | null; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        return scopeWorkspaceRows(
          context,
          listInboxActivity(context.db, viewer.id, {
            first: args.first ?? 50,
            includeArchived: Boolean(args.includeArchived),
          }),
        ).map((row) => ({
          ...mapActivity(row),
          issueId: row.issue_id,
          isRead: Boolean(row.is_read),
          isArchived: Boolean(row.is_archived),
        }));
      },
      inboxPage: (
        _parent: unknown,
        args: { first?: number | null; after?: string | null; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        const page = listInboxActivityPage(context.db, viewer.id, {
          first: args.first ?? 50,
          after: args.after,
          includeArchived: Boolean(args.includeArchived),
        });
        return {
          nodes: scopeWorkspaceRows(context, page.rows).map((row) => ({
            ...mapActivity(row),
            issueId: row.issue_id,
            isRead: Boolean(row.is_read),
            isArchived: Boolean(row.is_archived),
          })),
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        };
      },
      inboxUnreadCount: (_parent: unknown, _args: unknown, context: Context) => {
        const viewer = requireViewer(context);
        return countUnreadInboxActivity(context.db, viewer.id);
      },
      cycles: (
        _parent: unknown,
        args: { teamId: string; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        const team = lookupTeam(context, { id: args.teamId });
        if (!team || !canAccessTeam(context.db, viewer, team.id)) return [];
        if (team.archived_at && !args.includeArchived) return [];
        return scopeWorkspaceRows(
          context,
          listCycles(context.db, args.teamId, Boolean(args.includeArchived)),
        ).map(mapCycle);
      },
      cycle: (_parent: unknown, args: { id: string }, context: Context) => {
        const viewer = requireViewer(context);
        const row = getCycle(context.db, args.id);
        return row && canAccessTeam(context.db, viewer, row.team_id)
          ? mapCycle(scopeWorkspaceRow(context, row))
          : null;
      },
      reviews: (
        _parent: unknown,
        args: {
          openOnly?: boolean | null;
          first?: number | null;
          teamId?: string | null;
          projectId?: string | null;
          reviewerId?: string | null;
          olderThanDays?: number | null;
        },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (args.teamId) {
          const team = lookupTeam(context, { id: args.teamId });
          if (team?.archived_at) return [];
        }
        const rows = scopeWorkspaceRows(
          context,
          listReviews(context.db, viewer.id, {
            openOnly: Boolean(args.openOnly),
            first: args.first ?? 50,
            teamId: args.teamId,
            projectId: args.projectId,
            reviewerId: args.reviewerId,
            olderThanDays: args.olderThanDays,
          }),
        );
        // La cola se basa en requester/reviewer, pero una key revocada no debe
        // conservar acceso a reviews del team.
        return rows
          .filter((row) => {
            const issue = lookupIssueById(context, row.issue_id);
            return Boolean(issue && canWriteTeam(context.db, viewer, issue.team_id));
          })
          .map(mapReview);
      },
      review: (_parent: unknown, args: { id: string }, context: Context) => {
        const viewer = requireViewer(context);
        const row = getReview(context.db, args.id);
        if (!row) return null;
        scopeWorkspaceRow(context, row);
        const issue = lookupIssueById(context, row.issue_id);
        if (
          !issue ||
          !canWriteTeam(context.db, viewer, issue.team_id) ||
          (!isWorkspaceAdmin(viewer) &&
            row.reviewer_id !== viewer.id &&
            row.requester_id !== viewer.id)
        ) {
          return null;
        }
        return mapReview(row);
      },
      initiatives: (
        _parent: unknown,
        args: { includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        return scopeWorkspaceRows(
          context,
          listInitiatives(
            context.db,
            Boolean(args.includeArchived),
            viewer,
            context.workspace.workspaceId,
          ),
        ).map(mapInitiative);
      },
      initiative: (_parent: unknown, args: { id: string }, context: Context) => {
        const viewer = requireViewer(context);
        const row = getInitiative(context.db, args.id, context.workspace.workspaceId);
        if (!row) return null;
        scopeWorkspaceRow(context, row);
        return canViewInitiative(context.db, row.id, viewer, context.workspace.workspaceId)
          ? mapInitiative(row)
          : null;
      },
    },
    "query",
  ),

  // El resolver map entero pasa por el despacho de sync (AT-191): cualquier
  // mutation nueva que no llame a mano a repo?.sync()/syncIssue() igual queda
  // sincronizada, salvo que esté en SYNC_EXCLUDED_MUTATIONS.
  Mutation: withRepoSyncDispatch(
    withApiKeyScopes(
      {
        ...issueResolvers.Mutation,
        ...projectResolvers.Mutation,
        teamArchive: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            return {
              success: true,
              team: mapPostgresTeam(await archivePostgresTeam(context.persistence, args.id, true)),
            };
          }
          requireTeam(context, { id: args.id });
          return { success: true, team: mapTeam(archiveTeam(context.db, args.id, true)) };
        },
        teamUnarchive: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            return {
              success: true,
              team: mapPostgresTeam(await archivePostgresTeam(context.persistence, args.id, false)),
            };
          }
          requireTeam(context, { id: args.id });
          return { success: true, team: mapTeam(archiveTeam(context.db, args.id, false)) };
        },
        teamDelete: async (
          _parent: unknown,
          args: { id: string; confirmation: string },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            await deletePostgresTeam(context.persistence, args.id, args.confirmation);
            return { success: true };
          }
          requireTeam(context, { id: args.id });
          const teamOwnerIds = (
            context.db
              .query("SELECT actor_id FROM team_memberships WHERE team_id = ?1 AND role = 'owner'")
              .all(args.id) as Array<{ actor_id: string }>
          ).map((row) => row.actor_id);
          const deleted = deleteTeam(context.db, args.id, args.confirmation);
          context.events.emit("team.deleted", viewer, {
            id: deleted.id,
            key: deleted.key,
            name: deleted.name,
            teamId: deleted.id,
            _teamOwnerIds: teamOwnerIds,
          });
          return { success: true };
        },
        workspaceCreate: async (
          _parent: unknown,
          args: { input: { name: string; urlKey: string } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdminInContext(context, viewer);
          assertUnrestrictedApiKey(context);
          if (context.persistence) {
            throw apiError(
              "VALIDATION_FAILED",
              "Workspace creation is not migrated to PostgreSQL yet",
            );
          }
          const urlKey = args.input.urlKey.trim();
          if (!urlKey) throw apiError("VALIDATION_FAILED", "Workspace url key cannot be empty");
          try {
            const created = seedWorkspace(context.db, {
              name: args.input.name,
              urlKey,
              adminActorId: viewer.id,
              apiKeyId: context.auth?.keyId === "local" ? undefined : context.auth?.keyId,
            });
            const row = getWorkspace(context.db, created.workspaceId);
            if (!row) throw apiError("NOT_FOUND", "Workspace is not initialized");
            const access = listWorkspaceAccess(
              context.db,
              viewer.id,
              context.auth?.keyId ?? "local",
            ).find((item) => item.id === row.id);
            if (!access) {
              throw apiError("UNAUTHORIZED", "Workspace access is not granted");
            }
            return { success: true, workspace: mapWorkspace(access) };
          } catch (error) {
            if (error && typeof error === "object" && "extensions" in error) throw error;
            throw apiError(
              "VALIDATION_FAILED",
              error instanceof Error ? error.message : "Workspace could not be created",
            );
          }
        },
        workspaceUpdate: async (
          _parent: unknown,
          args: { input: { name: string } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdminInContext(context, viewer);
          if (context.persistence) {
            const row = await updatePostgresWorkspace(
              context.persistence,
              args.input,
              context.workspace.workspaceId,
            );
            return {
              success: true,
              workspace: {
                id: row.id,
                name: row.name,
                urlKey: row.url_key,
                createdAt: row.created_at,
                role: viewer.workspace_role,
                status: viewer.status,
                isDefault: true,
              },
            };
          }
          const updated = updateWorkspace(context.db, args.input, context.workspace.workspaceId);
          const access = listWorkspaceAccess(
            context.db,
            viewer.id,
            context.auth?.keyId ?? "local",
          ).find((item) => item.id === updated.id);
          if (!access) throw apiError("UNAUTHORIZED", "Workspace access is not granted");
          return { success: true, workspace: mapWorkspace(access) };
        },
        teamCreate: async (
          _parent: unknown,
          args: {
            input: {
              name: string;
              key: string;
              description?: string | null;
              visibility?: "public" | "private" | null;
              accessPolicy?: "workspace_members" | "team_members" | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            const team = mapPostgresTeam(
              await createPostgresTeam(context.persistence, args.input, viewer.id),
            );
            return { success: true, team };
          }
          const team = mapTeam(
            createTeam(context.db, args.input, viewer.id, context.workspace.workspaceId),
          );
          return { success: true, team };
        },
        teamUpdate: async (
          _parent: unknown,
          args: { id: string; input: TeamUpdateInput },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const team = await getPostgresTeam(context.persistence, { id: args.id });
            if (!team) throw apiError("NOT_FOUND", "Team not found");
            if (
              !isWorkspaceAdmin(viewer) &&
              !(await isPostgresTeamOwner(context.persistence, args.id, viewer.id))
            ) {
              throw apiError("UNAUTHORIZED", "Team owner permission is required");
            }
            await assertPostgresTeamActive(context.persistence, args.id);
            return {
              success: true,
              team: mapPostgresTeam(
                await updatePostgresTeam(context.persistence, args.id, args.input),
              ),
            };
          }
          assertCanManageTeam(context.db, viewer, args.id);
          requireTeam(context, { id: args.id });
          const team = mapTeam(updateTeam(context.db, args.id, args.input));
          return { success: true, team };
        },
        teamMembershipCreate: async (
          _parent: unknown,
          args: { input: { teamId: string; actorId: string; role?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const membership = await createPostgresTeamMembership(
              context.persistence,
              viewer.id,
              args.input,
              isWorkspaceAdmin(viewer),
            );
            return { success: true, membership: mapPostgresTeamMembership(membership) };
          }
          requireTeam(context, { id: args.input.teamId });
          requireActor(context, args.input.actorId);
          return {
            success: true,
            membership: mapTeamMembership(
              createTeamMembership(context.db, viewer.id, args.input, isWorkspaceAdmin(viewer)),
            ),
          };
        },
        teamMembershipDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const membership = await getPostgresTeamMembership(context.persistence, args.id);
            if (!membership) throw apiError("NOT_FOUND", "Team membership not found");
            if (!apiKeyTeamsWithinLimit(context.auth, [membership.team_id])) {
              throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
            }
            return {
              success: await deletePostgresTeamMembership(
                context.persistence,
                viewer.id,
                args.id,
                isWorkspaceAdmin(viewer),
              ),
            };
          }
          return {
            success: deleteTeamMembership(context.db, viewer.id, args.id, isWorkspaceAdmin(viewer)),
          };
        },
        actorCreate: async (
          _parent: unknown,
          args: { input: { name: string; type: string; email?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            const actor = mapPostgresActor(
              await createPostgresActor(context.persistence, args.input),
            );
            return { success: true, actor };
          }
          const actor = context.db.transaction(() => {
            const created = createActor(context.db, args.input);
            context.db
              .query(
                `INSERT INTO workspace_memberships
                 (id, workspace_id, actor_id, role, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT (workspace_id, actor_id) DO NOTHING`,
              )
              .run(
                newId(),
                context.workspace.workspaceId,
                created.id,
                created.workspace_role,
                created.status,
                created.created_at,
              );
            return created;
          })();
          return { success: true, actor: mapActor(actor) };
        },
        actorUpdate: async (
          _parent: unknown,
          args: { id: string; input: { name?: string | null; email?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertCanManageActor(viewer, args.id);
          if (context.persistence) {
            if (!(await getPostgresActor(context.persistence, args.id))) {
              throw apiError("NOT_FOUND", "Actor not found");
            }
            const actor = mapPostgresActor(
              await updatePostgresActor(context.persistence, args.id, args.input),
            );
            return { success: true, actor };
          }
          requireActor(context, args.id);
          const actor = mapActor(updateActor(context.db, args.id, args.input));
          return { success: true, actor };
        },
        actorInvite: async (
          _parent: unknown,
          args: {
            input: {
              email?: string | null;
              name?: string | null;
              type?: string | null;
              expiresAt?: string | null;
              metadata?: unknown;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            const result = await createPostgresActorInvitation(
              context.persistence,
              viewer.id,
              args.input,
            );
            return {
              success: true,
              invitation: mapActorInvitation(result.row),
              token: result.token,
            };
          }
          const result = createActorInvitation(context.db, viewer.id, args.input);
          return { success: true, invitation: mapActorInvitation(result.row), token: result.token };
        },
        actorInvitationAccept: async (
          _parent: unknown,
          args: { token: string; input: { name?: string | null; type?: string | null } },
          context: Context,
        ) => {
          if (context.persistence) {
            const result = await acceptPostgresActorInvitation(
              context.persistence,
              args.token,
              args.input,
            );
            return {
              success: true,
              invitation: mapActorInvitation(result.invitation),
              actor: mapPostgresActor(result.actor),
              key: result.key,
            };
          }
          const result = acceptActorInvitation(context.db, args.token, args.input);
          return {
            success: true,
            invitation: mapActorInvitation(result.invitation),
            actor: mapActor(result.actor),
            key: result.key,
          };
        },
        actorInvitationRevoke: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            return {
              success: true,
              invitation: mapActorInvitation(
                await revokePostgresActorInvitation(context.persistence, args.id),
              ),
            };
          }
          return {
            success: true,
            invitation: mapActorInvitation(revokeActorInvitation(context.db, args.id)),
          };
        },
        actorSuspend: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            return {
              success: true,
              actor: mapPostgresActor(
                await suspendPostgresActor(context.persistence, args.id, viewer.id),
              ),
            };
          }
          requireActor(context, args.id);
          return { success: true, actor: mapActor(suspendActor(context.db, args.id, viewer.id)) };
        },
        actorReactivate: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            return {
              success: true,
              actor: mapPostgresActor(await reactivatePostgresActor(context.persistence, args.id)),
            };
          }
          requireActor(context, args.id);
          return { success: true, actor: mapActor(reactivateActor(context.db, args.id)) };
        },
        actorRevoke: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          if (context.persistence) {
            return {
              success: true,
              actor: mapPostgresActor(await revokePostgresActor(context.persistence, args.id)),
            };
          }
          requireActor(context, args.id);
          return { success: true, actor: mapActor(revokeActor(context.db, args.id)) };
        },
        actorLeave: async (_parent: unknown, args: { id?: string | null }, context: Context) => {
          const viewer = requireViewer(context);
          const actorId = args.id ?? viewer.id;
          if (actorId !== viewer.id)
            throw apiError("UNAUTHORIZED", "You can only leave as yourself");
          if (context.persistence) {
            return {
              success: true,
              actor: mapPostgresActor(await leavePostgresActor(context.persistence, actorId)),
            };
          }
          return { success: true, actor: mapActor(leaveActor(context.db, actorId)) };
        },
        apiKeyCreate: async (
          _parent: unknown,
          args: {
            input: {
              actorId: string;
              name: string;
              scopes?: string[] | null;
              teamIds?: string[] | null;
              expiresAt?: string | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertApiKeyScope(context, "write");
          if (context.persistence) {
            const target = await getPostgresActor(context.persistence, args.input.actorId);
            if (!target) throw apiError("NOT_FOUND", "Actor not found");
            assertCanManageActor(viewer, args.input.actorId);
            if (viewer.id !== target.id) {
              assertApiKeyScope(context, "admin");
              assertUnrestrictedApiKey(context);
            }
            const metadata = await postgresApiKeyMetadata(context.persistence, args.input);
            assertChildApiKey(context, target, args.input, metadata);
            const result = await createPostgresApiKey(context.persistence, args.input);
            return { success: true, apiKey: mapPostgresApiKey(result.row), key: result.key };
          }
          const target = requireActor(context, args.input.actorId);
          assertCanManageActor(viewer, args.input.actorId);
          if (viewer.id !== target.id) {
            assertApiKeyScope(context, "admin");
            assertUnrestrictedApiKey(context);
          }
          const metadata = apiKeyMetadata(context.db, args.input, context.workspace.workspaceId);
          assertChildApiKey(context, target, args.input, metadata);
          const { row, key } = createApiKey(context.db, {
            ...args.input,
            ...metadata,
            workspaceId: context.workspace.workspaceId,
          });
          return {
            success: true,
            apiKey: mapApiKey(row, context.db, context.workspace.workspaceId),
            key,
          };
        },
        apiKeyDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertApiKeyScope(context, "write");
          if (context.persistence) {
            const key = await getPostgresApiKey(context.persistence, args.id);
            if (!key) throw apiError("NOT_FOUND", "API key not found");
            if (key.actor_id !== viewer.id && !isWorkspaceAdmin(viewer)) {
              throw apiError("UNAUTHORIZED", "You can only manage your own API keys");
            }
            if (key.actor_id !== viewer.id) {
              assertApiKeyScope(context, "admin");
              assertUnrestrictedApiKey(context);
            }
            return { success: await deletePostgresApiKey(context.persistence, args.id) };
          }
          const key = getApiKey(context.db, args.id);
          assertCanManageApiKey(context.db, viewer, args.id);
          if (key && key.actor_id !== viewer.id) {
            assertApiKeyScope(context, "admin");
            assertUnrestrictedApiKey(context);
          }
          return { success: deleteApiKey(context.db, args.id) };
        },
        apiKeyRotate: async (
          _parent: unknown,
          args: {
            id: string;
            input: {
              name?: string | null;
              scopes?: string[] | null;
              teamIds?: string[] | null;
              expiresAt?: string | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertApiKeyScope(context, "write");
          if (context.persistence) {
            const existing = await getPostgresApiKey(context.persistence, args.id);
            if (!existing) throw apiError("NOT_FOUND", "API key not found");
            if (existing.actor_id !== viewer.id) {
              assertApiKeyScope(context, "admin");
              assertUnrestrictedApiKey(context);
            }
            const target = await getPostgresActor(context.persistence, existing.actor_id);
            if (!target) throw apiError("NOT_FOUND", "Actor not found");
            assertCanManageActor(viewer, existing.actor_id);
            const existingView = (
              await listPostgresApiKeys(context.persistence, existing.actor_id)
            ).find((row) => row.id === existing.id);
            const metadata = await postgresApiKeyMetadata(context.persistence, {
              ...args.input,
              scopes: args.input.scopes === undefined ? existingView?.scopes : args.input.scopes,
              teamIds:
                args.input.teamIds === undefined ? existingView?.teamIds : args.input.teamIds,
              expiresAt:
                args.input.expiresAt === undefined ? existing.expires_at : args.input.expiresAt,
            });
            assertChildApiKey(context, target, args.input, metadata);
            const result = await rotatePostgresApiKey(context.persistence, args.id, args.input);
            return { success: true, apiKey: mapPostgresApiKey(result.row), key: result.key };
          }
          const existing = getApiKey(context.db, args.id);
          assertCanManageApiKey(context.db, viewer, args.id);
          if (!existing) throw apiError("NOT_FOUND", "API key not found");
          if (existing.actor_id !== viewer.id) {
            assertApiKeyScope(context, "admin");
            assertUnrestrictedApiKey(context);
          }
          const target = requireActor(context, existing.actor_id);
          const metadata = apiKeyMetadata(
            context.db,
            {
              scopes:
                args.input.scopes === undefined
                  ? listApiKeyScopes(context.db, args.id)
                  : args.input.scopes,
              teamIds:
                args.input.teamIds === undefined
                  ? listApiKeyTeamIds(context.db, args.id, context.workspace.workspaceId)
                  : args.input.teamIds,
              expiresAt:
                args.input.expiresAt === undefined ? existing.expires_at : args.input.expiresAt,
            },
            context.workspace.workspaceId,
          );
          assertChildApiKey(context, target, args.input, metadata);
          const { row, key } = rotateApiKey(context.db, args.id, {
            ...args.input,
            ...metadata,
            workspaceId: context.workspace.workspaceId,
          });
          return {
            success: true,
            apiKey: mapApiKey(row, context.db, context.workspace.workspaceId),
            key,
          };
        },
        webhookCreate: (
          _parent: unknown,
          args: {
            input: {
              url: string;
              secret?: string | null;
              events?: string[] | null;
              teamId?: string | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (args.input.teamId) {
            requireTeam(context, { id: args.input.teamId });
            assertCanAccessTeam(context.db, viewer, args.input.teamId);
            assertTeamActive(context.db, args.input.teamId);
            if (!canWriteTeam(context.db, viewer, args.input.teamId)) {
              throw apiError(
                "UNAUTHORIZED",
                "Team access policy does not allow webhook management",
              );
            }
          }
          const { row, secret } = createWebhook(context.db, viewer.id, args.input);
          return { success: true, webhook: mapWebhook(row), secret };
        },
        webhookDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          const existing = context.db
            .query("SELECT team_id FROM webhooks WHERE id = ?1")
            .get(args.id) as {
            team_id: string | null;
          } | null;
          requireWebhook(context, args.id);
          if (existing?.team_id) {
            assertCanAccessTeam(context.db, viewer, existing.team_id);
            if (!canWriteTeam(context.db, viewer, existing.team_id)) {
              throw apiError(
                "UNAUTHORIZED",
                "Team access policy does not allow webhook management",
              );
            }
          }
          return {
            success: deleteWebhook(context.db, args.id, viewer.id, isWorkspaceAdmin(viewer)),
          };
        },
        labelCreate: async (
          _parent: unknown,
          args: { input: { name: string; color?: string | null; teamId?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            if (args.input.teamId && !apiKeyTeamsWithinLimit(context.auth, [args.input.teamId])) {
              throw apiError("NOT_FOUND", "Team resource not found");
            }
            const label = await createPostgresLabel(context.persistence, viewer, args.input);
            return { success: true, label: mapPostgresLabel(label) };
          }
          if (args.input.teamId != null) {
            assertCanManageTeam(context.db, viewer, args.input.teamId);
          } else {
            assertWorkspaceAdmin(viewer);
          }
          const label = mapLabel(createLabel(context.db, args.input));
          return { success: true, label };
        },
        workflowStateUpdate: async (
          _parent: unknown,
          args: { id: string; input: Parameters<typeof updateWorkflowState>[2] },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const existing = await getPostgresWorkflowState(context.persistence, args.id);
            if (!existing) throw apiError("NOT_FOUND", "Workflow state not found");
            if (!apiKeyTeamsWithinLimit(context.auth, [existing.team_id])) {
              throw apiError("UNAUTHORIZED", "API key is not allowed for this Team");
            }
            if (
              !isWorkspaceAdmin(viewer) &&
              !(await isPostgresTeamOwner(context.persistence, existing.team_id, viewer.id))
            ) {
              throw apiError("UNAUTHORIZED", "Team owner permission is required");
            }
            await assertPostgresTeamActive(context.persistence, existing.team_id);
            return {
              success: true,
              workflowState: mapPostgresWorkflowState(
                await updatePostgresWorkflowState(context.persistence, args.id, args.input),
              ),
            };
          }
          const existing = getWorkflowState(context.db, args.id);
          if (existing) assertCanManageTeam(context.db, viewer, existing.team_id);
          const state = mapWorkflowState(updateWorkflowState(context.db, args.id, args.input));
          return { success: true, workflowState: state };
        },
        workflowStateDelete: async (
          _parent: unknown,
          args: { id: string; moveToStateId?: string | null },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const existing = await getPostgresWorkflowState(context.persistence, args.id);
            if (!existing) throw apiError("NOT_FOUND", "Workflow state not found");
            if (!apiKeyTeamsWithinLimit(context.auth, [existing.team_id])) {
              throw apiError("UNAUTHORIZED", "API key is not allowed for this Team");
            }
            if (
              !isWorkspaceAdmin(viewer) &&
              !(await isPostgresTeamOwner(context.persistence, existing.team_id, viewer.id))
            ) {
              throw apiError("UNAUTHORIZED", "Team owner permission is required");
            }
            await assertPostgresTeamActive(context.persistence, existing.team_id);
            const movedIssues = await deletePostgresWorkflowState(
              context.persistence,
              viewer.id,
              args.id,
              args.moveToStateId,
            );
            return { success: true, movedIssues };
          }
          const existing = getWorkflowState(context.db, args.id);
          if (existing) assertCanManageTeam(context.db, viewer, existing.team_id);
          const affected = context.db
            .query("SELECT id FROM issues WHERE state_id = ?1")
            .all(args.id)
            .map((row) => (row as { id: string }).id);
          const moved = deleteWorkflowState(context.db, viewer.id, args.id, args.moveToStateId);
          emitBulkIssueUpdates(context, viewer, affected, {
            state: { from: args.id, to: args.moveToStateId ?? null },
          });
          return { success: true, movedIssues: moved };
        },
        labelUpdate: async (
          _parent: unknown,
          args: { id: string; input: { name?: string | null; color?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const existing = await getPostgresLabel(context.persistence, args.id);
            if (existing?.team_id && !apiKeyTeamsWithinLimit(context.auth, [existing.team_id])) {
              throw apiError("NOT_FOUND", "Label resource not found");
            }
            const label = await updatePostgresLabel(
              context.persistence,
              viewer,
              args.id,
              args.input,
            );
            return { success: true, label: mapPostgresLabel(label) };
          }
          const existing = getLabel(context.db, args.id);
          if (existing) {
            if (existing.team_id == null) assertWorkspaceAdmin(viewer);
            else assertCanManageTeam(context.db, viewer, existing.team_id);
          }
          const label = mapLabel(updateLabel(context.db, args.id, args.input));
          return { success: true, label };
        },
        labelDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const existing = await getPostgresLabel(context.persistence, args.id);
            if (existing?.team_id && !apiKeyTeamsWithinLimit(context.auth, [existing.team_id])) {
              throw apiError("NOT_FOUND", "Label resource not found");
            }
            const affected = await deletePostgresLabel(context.persistence, viewer, args.id);
            return { success: true, affectedIssues: affected };
          }
          const existing = getLabel(context.db, args.id);
          if (existing) {
            if (existing.team_id == null) assertWorkspaceAdmin(viewer);
            else assertCanManageTeam(context.db, viewer, existing.team_id);
          }
          const affectedIds = context.db
            .query("SELECT issue_id AS id FROM issue_labels WHERE label_id = ?1")
            .all(args.id)
            .map((row) => (row as { id: string }).id);
          const affected = deleteLabel(context.db, viewer.id, args.id);
          emitBulkIssueUpdates(context, viewer, affectedIds, {
            labels: { from: args.id, to: null },
          });
          return { success: true, affectedIssues: affected };
        },
        workflowStateCreate: async (
          _parent: unknown,
          args: {
            input: {
              teamId: string;
              name: string;
              type: string;
              color?: string | null;
              position?: number | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const team = await getPostgresTeam(context.persistence, { id: args.input.teamId });
            if (!team) throw apiError("NOT_FOUND", "Team not found");
            if (
              !isWorkspaceAdmin(viewer) &&
              !(await isPostgresTeamOwner(context.persistence, team.id, viewer.id))
            ) {
              throw apiError("UNAUTHORIZED", "Team owner permission is required");
            }
            await assertPostgresTeamActive(context.persistence, team.id);
            return {
              success: true,
              workflowState: mapPostgresWorkflowState(
                await createPostgresWorkflowState(context.persistence, args.input),
              ),
            };
          }
          assertCanManageTeam(context.db, viewer, args.input.teamId);
          const workflowState = mapWorkflowState(createWorkflowState(context.db, args.input));
          return { success: true, workflowState };
        },
        savedViewCreate: (
          _parent: unknown,
          args: {
            input: {
              name: string;
              scope: string;
              teamId?: string | null;
              filter?: unknown;
              orderBy?: string | null;
              groupBy?: string | null;
              columns?: string[] | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (args.input.scope.toLowerCase() === "team") {
            assertCanManageIssue(context.db, viewer, args.input.teamId);
          }
          const savedView = mapSavedView(createSavedView(context.db, viewer.id, args.input));
          return { success: true, savedView };
        },
        savedViewUpdate: (
          _parent: unknown,
          args: {
            id: string;
            input: {
              name?: string | null;
              filter?: unknown;
              orderBy?: string | null;
              groupBy?: string | null;
              columns?: string[] | null;
              archived?: boolean | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          const existing = getSavedView(context.db, args.id);
          if (existing?.team_id && canAccessSavedView(context.db, existing, viewer.id)) {
            assertTeamActive(context.db, existing.team_id);
            assertCanManageIssue(context.db, viewer, existing.team_id);
          }
          const savedView = mapSavedView(
            updateSavedView(context.db, args.id, viewer.id, args.input),
          );
          return { success: true, savedView };
        },
        savedViewDuplicate: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          const existing = getSavedView(context.db, args.id);
          if (existing?.team_id && canAccessSavedView(context.db, existing, viewer.id)) {
            assertTeamActive(context.db, existing.team_id);
            assertCanManageIssue(context.db, viewer, existing.team_id);
          }
          const savedView = mapSavedView(duplicateSavedView(context.db, args.id, viewer.id));
          return { success: true, savedView };
        },
        savedViewDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          const existing = getSavedView(context.db, args.id);
          if (existing?.team_id && canAccessSavedView(context.db, existing, viewer.id)) {
            assertTeamActive(context.db, existing.team_id);
            assertCanManageIssue(context.db, viewer, existing.team_id);
          }
          return { success: deleteSavedView(context.db, args.id, viewer.id) };
        },
        favoriteCreate: (
          _parent: unknown,
          args: { input: { projectId?: string | null; savedViewId?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (args.input.projectId) {
            const project = requireProject(context, args.input.projectId);
            if (!canAccessProject(context.db, viewer, project.id)) {
              throw apiError("NOT_FOUND", "Project not found");
            }
          }
          if (args.input.savedViewId) {
            const savedView = getSavedView(context.db, args.input.savedViewId);
            if (!savedView || !canAccessSavedView(context.db, savedView, viewer.id)) {
              throw apiError("NOT_FOUND", "Saved view not found");
            }
          }
          return {
            success: true,
            favorite: mapFavorite(createFavorite(context.db, viewer.id, args.input)),
          };
        },
        favoriteDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          return { success: deleteFavorite(context.db, viewer.id, args.id) };
        },
        favoriteReorder: (
          _parent: unknown,
          args: { id: string; position: number },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          return {
            success: true,
            favorite: mapFavorite(reorderFavorite(context.db, viewer.id, args.id, args.position)),
          };
        },
        cycleCreate: (
          _parent: unknown,
          args: {
            input: {
              teamId: string;
              name: string;
              startsAt: string;
              endsAt: string;
              state?: string | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertCanManageTeam(context.db, viewer, args.input.teamId);
          return { success: true, cycle: mapCycle(createCycle(context.db, args.input)) };
        },
        cycleUpdate: (
          _parent: unknown,
          args: {
            id: string;
            input: {
              name?: string | null;
              startsAt?: string | null;
              endsAt?: string | null;
              state?: string | null;
              archived?: boolean | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          const existing = getCycle(context.db, args.id);
          if (existing) assertCanManageTeam(context.db, viewer, existing.team_id);
          return { success: true, cycle: mapCycle(updateCycle(context.db, args.id, args.input)) };
        },
        cycleDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          const existing = getCycle(context.db, args.id);
          if (existing) assertCanManageTeam(context.db, viewer, existing.team_id);
          const affected = context.db
            .query("SELECT id FROM issues WHERE cycle_id = ?1")
            .all(args.id)
            .map((row) => (row as { id: string }).id);
          const success = deleteCycle(context.db, viewer.id, args.id);
          emitBulkIssueUpdates(context, viewer, affected, {
            cycle: { from: args.id, to: null },
          });
          return { success };
        },
        cycleCarryOver: (
          _parent: unknown,
          args: { fromCycleId: string; toCycleId: string },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          const fromCycle = getCycle(context.db, args.fromCycleId);
          if (fromCycle) assertCanManageTeam(context.db, viewer, fromCycle.team_id);
          const movedIssues = carryOverCycle(
            context.db,
            viewer.id,
            args.fromCycleId,
            args.toCycleId,
          );
          return { success: true, movedIssues };
        },
        reviewCreate: (
          _parent: unknown,
          args: { input: { issueId: string; reviewerId: string } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          const issue = requireIssue(context, args.input.issueId);
          assertCanManageIssue(context.db, viewer, issue.team_id);
          if (args.input.reviewerId) {
            requireActor(context, args.input.reviewerId);
            assertCanAssignToTeam(context.db, viewer, issue.team_id, args.input.reviewerId);
          }
          return {
            success: true,
            review: mapReview(createReview(context.db, viewer.id, args.input)),
          };
        },
        reviewUpdate: (
          _parent: unknown,
          args: {
            id: string;
            input: { status?: string | null; reviewerId?: string | null };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          const existing = getReview(context.db, args.id);
          if (existing) {
            const issue = lookupIssueById(context, existing.issue_id);
            assertCanManageIssue(context.db, viewer, issue?.team_id);
          }
          return {
            success: true,
            review: mapReview(
              updateReview(context.db, args.id, viewer.id, args.input, isWorkspaceAdmin(viewer)),
            ),
          };
        },
        reviewDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          const existing = getReview(context.db, args.id);
          if (existing) {
            const issue = lookupIssueById(context, existing.issue_id);
            assertCanManageIssue(context.db, viewer, issue?.team_id);
          }
          return {
            success: deleteReview(context.db, args.id, viewer.id, isWorkspaceAdmin(viewer)),
          };
        },
        initiativeCreate: (
          _parent: unknown,
          args: {
            input: {
              name: string;
              description?: string | null;
              state?: string | null;
              targetDate?: string | null;
              projectIds?: string[] | null;
              teamIds?: string[] | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          return {
            success: true,
            initiative: mapInitiative(
              createInitiative(context.db, viewer, args.input, context.workspace.workspaceId),
            ),
          };
        },
        initiativeUpdate: (
          _parent: unknown,
          args: {
            id: string;
            input: {
              name?: string | null;
              description?: string | null;
              state?: string | null;
              targetDate?: string | null;
              projectIds?: string[] | null;
              teamIds?: string[] | null;
              archived?: boolean | null;
            };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          return {
            success: true,
            initiative: mapInitiative(
              updateInitiative(
                context.db,
                args.id,
                viewer,
                args.input,
                context.workspace.workspaceId,
              ),
            ),
          };
        },
        initiativeDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          return {
            success: deleteInitiative(context.db, args.id, viewer, context.workspace.workspaceId),
          };
        },
        inboxMarkRead: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          const row = markInboxRead(context.db, args.id, viewer.id);
          return {
            success: true,
            inboxItem: {
              ...mapActivity(row),
              issueId: row.issue_id,
              isRead: Boolean(row.is_read),
              isArchived: Boolean(row.is_archived),
            },
          };
        },
        inboxArchive: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          const row = archiveInboxItem(context.db, args.id, viewer.id);
          return {
            success: true,
            inboxItem: {
              ...mapActivity(row),
              issueId: row.issue_id,
              isRead: Boolean(row.is_read),
              isArchived: Boolean(row.is_archived),
            },
          };
        },
      },
      "mutation",
    ),
  ),
};
