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
import { getWorkspace, mapWorkspace, updateWorkspace } from "../domain/workspaces.ts";

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
    states: (team: { id: string }, _args: unknown, context: Context) =>
      canAccessTeam(context.db, requireViewer(context), team.id)
        ? listTeamStates(context.db, team.id).map(mapWorkflowState)
        : [],
    defaultState: (team: { _row: TeamRow }, _args: unknown, context: Context) =>
      canAccessTeam(context.db, requireViewer(context), team._row.id)
        ? mapWorkflowState(getDefaultState(context.db, team._row))
        : null,
    labels: (team: { id: string }, _args: unknown, context: Context) =>
      canAccessTeam(context.db, requireViewer(context), team.id)
        ? listLabels(context.db, team.id).map(mapLabel)
        : [],
    projects: (team: { id: string }, _args: unknown, context: Context) =>
      listProjects(context.db, null, team.id)
        .filter((project) => canAccessProject(context.db, requireViewer(context), project.id))
        .filter((project) =>
          apiKeyTeamsWithinLimit(context.auth, listProjectTeamIds(context.db, project.id)),
        )
        .map(mapProject),
    cycles: (team: { id: string }, _args: unknown, context: Context) =>
      canAccessTeam(context.db, requireViewer(context), team.id)
        ? listCycles(context.db, team.id).map(mapCycle)
        : [],
    memberships: (team: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      return isWorkspaceAdmin(viewer) || isTeamMember(context.db, team.id, viewer.id)
        ? listTeamMemberships(context.db, team.id).map(mapTeamMembership)
        : [];
    },
  },

  TeamMembership: {
    team: (membership: { teamId: string }, _args: unknown, context: Context) =>
      mapTeam(lookupTeam(context, { id: membership.teamId })!),
    actor: (membership: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, membership.actorId)!),
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
      return listInitiativeProjectIds(context.db, initiative.id)
        .map((projectId) => lookupProject(context, projectId))
        .filter((row) => row && canAccessProject(context.db, viewer, row.id))
        .map((row) => mapProject(row!));
    },
    teams: (initiative: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      return listInitiativeTeamIds(context.db, initiative.id)
        .map((teamId) => lookupTeam(context, { id: teamId }))
        .filter((row) => row && canAccessTeam(context.db, viewer, row.id))
        .map((row) => mapTeam(row!));
    },
    owner: (initiative: { ownerId: string | null }, _args: unknown, context: Context) =>
      initiative.ownerId ? mapActor(lookupActor(context, initiative.ownerId)!) : null,
    progress: (initiative: { id: string }, _args: unknown, context: Context) =>
      initiativeProgress(context.db, initiative.id).progress,
    completedIssues: (initiative: { id: string }, _args: unknown, context: Context) =>
      initiativeProgress(context.db, initiative.id).completedIssues,
    totalIssues: (initiative: { id: string }, _args: unknown, context: Context) =>
      initiativeProgress(context.db, initiative.id).totalIssues,
  },

  ApiKey: {
    actor: (apiKey: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, apiKey.actorId)!),
  },

  Actor: {
    apiKeys: (actor: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (!isWorkspaceAdmin(viewer) && viewer.id !== actor.id) return [];
      return listApiKeys(context.db, actor.id).map((row) => mapApiKey(row, context.db));
    },
  },

  ActorInvitation: {
    invitedBy: (invitation: { invitedById: string }, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, invitation.invitedById)!),
    actor: (invitation: { actorId: string | null }, _args: unknown, context: Context) =>
      invitation.actorId ? mapActor(lookupActor(context, invitation.actorId)!) : null,
  },

  Query: withApiKeyScopes(
    {
      ...issueResolvers.Query,
      ...projectResolvers.Query,
      viewer: (_parent: unknown, _args: unknown, context: Context) =>
        mapActor(requireViewer(context)),
      workspace: (_parent: unknown, _args: unknown, context: Context) => {
        requireViewer(context);
        const row = getWorkspace(context.db, context.workspace.workspaceId);
        if (!row) throw apiError("NOT_FOUND", "Workspace is not initialized");
        return mapWorkspace(row);
      },
      teams: (_parent: unknown, args: { includeArchived?: boolean | null }, context: Context) => {
        const viewer = requireViewer(context);
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
      team: (
        _parent: unknown,
        args: { id?: string; key?: string; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        const row = lookupTeam(context, args);
        if (row?.archived_at && !args.includeArchived) return null;
        return row && canDiscoverTeam(context.db, viewer, row.id) ? mapTeam(row) : null;
      },
      actors: (_parent: unknown, args: { type?: string }, context: Context) => {
        requireViewer(context);
        return listActorsInWorkspace(context, args.type).map(mapActor);
      },
      actorInvitations: (
        _parent: unknown,
        args: { includeRevoked?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        assertWorkspaceAdmin(viewer);
        return listActorInvitations(context.db, Boolean(args.includeRevoked)).map(
          mapActorInvitation,
        );
      },
      teamMemberships: (_parent: unknown, args: { teamId: string }, context: Context) => {
        const viewer = requireViewer(context);
        const team = lookupTeam(context, { id: args.teamId });
        if (team?.archived_at) return [];
        if (!team || !(isWorkspaceAdmin(viewer) || isTeamMember(context.db, team.id, viewer.id))) {
          return [];
        }
        return scopeWorkspaceRows(context, listTeamMemberships(context.db, args.teamId)).map(
          mapTeamMembership,
        );
      },
      labels: (_parent: unknown, args: { team?: string }, context: Context) => {
        const viewer = requireViewer(context);
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
          listInitiatives(context.db, Boolean(args.includeArchived), viewer.id),
        ).map(mapInitiative);
      },
      initiative: (_parent: unknown, args: { id: string }, context: Context) => {
        const viewer = requireViewer(context);
        const row = getInitiative(context.db, args.id);
        if (!row) return null;
        scopeWorkspaceRow(context, row);
        return canViewInitiative(context.db, row.id, viewer.id) ? mapInitiative(row) : null;
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
        teamArchive: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          requireTeam(context, { id: args.id });
          return { success: true, team: mapTeam(archiveTeam(context.db, args.id, true)) };
        },
        teamUnarchive: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          requireTeam(context, { id: args.id });
          return { success: true, team: mapTeam(archiveTeam(context.db, args.id, false)) };
        },
        teamDelete: (
          _parent: unknown,
          args: { id: string; confirmation: string },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
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
        workspaceUpdate: (
          _parent: unknown,
          args: { input: { name: string } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          return {
            success: true,
            workspace: mapWorkspace(
              updateWorkspace(context.db, args.input, context.workspace.workspaceId),
            ),
          };
        },
        teamCreate: (
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
          const team = mapTeam(createTeam(context.db, args.input, viewer.id));
          return { success: true, team };
        },
        teamUpdate: (
          _parent: unknown,
          args: { id: string; input: TeamUpdateInput },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertCanManageTeam(context.db, viewer, args.id);
          requireTeam(context, { id: args.id });
          const team = mapTeam(updateTeam(context.db, args.id, args.input));
          return { success: true, team };
        },
        teamMembershipCreate: (
          _parent: unknown,
          args: { input: { teamId: string; actorId: string; role?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          requireTeam(context, { id: args.input.teamId });
          requireActor(context, args.input.actorId);
          return {
            success: true,
            membership: mapTeamMembership(
              createTeamMembership(context.db, viewer.id, args.input, isWorkspaceAdmin(viewer)),
            ),
          };
        },
        teamMembershipDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          return {
            success: deleteTeamMembership(context.db, viewer.id, args.id, isWorkspaceAdmin(viewer)),
          };
        },
        actorCreate: (
          _parent: unknown,
          args: { input: { name: string; type: string; email?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          const actor = mapActor(createActor(context.db, args.input));
          return { success: true, actor };
        },
        actorUpdate: (
          _parent: unknown,
          args: { id: string; input: { name?: string | null; email?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          requireActor(context, args.id);
          assertCanManageActor(viewer, args.id);
          const actor = mapActor(updateActor(context.db, args.id, args.input));
          return { success: true, actor };
        },
        actorInvite: (
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
          const result = createActorInvitation(context.db, viewer.id, args.input);
          return { success: true, invitation: mapActorInvitation(result.row), token: result.token };
        },
        actorInvitationAccept: (
          _parent: unknown,
          args: { token: string; input: { name?: string | null; type?: string | null } },
          context: Context,
        ) => {
          const result = acceptActorInvitation(context.db, args.token, args.input);
          return {
            success: true,
            invitation: mapActorInvitation(result.invitation),
            actor: mapActor(result.actor),
            key: result.key,
          };
        },
        actorInvitationRevoke: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          return {
            success: true,
            invitation: mapActorInvitation(revokeActorInvitation(context.db, args.id)),
          };
        },
        actorSuspend: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          requireActor(context, args.id);
          return { success: true, actor: mapActor(suspendActor(context.db, args.id, viewer.id)) };
        },
        actorReactivate: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          requireActor(context, args.id);
          return { success: true, actor: mapActor(reactivateActor(context.db, args.id)) };
        },
        actorRevoke: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertWorkspaceAdmin(viewer);
          requireActor(context, args.id);
          return { success: true, actor: mapActor(revokeActor(context.db, args.id)) };
        },
        actorLeave: (_parent: unknown, args: { id?: string | null }, context: Context) => {
          const viewer = requireViewer(context);
          const actorId = args.id ?? viewer.id;
          if (actorId !== viewer.id)
            throw apiError("UNAUTHORIZED", "You can only leave as yourself");
          return { success: true, actor: mapActor(leaveActor(context.db, actorId)) };
        },
        apiKeyCreate: (
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
          const target = requireActor(context, args.input.actorId);
          assertCanManageActor(viewer, args.input.actorId);
          if (viewer.id !== target.id) {
            assertApiKeyScope(context, "admin");
            assertUnrestrictedApiKey(context);
          }
          const metadata = apiKeyMetadata(context.db, args.input);
          assertChildApiKey(context, target, args.input, metadata);
          const { row, key } = createApiKey(context.db, { ...args.input, ...metadata });
          return { success: true, apiKey: mapApiKey(row, context.db), key };
        },
        apiKeyDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          assertApiKeyScope(context, "write");
          const key = getApiKey(context.db, args.id);
          assertCanManageApiKey(context.db, viewer, args.id);
          if (key && key.actor_id !== viewer.id) {
            assertApiKeyScope(context, "admin");
            assertUnrestrictedApiKey(context);
          }
          return { success: deleteApiKey(context.db, args.id) };
        },
        apiKeyRotate: (
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
          const existing = getApiKey(context.db, args.id);
          assertCanManageApiKey(context.db, viewer, args.id);
          if (!existing) throw apiError("NOT_FOUND", "API key not found");
          if (existing.actor_id !== viewer.id) {
            assertApiKeyScope(context, "admin");
            assertUnrestrictedApiKey(context);
          }
          const target = requireActor(context, existing.actor_id);
          const metadata = apiKeyMetadata(context.db, {
            scopes:
              args.input.scopes === undefined
                ? listApiKeyScopes(context.db, args.id)
                : args.input.scopes,
            teamIds:
              args.input.teamIds === undefined
                ? listApiKeyTeamIds(context.db, args.id)
                : args.input.teamIds,
            expiresAt:
              args.input.expiresAt === undefined ? existing.expires_at : args.input.expiresAt,
          });
          assertChildApiKey(context, target, args.input, metadata);
          const { row, key } = rotateApiKey(context.db, args.id, { ...args.input, ...metadata });
          return { success: true, apiKey: mapApiKey(row, context.db), key };
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
        labelCreate: (
          _parent: unknown,
          args: { input: { name: string; color?: string | null; teamId?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (args.input.teamId != null) {
            assertCanManageTeam(context.db, viewer, args.input.teamId);
          } else {
            assertWorkspaceAdmin(viewer);
          }
          const label = mapLabel(createLabel(context.db, args.input));
          return { success: true, label };
        },
        workflowStateUpdate: (
          _parent: unknown,
          args: { id: string; input: Parameters<typeof updateWorkflowState>[2] },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          const existing = getWorkflowState(context.db, args.id);
          if (existing) assertCanManageTeam(context.db, viewer, existing.team_id);
          const state = mapWorkflowState(updateWorkflowState(context.db, args.id, args.input));
          return { success: true, workflowState: state };
        },
        workflowStateDelete: (
          _parent: unknown,
          args: { id: string; moveToStateId?: string | null },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
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
        labelUpdate: (
          _parent: unknown,
          args: { id: string; input: { name?: string | null; color?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          const existing = getLabel(context.db, args.id);
          if (existing) {
            if (existing.team_id == null) assertWorkspaceAdmin(viewer);
            else assertCanManageTeam(context.db, viewer, existing.team_id);
          }
          const label = mapLabel(updateLabel(context.db, args.id, args.input));
          return { success: true, label };
        },
        labelDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
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
        workflowStateCreate: (
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
            initiative: mapInitiative(createInitiative(context.db, viewer.id, args.input)),
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
            initiative: mapInitiative(updateInitiative(context.db, args.id, viewer.id, args.input)),
          };
        },
        initiativeDelete: (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          return { success: deleteInitiative(context.db, args.id, viewer.id) };
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
