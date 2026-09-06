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
  canWritePostgresTeam,
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
  hasApiKeyTeamLimit,
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
import {
  assertCanCreatePostgresWebhook,
  createPostgresWebhook,
  deletePostgresWebhook,
  listPostgresWebhooks,
  mapPostgresWebhook,
} from "../domain/postgres-webhooks.ts";
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
  archivePostgresInboxItem,
  countPostgresUnreadInboxActivity,
  listPostgresInboxActivity,
  listPostgresInboxActivityPage,
  mapPostgresInboxActivity,
  markPostgresInboxRead,
} from "../domain/postgres-inbox.ts";
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
  carryOverPostgresCycle,
  createPostgresCycle,
  cycleProgress as postgresCycleProgress,
  deletePostgresCycle,
  getPostgresCycle,
  listPostgresCycles,
  mapPostgresCycle,
  updatePostgresCycle,
} from "../domain/postgres-cycles.ts";
import {
  createReview,
  deleteReview,
  getReview,
  listReviews,
  mapReview,
  updateReview,
} from "../domain/reviews.ts";
import {
  createPostgresReview,
  deletePostgresReview,
  getPostgresReview,
  listPostgresReviews,
  mapPostgresReview,
  updatePostgresReview,
} from "../domain/postgres-reviews.ts";
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
  canAccessPostgresInitiative,
  createPostgresInitiative,
  deletePostgresInitiative,
  getPostgresInitiative,
  listPostgresInitiativeProjectIds,
  listPostgresInitiativeScopeTeamIds,
  listPostgresInitiativeTeamIds,
  listPostgresInitiatives,
  mapPostgresInitiative,
  postgresInitiativeProgress,
  updatePostgresInitiative,
} from "../domain/postgres-initiatives.ts";
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
import { getPostgresIssue, getPostgresIssueByRef } from "../domain/postgres-issues.ts";
import {
  canAccessPostgresProject,
  getPostgresProject,
  listPostgresProjectTeamIds,
  listPostgresProjects,
  mapPostgresProject,
} from "../domain/postgres-projects.ts";
import {
  canAccessPostgresSavedView,
  createPostgresSavedView,
  deletePostgresSavedView,
  duplicatePostgresSavedView,
  getPostgresSavedView,
  listPostgresSavedViews,
  mapPostgresSavedView,
  updatePostgresSavedView,
} from "../domain/postgres-saved-views.ts";
import {
  createPostgresFavorite,
  deletePostgresFavorite,
  listPostgresFavorites,
  mapPostgresFavorite,
  reorderPostgresFavorite,
} from "../domain/postgres-favorites.ts";
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

async function assertPostgresInitiativeKeyLimit(
  context: Context,
  initiativeId: string | null,
  projectIds?: readonly string[] | null,
  teamIds?: readonly string[] | null,
): Promise<void> {
  if (!context.auth?.teamIds || !context.persistence) return;
  if (initiativeId && !(await getPostgresInitiative(context.persistence, initiativeId))) {
    throw apiError("NOT_FOUND", "Initiative not found");
  }
  const currentProjectIds = initiativeId
    ? await listPostgresInitiativeProjectIds(context.persistence, initiativeId)
    : [];
  const currentTeamIds = initiativeId
    ? await listPostgresInitiativeTeamIds(context.persistence, initiativeId)
    : [];
  const effectiveProjectIds =
    initiativeId && projectIds == null ? currentProjectIds : (projectIds ?? []);
  const effectiveTeamIds = initiativeId && teamIds == null ? currentTeamIds : (teamIds ?? []);
  const scope = new Set<string>();
  const targetScope = new Set<string>();
  const addProjectTeams = async (
    ids: readonly string[],
    destination: Set<string>,
  ): Promise<void> => {
    for (const projectId of ids) {
      const project = await getPostgresProject(context.persistence!, projectId);
      if (!project) throw apiError("NOT_FOUND", "Project not found");
      for (const teamId of await listPostgresProjectTeamIds(context.persistence!, project.id)) {
        destination.add(teamId);
      }
    }
  };
  const addDirectTeams = async (
    ids: readonly string[],
    destination: Set<string>,
  ): Promise<void> => {
    for (const teamId of ids) {
      const team = await getPostgresTeam(context.persistence!, { id: teamId });
      if (!team) throw apiError("NOT_FOUND", "Team not found");
      destination.add(team.id);
    }
  };
  await addProjectTeams(currentProjectIds, scope);
  await addDirectTeams(currentTeamIds, scope);
  await addProjectTeams(effectiveProjectIds, targetScope);
  await addDirectTeams(effectiveTeamIds, targetScope);
  if (!targetScope.size) {
    throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
  }
  for (const teamId of targetScope) scope.add(teamId);
  if (!apiKeyTeamsWithinLimit(context.auth, [...scope])) {
    throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
  }
}

async function requirePostgresReviewIssue(
  context: Context,
  issueRef: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getPostgresIssueByRef>>>> {
  const persistence = context.persistence;
  if (!persistence) throw new Error("PostgreSQL persistence is required for a review");
  const issue = await getPostgresIssueByRef(persistence, issueRef);
  if (!issue) throw apiError("NOT_FOUND", "Issue not found");
  const team = await getPostgresTeam(persistence, { id: issue.team_id });
  if (!team) throw apiError("NOT_FOUND", "Team not found");
  if (!apiKeyTeamsWithinLimit(context.auth, [team.id])) {
    throw apiError("NOT_FOUND", "Issue resource not found");
  }
  if (!(await canDiscoverPostgresTeam(persistence, requireViewer(context), team))) {
    throw apiError("NOT_FOUND", "Team resource not found");
  }
  await assertPostgresTeamActive(persistence, team.id);
  if (!(await canWritePostgresTeam(persistence, requireViewer(context), team.id))) {
    throw apiError("UNAUTHORIZED", "Team access policy does not allow this operation");
  }
  return issue;
}

async function assertPostgresReviewReviewer(
  context: Context,
  teamId: string,
  reviewerId: string,
): Promise<void> {
  const persistence = context.persistence;
  if (!persistence) throw new Error("PostgreSQL persistence is required for a review");
  const viewer = requireViewer(context);
  const reviewer = await getPostgresActor(persistence, reviewerId);
  if (!reviewer || reviewer.status !== "active") {
    throw apiError("UNAUTHORIZED", "Assignee must be an active actor");
  }
  const team = await getPostgresTeam(persistence, { id: teamId });
  if (!team || !(await canWritePostgresTeam(persistence, viewer, teamId))) {
    throw apiError("UNAUTHORIZED", "Assignee is not allowed for this Team");
  }
  if (
    !isWorkspaceAdmin(viewer) &&
    team.access_policy === "team_members" &&
    !(await isPostgresTeamMember(persistence, teamId, reviewerId))
  ) {
    throw apiError("UNAUTHORIZED", "Assignee must be a Team member");
  }
}

async function visiblePostgresReview(
  context: Context,
  review: { issue_id: string; requester_id: string; reviewer_id: string },
  viewer: ReturnType<typeof requireViewer>,
): Promise<boolean> {
  const persistence = context.persistence;
  if (!persistence) return false;
  const issue = await getPostgresIssue(persistence, review.issue_id);
  const team = issue ? await getPostgresTeam(persistence, { id: issue.team_id }) : null;
  return Boolean(
    issue &&
    team &&
    (await canDiscoverPostgresTeam(persistence, viewer, team)) &&
    (await canWritePostgresTeam(persistence, viewer, team.id)) &&
    apiKeyTeamsWithinLimit(context.auth, [team.id]),
  );
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
    workspaceId: (_team: unknown, _args: unknown, context: Context) =>
      context.workspace.workspaceId,
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
        ? listTeamStates(context.db, team.id, context.workspace.workspaceId).map(mapWorkflowState)
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
        return row &&
          (await canDiscoverPostgresTeam(context.persistence, viewer, row)) &&
          apiKeyTeamsWithinLimit(context.auth, [row.id])
          ? (await listPostgresLabels(context.persistence, team.id)).map(mapPostgresLabel)
          : [];
      }
      return canAccessTeam(context.db, viewer, team.id)
        ? scopeWorkspaceRows(
            context,
            listLabels(context.db, team.id, context.workspace.workspaceId),
          ).map(mapLabel)
        : [];
    },
    projects: async (team: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const row = await getPostgresTeam(context.persistence, { id: team.id });
        if (!row || !(await canDiscoverPostgresTeam(context.persistence, viewer, row))) return [];
        const projects = await listPostgresProjects(context.persistence, null, team.id);
        const visible = [];
        for (const project of projects) {
          const teamIds = await listPostgresProjectTeamIds(context.persistence, project.id);
          if (
            (await canAccessPostgresProject(context.persistence, viewer, project.id)) &&
            apiKeyTeamsWithinLimit(context.auth, teamIds)
          ) {
            visible.push(mapPostgresProject(project));
          }
        }
        return visible;
      }
      return listProjects(context.db, null, team.id, false, context.workspace.workspaceId)
        .filter((project) => canAccessProject(context.db, viewer, project.id))
        .filter((project) =>
          apiKeyTeamsWithinLimit(
            context.auth,
            listProjectTeamIds(context.db, project.id, context.workspace.workspaceId),
          ),
        )
        .map(mapProject);
    },
    cycles: async (team: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const row = await getPostgresTeam(context.persistence, { id: team.id });
        return row &&
          (await canDiscoverPostgresTeam(context.persistence, viewer, row)) &&
          apiKeyTeamsWithinLimit(context.auth, [team.id])
          ? (await listPostgresCycles(context.persistence, team.id)).map(mapPostgresCycle)
          : [];
      }
      return canAccessTeam(context.db, viewer, team.id)
        ? listCycles(context.db, team.id, false, context.workspace.workspaceId).map(mapCycle)
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
        ? listTeamMemberships(context.db, team.id, context.workspace.workspaceId).map(
            mapTeamMembership,
          )
        : [];
    },
  },

  Label: {
    workspaceId: (_label: unknown, _args: unknown, context: Context) =>
      context.workspace.workspaceId,
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
    project: async (favorite: { projectId: string | null }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (!favorite.projectId) return null;
      if (context.persistence) {
        const project = await getPostgresProject(context.persistence, favorite.projectId);
        return project &&
          !project.archived_at &&
          (await canAccessPostgresProject(context.persistence, viewer, project.id))
          ? mapPostgresProject(project)
          : null;
      }
      const project = lookupProject(context, favorite.projectId);
      return project && canAccessProject(context.db, viewer, project.id)
        ? mapProject(project)
        : null;
    },
    savedView: async (
      favorite: { savedViewId: string | null },
      _args: unknown,
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      if (!favorite.savedViewId) return null;
      if (context.persistence) {
        const view = await getPostgresSavedView(context.persistence, favorite.savedViewId);
        return view &&
          !view.archived_at &&
          (await canAccessPostgresSavedView(context.persistence, view, viewer))
          ? mapPostgresSavedView(view)
          : null;
      }
      const view = getSavedView(context.db, favorite.savedViewId, context.workspace.workspaceId);
      return view && canAccessSavedView(context.db, view, viewer) ? mapSavedView(view) : null;
    },
  },

  SavedView: {
    team: async (view: { teamId: string | null }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (!view.teamId) return null;
      if (context.persistence) {
        const row = await getPostgresTeam(context.persistence, { id: view.teamId });
        return row && (await canDiscoverPostgresTeam(context.persistence, viewer, row))
          ? mapPostgresTeam(row)
          : null;
      }
      const row = lookupTeam(context, { id: view.teamId });
      return row && canAccessTeam(context.db, viewer, row.id) ? mapTeam(row) : null;
    },
    owner: async (view: { ownerId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, view.ownerId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, view.ownerId)!);
    },
  },

  InboxItem: {
    actor: async (item: { actorId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, item.actorId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, item.actorId)!);
    },
    issue: async (item: { issueId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const issue = await getPostgresIssue(context.persistence, item.issueId);
        if (!issue) return null;
        const team = await getPostgresTeam(context.persistence, { id: issue.team_id });
        return team &&
          (await canDiscoverPostgresTeam(context.persistence, requireViewer(context), team)) &&
          apiKeyTeamsWithinLimit(context.auth, [issue.team_id])
          ? mapIssue(issue)
          : null;
      }
      return mapIssue(lookupIssueById(context, item.issueId)!);
    },
  },

  Cycle: {
    team: async (cycle: { teamId: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const team = await getPostgresTeam(context.persistence, { id: cycle.teamId });
        return team &&
          (await canDiscoverPostgresTeam(context.persistence, viewer, team)) &&
          apiKeyTeamsWithinLimit(context.auth, [team.id])
          ? mapPostgresTeam(team)
          : null;
      }
      const team = lookupTeam(context, { id: cycle.teamId });
      return team && canAccessTeam(context.db, viewer, team.id) ? mapTeam(team) : null;
    },
    progress: async (cycle: { id: string }, _args: unknown, context: Context) =>
      context.persistence
        ? (await postgresCycleProgress(context.persistence, cycle.id)).progress
        : cycleProgress(context.db, cycle.id, context.workspace.workspaceId).progress,
    completedIssues: async (cycle: { id: string }, _args: unknown, context: Context) =>
      context.persistence
        ? (await postgresCycleProgress(context.persistence, cycle.id)).completedIssues
        : cycleProgress(context.db, cycle.id, context.workspace.workspaceId).completedIssues,
    totalIssues: async (cycle: { id: string }, _args: unknown, context: Context) =>
      context.persistence
        ? (await postgresCycleProgress(context.persistence, cycle.id)).totalIssues
        : cycleProgress(context.db, cycle.id, context.workspace.workspaceId).totalIssues,
  },

  Review: {
    issue: async (review: { issueId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const issue = await getPostgresIssue(context.persistence, review.issueId);
        return issue ? mapIssue(issue) : null;
      }
      return mapIssue(lookupIssueById(context, review.issueId)!);
    },
    requester: async (review: { requesterId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, review.requesterId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, review.requesterId)!);
    },
    reviewer: async (review: { reviewerId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, review.reviewerId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, review.reviewerId)!);
    },
  },

  Initiative: {
    projects: async (initiative: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const projects = [];
        for (const projectId of await listPostgresInitiativeProjectIds(
          context.persistence,
          initiative.id,
        )) {
          const project = await getPostgresProject(context.persistence, projectId);
          if (
            project &&
            (await canAccessPostgresProject(context.persistence, viewer, project.id)) &&
            apiKeyTeamsWithinLimit(
              context.auth,
              await listPostgresProjectTeamIds(context.persistence, project.id),
            )
          )
            projects.push(mapPostgresProject(project));
        }
        return projects;
      }
      return listInitiativeProjectIds(context.db, initiative.id, context.workspace.workspaceId)
        .map((projectId) => lookupProject(context, projectId))
        .filter((row) => row && canAccessProject(context.db, viewer, row.id))
        .map((row) => mapProject(row!));
    },
    teams: async (initiative: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const teams = [];
        for (const teamId of await listPostgresInitiativeTeamIds(
          context.persistence,
          initiative.id,
        )) {
          const team = await getPostgresTeam(context.persistence, { id: teamId });
          if (
            team &&
            (viewer.workspace_role === "admin" ||
              (await isPostgresTeamMember(context.persistence, team.id, viewer.id))) &&
            apiKeyTeamsWithinLimit(context.auth, [team.id])
          )
            teams.push(mapPostgresTeam(team));
        }
        return teams;
      }
      return listInitiativeTeamIds(context.db, initiative.id, context.workspace.workspaceId)
        .map((teamId) => lookupTeam(context, { id: teamId }))
        .filter((row) => row && canAccessTeam(context.db, viewer, row.id))
        .map((row) => mapTeam(row!));
    },
    owner: async (initiative: { ownerId: string | null }, _args: unknown, context: Context) => {
      if (!initiative.ownerId) return null;
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, initiative.ownerId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, initiative.ownerId)!);
    },
    progress: async (initiative: { id: string }, _args: unknown, context: Context) =>
      context.persistence
        ? (await postgresInitiativeProgress(context.persistence, initiative.id)).progress
        : initiativeProgress(context.db, initiative.id, context.workspace.workspaceId).progress,
    completedIssues: async (initiative: { id: string }, _args: unknown, context: Context) =>
      context.persistence
        ? (await postgresInitiativeProgress(context.persistence, initiative.id)).completedIssues
        : initiativeProgress(context.db, initiative.id, context.workspace.workspaceId)
            .completedIssues,
    totalIssues: async (initiative: { id: string }, _args: unknown, context: Context) =>
      context.persistence
        ? (await postgresInitiativeProgress(context.persistence, initiative.id)).totalIssues
        : initiativeProgress(context.db, initiative.id, context.workspace.workspaceId).totalIssues,
  },

  ApiKey: {
    workspaceId: (_apiKey: unknown, _args: unknown, context: Context) =>
      context.workspace.workspaceId,
    actor: async (apiKey: { actorId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, apiKey.actorId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, apiKey.actorId)!);
    },
  },

  Actor: {
    workspaceId: (_actor: unknown, _args: unknown, context: Context) =>
      context.workspace.workspaceId,
    apiKeys: async (actor: { id: string }, _args: unknown, context: Context) => {
      const viewer = requireViewer(context);
      if (!isWorkspaceAdmin(viewer) && viewer.id !== actor.id) return [];
      if (context.persistence) {
        return (
          await listPostgresApiKeys(context.persistence, actor.id, context.workspace.workspaceId)
        ).map(mapPostgresApiKey);
      }
      return listApiKeys(context.db, actor.id, false, context.workspace.workspaceId).map((row) =>
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
    workspaceId: (_invitation: unknown, _args: unknown, context: Context) =>
      context.workspace.workspaceId,
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
        return listActorInvitations(
          context.db,
          Boolean(args.includeRevoked),
          context.workspace.workspaceId,
        ).map(mapActorInvitation);
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
        return scopeWorkspaceRows(
          context,
          listTeamMemberships(context.db, args.teamId, context.workspace.workspaceId),
        ).map(mapTeamMembership);
      },
      labels: async (_parent: unknown, args: { team?: string }, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const team = args.team
            ? await getPostgresTeam(context.persistence, { id: args.team })
            : null;
          if (
            args.team &&
            (!team ||
              !(await canDiscoverPostgresTeam(context.persistence, viewer, team)) ||
              !apiKeyTeamsWithinLimit(context.auth, [team.id]))
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
              (await canDiscoverPostgresTeam(context.persistence, viewer, labelTeam)) &&
              apiKeyTeamsWithinLimit(context.auth, [labelTeam.id])
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
          listLabels(
            context.db,
            team?.archived_at ? null : args.team,
            context.workspace.workspaceId,
          ),
        )
          .filter(
            (label) => label.team_id == null || canAccessTeam(context.db, viewer, label.team_id),
          )
          .filter((label) => !team?.archived_at || label.team_id == null)
          .map(mapLabel);
      },
      webhooks: async (_parent: unknown, _args: unknown, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          return (await listPostgresWebhooks(context.persistence, viewer))
            .filter(
              (webhook) =>
                !webhook.team_id || apiKeyTeamsWithinLimit(context.auth, [webhook.team_id]),
            )
            .map((webhook) => mapPostgresWebhook(webhook, context.workspace.workspaceId));
        }
        return listWebhooksInWorkspace(context, viewer).map((webhook) =>
          mapWebhook(webhook, context.workspace.workspaceId),
        );
      },
      savedViews: async (
        _parent: unknown,
        args: { teamId?: string | null; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          if (args.teamId && !apiKeyTeamsWithinLimit(context.auth, [args.teamId])) return [];
          const rows = await listPostgresSavedViews(
            context.persistence,
            viewer,
            args.teamId,
            Boolean(args.includeArchived),
          );
          return rows
            .filter((row) => !row.team_id || apiKeyTeamsWithinLimit(context.auth, [row.team_id]))
            .map(mapPostgresSavedView);
        }
        if (args.teamId) {
          const team = lookupTeam(context, { id: args.teamId });
          if (team?.archived_at && !args.includeArchived) return [];
        }
        return scopeWorkspaceRows(
          context,
          listSavedViews(
            context.db,
            viewer,
            args.teamId,
            Boolean(args.includeArchived),
            context.workspace.workspaceId,
          ),
        ).map(mapSavedView);
      },
      savedView: async (_parent: unknown, args: { id: string }, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const row = await getPostgresSavedView(context.persistence, args.id);
          if (!row || (row.team_id && !apiKeyTeamsWithinLimit(context.auth, [row.team_id]))) {
            return null;
          }
          return (await canAccessPostgresSavedView(context.persistence, row, viewer))
            ? mapPostgresSavedView(row)
            : null;
        }
        const row = getSavedView(context.db, args.id, context.workspace.workspaceId);
        if (!row) return null;
        scopeWorkspaceRow(context, row);
        if (!canAccessSavedView(context.db, row, viewer)) return null;
        return mapSavedView(row);
      },
      favorites: async (_parent: unknown, _args: unknown, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          return (await listPostgresFavorites(context.persistence, viewer)).map(
            mapPostgresFavorite,
          );
        }
        return scopeWorkspaceRows(
          context,
          listFavorites(context.db, viewer, context.workspace.workspaceId),
        ).map(mapFavorite);
      },
      inbox: async (
        _parent: unknown,
        args: { first?: number | null; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          return (
            await listPostgresInboxActivity(
              context.persistence,
              viewer,
              {
                first: args.first ?? 50,
                includeArchived: Boolean(args.includeArchived),
              },
              context.auth?.teamIds,
            )
          ).map(mapPostgresInboxActivity);
        }
        return scopeWorkspaceRows(
          context,
          listInboxActivity(
            context.db,
            viewer,
            {
              first: args.first ?? 50,
              includeArchived: Boolean(args.includeArchived),
            },
            context.workspace.workspaceId,
          ),
        ).map((row) => ({
          ...mapActivity(row),
          issueId: row.issue_id,
          isRead: Boolean(row.is_read),
          isArchived: Boolean(row.is_archived),
        }));
      },
      inboxPage: async (
        _parent: unknown,
        args: { first?: number | null; after?: string | null; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const page = await listPostgresInboxActivityPage(
            context.persistence,
            viewer,
            {
              first: args.first ?? 50,
              after: args.after,
              includeArchived: Boolean(args.includeArchived),
            },
            context.auth?.teamIds,
          );
          return {
            nodes: page.rows.map(mapPostgresInboxActivity),
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
          };
        }
        const page = listInboxActivityPage(
          context.db,
          viewer,
          {
            first: args.first ?? 50,
            after: args.after,
            includeArchived: Boolean(args.includeArchived),
          },
          context.workspace.workspaceId,
        );
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
      inboxUnreadCount: async (_parent: unknown, _args: unknown, context: Context) => {
        const viewer = requireViewer(context);
        return context.persistence
          ? countPostgresUnreadInboxActivity(context.persistence, viewer, context.auth?.teamIds)
          : countUnreadInboxActivity(context.db, viewer, context.workspace.workspaceId);
      },
      cycles: async (
        _parent: unknown,
        args: { teamId: string; includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const team = await getPostgresTeam(context.persistence, { id: args.teamId });
          if (
            !team ||
            !(await canDiscoverPostgresTeam(context.persistence, viewer, team)) ||
            !apiKeyTeamsWithinLimit(context.auth, [args.teamId]) ||
            (team.archived_at && !args.includeArchived)
          )
            return [];
          return (
            await listPostgresCycles(
              context.persistence,
              args.teamId,
              Boolean(args.includeArchived),
            )
          ).map(mapPostgresCycle);
        }
        const team = requireTeam(context, { id: args.teamId });
        if (!canAccessTeam(context.db, viewer, team.id)) return [];
        if (team.archived_at && !args.includeArchived) return [];
        return scopeWorkspaceRows(
          context,
          listCycles(
            context.db,
            args.teamId,
            Boolean(args.includeArchived),
            context.workspace.workspaceId,
          ),
        ).map(mapCycle);
      },
      cycle: async (_parent: unknown, args: { id: string }, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const row = await getPostgresCycle(context.persistence, args.id);
          const team = row ? await getPostgresTeam(context.persistence, { id: row.team_id }) : null;
          return row &&
            team &&
            (await canDiscoverPostgresTeam(context.persistence, viewer, team)) &&
            apiKeyTeamsWithinLimit(context.auth, [row.team_id])
            ? mapPostgresCycle(row)
            : null;
        }
        const row = getCycle(context.db, args.id, context.workspace.workspaceId);
        return row && canAccessTeam(context.db, viewer, row.team_id) ? mapCycle(row) : null;
      },
      reviews: async (
        _parent: unknown,
        args: {
          openOnly?: boolean | null;
          first?: number | null;
          after?: string | null;
          teamId?: string | null;
          projectId?: string | null;
          reviewerId?: string | null;
          olderThanDays?: number | null;
        },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          if (args.teamId) {
            const team = await getPostgresTeam(context.persistence, { id: args.teamId });
            if (team?.archived_at) {
              return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
            }
          }
          // Apply the same team visibility and API-key scope before paginating.
          // This keeps pages and cursors stable when a review is not visible.
          const allowedTeamIds: string[] = [];
          for (const team of await listPostgresTeams(context.persistence, true)) {
            if (
              (await canDiscoverPostgresTeam(context.persistence, viewer, team)) &&
              (await canWritePostgresTeam(context.persistence, viewer, team.id)) &&
              apiKeyTeamsWithinLimit(context.auth, [team.id])
            ) {
              allowedTeamIds.push(team.id);
            }
          }
          const page = await listPostgresReviews(context.persistence, viewer.id, {
            openOnly: Boolean(args.openOnly),
            first: args.first ?? 50,
            after: args.after,
            teamId: args.teamId,
            projectId: args.projectId,
            reviewerId: args.reviewerId,
            olderThanDays: args.olderThanDays,
            teamIds: allowedTeamIds,
          });
          return {
            nodes: page.rows.map(mapPostgresReview),
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
          };
        }
        if (args.teamId) {
          const team = lookupTeam(context, { id: args.teamId });
          if (team?.archived_at) {
            return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
          }
        }
        // La cola se basa en requester/reviewer, pero una key revocada no debe
        // conservar acceso a reviews del Team. Aplicar este filtro antes de
        // paginar evita páginas cortas o cursores que salten recursos ocultos.
        const writableTeamIds = (
          context.db
            .query(
              "SELECT id FROM teams WHERE workspace_id = ?1 OR (workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1) ORDER BY id",
            )
            .all(context.workspace.workspaceId) as Array<{ id: string }>
        )
          .map((row) => row.id)
          .filter((teamId) => canWriteTeam(context.db, viewer, teamId));
        const page = listReviews(context.db, viewer.id, {
          openOnly: Boolean(args.openOnly),
          first: args.first ?? 50,
          after: args.after,
          teamId: args.teamId,
          projectId: args.projectId,
          reviewerId: args.reviewerId,
          olderThanDays: args.olderThanDays,
          teamIds: writableTeamIds,
          workspaceId: context.workspace.workspaceId,
        });
        return {
          nodes: scopeWorkspaceRows(context, page.rows).map(mapReview),
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        };
      },
      review: async (_parent: unknown, args: { id: string }, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const row = await getPostgresReview(context.persistence, args.id);
          if (
            !row ||
            !(await visiblePostgresReview(context, row, viewer)) ||
            (!isWorkspaceAdmin(viewer) &&
              row.reviewer_id !== viewer.id &&
              row.requester_id !== viewer.id)
          ) {
            return null;
          }
          return mapPostgresReview(row);
        }
        const row = getReview(context.db, args.id, context.workspace.workspaceId);
        if (!row) return null;
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
      initiatives: async (
        _parent: unknown,
        args: { includeArchived?: boolean | null },
        context: Context,
      ) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const rows = await listPostgresInitiatives(
            context.persistence,
            Boolean(args.includeArchived),
            viewer,
          );
          const visible = [];
          for (const row of rows) {
            const teamIds = await listPostgresInitiativeScopeTeamIds(context.persistence, row.id);
            if (apiKeyTeamsWithinLimit(context.auth, teamIds))
              visible.push(mapPostgresInitiative(row));
          }
          return visible;
        }
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
      initiative: async (_parent: unknown, args: { id: string }, context: Context) => {
        const viewer = requireViewer(context);
        if (context.persistence) {
          const row = await getPostgresInitiative(context.persistence, args.id);
          if (!row || !(await canAccessPostgresInitiative(context.persistence, viewer, row.id))) {
            return null;
          }
          const teamIds = await listPostgresInitiativeScopeTeamIds(context.persistence, row.id);
          return !context.auth?.teamIds ||
            (teamIds.length > 0 && apiKeyTeamsWithinLimit(context.auth, teamIds))
            ? mapPostgresInitiative(row)
            : null;
        }
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
          if (context.persistence) {
            const team = await getPostgresTeam(context.persistence, { id: args.id });
            if (!team) throw apiError("NOT_FOUND", "Team not found");
            assertWorkspaceAdmin(viewer);
            return {
              success: true,
              team: mapPostgresTeam(await archivePostgresTeam(context.persistence, team.id, true)),
            };
          }
          const scopedTeam = requireTeam(context, { id: args.id });
          assertWorkspaceAdmin(viewer);
          return {
            success: true,
            team: mapTeam(
              archiveTeam(context.db, scopedTeam.id, true, context.workspace.workspaceId),
            ),
          };
        },
        teamUnarchive: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const team = await getPostgresTeam(context.persistence, { id: args.id });
            if (!team) throw apiError("NOT_FOUND", "Team not found");
            assertWorkspaceAdmin(viewer);
            return {
              success: true,
              team: mapPostgresTeam(await archivePostgresTeam(context.persistence, team.id, false)),
            };
          }
          const scopedTeam = requireTeam(context, { id: args.id });
          assertWorkspaceAdmin(viewer);
          return {
            success: true,
            team: mapTeam(
              archiveTeam(context.db, scopedTeam.id, false, context.workspace.workspaceId),
            ),
          };
        },
        teamDelete: async (
          _parent: unknown,
          args: { id: string; confirmation: string },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const team = await getPostgresTeam(context.persistence, { id: args.id });
            if (!team) throw apiError("NOT_FOUND", "Team not found");
            assertWorkspaceAdmin(viewer);
            const owners = (
              await context.persistence.many<{ actor_id: string }>(
                "SELECT actor_id FROM team_memberships WHERE team_id = $1 AND role = 'owner'",
                [team.id],
              )
            ).map((row) => row.actor_id);
            const deleted = await deletePostgresTeam(
              context.persistence,
              team.id,
              args.confirmation,
            );
            context.events.emit("team.deleted", viewer, {
              id: deleted.id,
              key: deleted.key,
              name: deleted.name,
              teamId: deleted.id,
              _teamOwnerIds: owners,
            });
            return { success: true };
          }
          const scopedTeam = requireTeam(context, { id: args.id });
          assertWorkspaceAdmin(viewer);
          const teamOwnerIds = (
            context.db
              .query("SELECT actor_id FROM team_memberships WHERE team_id = ?1 AND role = 'owner'")
              .all(args.id) as Array<{ actor_id: string }>
          ).map((row) => row.actor_id);
          const deleted = deleteTeam(
            context.db,
            scopedTeam.id,
            args.confirmation,
            context.workspace.workspaceId,
          );
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
            context.events.emitForWorkspace(row.id, "workspace.created", viewer, {
              id: row.id,
              name: row.name,
              urlKey: row.url_key,
            });
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
            context.events.emit("team.created", viewer, {
              id: team.id,
              teamId: team.id,
              key: team.key,
              name: team.name,
            });
            return { success: true, team };
          }
          const team = mapTeam(
            createTeam(context.db, args.input, viewer.id, context.workspace.workspaceId),
          );
          context.events.emit("team.created", viewer, {
            id: team.id,
            teamId: team.id,
            key: team.key,
            name: team.name,
          });
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
            if (!apiKeyTeamsWithinLimit(context.auth, [team.id])) {
              throw apiError("NOT_FOUND", "Team resource not found");
            }
            if (
              !isWorkspaceAdmin(viewer) &&
              !(await isPostgresTeamOwner(context.persistence, team.id, viewer.id))
            ) {
              throw apiError("UNAUTHORIZED", "Team owner permission is required");
            }
            await assertPostgresTeamActive(context.persistence, team.id);
            return {
              success: true,
              team: mapPostgresTeam(
                await updatePostgresTeam(context.persistence, team.id, args.input),
              ),
            };
          }
          const scopedTeam = requireTeam(context, { id: args.id });
          assertCanManageTeam(context.db, viewer, scopedTeam.id);
          const team = mapTeam(
            updateTeam(context.db, args.id, args.input, context.workspace.workspaceId),
          );
          return { success: true, team };
        },
        teamMembershipCreate: async (
          _parent: unknown,
          args: { input: { teamId: string; actorId: string; role?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const team = await getPostgresTeam(context.persistence, { id: args.input.teamId });
            if (!team) throw apiError("NOT_FOUND", "Team not found");
            if (!apiKeyTeamsWithinLimit(context.auth, [team.id])) {
              throw apiError("NOT_FOUND", "Team resource not found");
            }
            const membership = await createPostgresTeamMembership(
              context.persistence,
              viewer.id,
              { ...args.input, teamId: team.id },
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
            success: deleteTeamMembership(
              context.db,
              viewer.id,
              args.id,
              isWorkspaceAdmin(viewer),
              context.workspace.workspaceId,
            ),
          };
        },
        actorCreate: async (
          _parent: unknown,
          args: {
            input: { name: string; type: string; email?: string | null; avatarUrl?: string | null };
          },
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
          args: {
            id: string;
            input: { name?: string | null; email?: string | null; avatarUrl?: string | null };
          },
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
          const result = createActorInvitation(
            context.db,
            viewer.id,
            args.input,
            context.workspace.workspaceId,
          );
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
          const result = acceptActorInvitation(
            context.db,
            args.token,
            args.input,
            context.workspace.workspaceId,
          );
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
            invitation: mapActorInvitation(
              revokeActorInvitation(context.db, args.id, context.workspace.workspaceId),
            ),
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
          return {
            success: true,
            actor: mapActor(
              suspendActor(context.db, args.id, viewer.id, context.workspace.workspaceId),
            ),
          };
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
          return {
            success: true,
            actor: mapActor(reactivateActor(context.db, args.id, context.workspace.workspaceId)),
          };
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
          return {
            success: true,
            actor: mapActor(revokeActor(context.db, args.id, context.workspace.workspaceId)),
          };
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
          return {
            success: true,
            actor: mapActor(leaveActor(context.db, actorId, context.workspace.workspaceId)),
          };
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
            const metadata = await postgresApiKeyMetadata(
              context.persistence,
              args.input,
              context.workspace.workspaceId,
            );
            assertChildApiKey(context, target, args.input, metadata);
            const result = await createPostgresApiKey(
              context.persistence,
              args.input,
              context.workspace.workspaceId,
            );
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
            return {
              success: await deletePostgresApiKey(
                context.persistence,
                args.id,
                context.workspace.workspaceId,
              ),
            };
          }
          const key = getApiKey(context.db, args.id);
          assertCanManageApiKey(context.db, viewer, args.id, context.workspace.workspaceId);
          if (key && key.actor_id !== viewer.id) {
            assertApiKeyScope(context, "admin");
            assertUnrestrictedApiKey(context);
          }
          return {
            success: deleteApiKey(context.db, args.id, context.workspace.workspaceId),
          };
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
              await listPostgresApiKeys(
                context.persistence,
                existing.actor_id,
                context.workspace.workspaceId,
              )
            ).find((row) => row.id === existing.id);
            const metadata = await postgresApiKeyMetadata(
              context.persistence,
              {
                ...args.input,
                scopes: args.input.scopes === undefined ? existingView?.scopes : args.input.scopes,
                teamIds:
                  args.input.teamIds === undefined ? existingView?.teamIds : args.input.teamIds,
                expiresAt:
                  args.input.expiresAt === undefined ? existing.expires_at : args.input.expiresAt,
              },
              context.workspace.workspaceId,
            );
            assertChildApiKey(context, target, args.input, metadata);
            const result = await rotatePostgresApiKey(
              context.persistence,
              args.id,
              args.input,
              context.workspace.workspaceId,
            );
            return { success: true, apiKey: mapPostgresApiKey(result.row), key: result.key };
          }
          const existing = getApiKey(context.db, args.id);
          assertCanManageApiKey(context.db, viewer, args.id, context.workspace.workspaceId);
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
        webhookCreate: async (
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
          if (context.persistence) {
            if (args.input.teamId) {
              if (!apiKeyTeamsWithinLimit(context.auth, [args.input.teamId])) {
                throw apiError("NOT_FOUND", "Team resource not found");
              }
              await assertCanCreatePostgresWebhook(context.persistence, viewer, args.input.teamId);
            }
            const { row, secret } = await createPostgresWebhook(
              context.persistence,
              viewer,
              args.input,
            );
            return {
              success: true,
              webhook: mapPostgresWebhook(row, context.workspace.workspaceId),
              secret,
            };
          }
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
          const { row, secret } = createWebhook(
            context.db,
            viewer,
            args.input,
            context.workspace.workspaceId,
          );
          return { success: true, webhook: mapWebhook(row, context.workspace.workspaceId), secret };
        },
        webhookDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            return {
              success: await deletePostgresWebhook(context.persistence, args.id, viewer),
            };
          }
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
            success: deleteWebhook(
              context.db,
              args.id,
              viewer,
              isWorkspaceAdmin(viewer),
              context.workspace.workspaceId,
            ),
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
            const scopedTeam = requireTeam(context, { id: args.input.teamId });
            assertCanManageTeam(context.db, viewer, scopedTeam.id);
          } else {
            assertWorkspaceAdmin(viewer);
          }
          const label = mapLabel(
            createLabel(context.db, args.input, context.workspace.workspaceId),
          );
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
          const existing = getWorkflowState(context.db, args.id, context.workspace.workspaceId);
          if (existing) assertCanManageTeam(context.db, viewer, existing.team_id);
          const state = mapWorkflowState(
            updateWorkflowState(context.db, args.id, args.input, context.workspace.workspaceId),
          );
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
          const existing = getWorkflowState(context.db, args.id, context.workspace.workspaceId);
          if (existing) assertCanManageTeam(context.db, viewer, existing.team_id);
          const affected = context.db
            .query("SELECT id FROM issues WHERE state_id = ?1")
            .all(args.id)
            .map((row) => (row as { id: string }).id);
          const moved = deleteWorkflowState(
            context.db,
            viewer.id,
            args.id,
            args.moveToStateId,
            context.workspace.workspaceId,
          );
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
          const existing = getLabel(context.db, args.id, context.workspace.workspaceId);
          if (existing) {
            if (existing.team_id == null) assertWorkspaceAdmin(viewer);
            else assertCanManageTeam(context.db, viewer, existing.team_id);
          }
          const label = mapLabel(
            updateLabel(context.db, args.id, args.input, context.workspace.workspaceId),
          );
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
          const existing = getLabel(context.db, args.id, context.workspace.workspaceId);
          if (existing) {
            if (existing.team_id == null) assertWorkspaceAdmin(viewer);
            else assertCanManageTeam(context.db, viewer, existing.team_id);
          }
          const affectedIds = context.db
            .query(
              "SELECT issue_id AS id FROM issue_labels WHERE label_id = ?1 AND workspace_id = ?2",
            )
            .all(args.id, context.workspace.workspaceId)
            .map((row) => (row as { id: string }).id);
          const affected = deleteLabel(
            context.db,
            viewer.id,
            args.id,
            context.workspace.workspaceId,
          );
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
            if (!apiKeyTeamsWithinLimit(context.auth, [team.id])) {
              throw apiError("NOT_FOUND", "Team resource not found");
            }
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
                await createPostgresWorkflowState(context.persistence, {
                  ...args.input,
                  teamId: team.id,
                }),
              ),
            };
          }
          const scopedTeam = requireTeam(context, { id: args.input.teamId });
          assertCanManageTeam(context.db, viewer, scopedTeam.id);
          const workflowState = mapWorkflowState(
            createWorkflowState(context.db, args.input, context.workspace.workspaceId),
          );
          return { success: true, workflowState };
        },
        savedViewCreate: async (
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
          if (context.persistence) {
            if (args.input.scope.toLowerCase() === "team" && args.input.teamId) {
              const team = await getPostgresTeam(context.persistence, { id: args.input.teamId });
              if (!team) throw apiError("NOT_FOUND", "Team not found");
              if (!apiKeyTeamsWithinLimit(context.auth, [team.id])) {
                throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
              }
            }
            const savedView = mapPostgresSavedView(
              await createPostgresSavedView(context.persistence, viewer, args.input),
            );
            return { success: true, savedView };
          }
          if (args.input.scope.toLowerCase() === "team" && args.input.teamId) {
            const scopedTeam = requireTeam(context, { id: args.input.teamId });
            assertCanManageIssue(context.db, viewer, scopedTeam.id);
          }
          const savedView = mapSavedView(
            createSavedView(context.db, viewer, args.input, context.workspace.workspaceId),
          );
          return { success: true, savedView };
        },
        savedViewUpdate: async (
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
          if (context.persistence) {
            const existing = await getPostgresSavedView(context.persistence, args.id);
            if (existing?.team_id && !apiKeyTeamsWithinLimit(context.auth, [existing.team_id])) {
              throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
            }
            const savedView = mapPostgresSavedView(
              await updatePostgresSavedView(context.persistence, args.id, viewer, args.input),
            );
            return { success: true, savedView };
          }
          const existing = getSavedView(context.db, args.id, context.workspace.workspaceId);
          if (existing?.team_id && canAccessSavedView(context.db, existing, viewer)) {
            assertTeamActive(context.db, existing.team_id);
            assertCanManageIssue(context.db, viewer, existing.team_id);
          }
          const savedView = mapSavedView(
            updateSavedView(context.db, args.id, viewer, args.input, context.workspace.workspaceId),
          );
          return { success: true, savedView };
        },
        savedViewDuplicate: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const existing = await getPostgresSavedView(context.persistence, args.id);
            if (existing?.team_id && !apiKeyTeamsWithinLimit(context.auth, [existing.team_id])) {
              throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
            }
            const savedView = mapPostgresSavedView(
              await duplicatePostgresSavedView(context.persistence, args.id, viewer),
            );
            return { success: true, savedView };
          }
          const existing = getSavedView(context.db, args.id, context.workspace.workspaceId);
          if (existing?.team_id && canAccessSavedView(context.db, existing, viewer)) {
            assertTeamActive(context.db, existing.team_id);
            assertCanManageIssue(context.db, viewer, existing.team_id);
          }
          const savedView = mapSavedView(
            duplicateSavedView(context.db, args.id, viewer, context.workspace.workspaceId),
          );
          return { success: true, savedView };
        },
        savedViewDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const existing = await getPostgresSavedView(context.persistence, args.id);
            if (existing?.team_id && !apiKeyTeamsWithinLimit(context.auth, [existing.team_id])) {
              throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
            }
            return {
              success: await deletePostgresSavedView(context.persistence, args.id, viewer),
            };
          }
          const existing = getSavedView(context.db, args.id, context.workspace.workspaceId);
          if (existing?.team_id && canAccessSavedView(context.db, existing, viewer)) {
            assertTeamActive(context.db, existing.team_id);
            assertCanManageIssue(context.db, viewer, existing.team_id);
          }
          return {
            success: deleteSavedView(context.db, args.id, viewer, context.workspace.workspaceId),
          };
        },
        favoriteCreate: async (
          _parent: unknown,
          args: { input: { projectId?: string | null; savedViewId?: string | null } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            if (args.input.projectId) {
              const project = await getPostgresProject(context.persistence, args.input.projectId);
              if (project) {
                const teamIds = await listPostgresProjectTeamIds(context.persistence, project.id);
                if (!apiKeyTeamsWithinLimit(context.auth, teamIds)) {
                  throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
                }
              }
            }
            if (args.input.savedViewId) {
              const savedView = await getPostgresSavedView(
                context.persistence,
                args.input.savedViewId,
              );
              if (savedView?.team_id) {
                if (!apiKeyTeamsWithinLimit(context.auth, [savedView.team_id])) {
                  throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
                }
              } else if (hasApiKeyTeamLimit(context.auth)) {
                throw apiError(
                  "UNAUTHORIZED",
                  "A Team-limited API key cannot access an unrestricted operation",
                );
              }
            }
            return {
              success: true,
              favorite: mapPostgresFavorite(
                await createPostgresFavorite(context.persistence, viewer, args.input),
              ),
            };
          }
          if (args.input.projectId) {
            const project = requireProject(context, args.input.projectId);
            if (!canAccessProject(context.db, viewer, project.id)) {
              throw apiError("NOT_FOUND", "Project not found");
            }
          }
          if (args.input.savedViewId) {
            const savedView = getSavedView(
              context.db,
              args.input.savedViewId,
              context.workspace.workspaceId,
            );
            if (!savedView || !canAccessSavedView(context.db, savedView, viewer)) {
              throw apiError("NOT_FOUND", "Saved view not found");
            }
          }
          return {
            success: true,
            favorite: mapFavorite(
              createFavorite(context.db, viewer, args.input, context.workspace.workspaceId),
            ),
          };
        },
        favoriteDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            return {
              success: await deletePostgresFavorite(context.persistence, viewer.id, args.id),
            };
          }
          return {
            success: deleteFavorite(context.db, viewer.id, args.id, context.workspace.workspaceId),
          };
        },
        favoriteReorder: async (
          _parent: unknown,
          args: { id: string; position: number },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            return {
              success: true,
              favorite: mapPostgresFavorite(
                await reorderPostgresFavorite(
                  context.persistence,
                  viewer.id,
                  args.id,
                  args.position,
                ),
              ),
            };
          }
          return {
            success: true,
            favorite: mapFavorite(
              reorderFavorite(
                context.db,
                viewer.id,
                args.id,
                args.position,
                context.workspace.workspaceId,
              ),
            ),
          };
        },
        cycleCreate: async (
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
          if (context.persistence) {
            if (!apiKeyTeamsWithinLimit(context.auth, [args.input.teamId])) {
              throw apiError("NOT_FOUND", "Team resource not found");
            }
            return {
              success: true,
              cycle: mapPostgresCycle(
                await createPostgresCycle(context.persistence, viewer, args.input),
              ),
            };
          }
          const scopedTeam = requireTeam(context, { id: args.input.teamId });
          assertCanManageTeam(context.db, viewer, scopedTeam.id);
          return {
            success: true,
            cycle: mapCycle(createCycle(context.db, args.input, context.workspace.workspaceId)),
          };
        },
        cycleUpdate: async (
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
          if (context.persistence) {
            const existing = await getPostgresCycle(context.persistence, args.id);
            if (existing && !apiKeyTeamsWithinLimit(context.auth, [existing.team_id])) {
              throw apiError("NOT_FOUND", "Cycle resource not found");
            }
            return {
              success: true,
              cycle: mapPostgresCycle(
                await updatePostgresCycle(context.persistence, viewer, args.id, args.input),
              ),
            };
          }
          const existing = getCycle(context.db, args.id, context.workspace.workspaceId);
          if (existing) assertCanManageTeam(context.db, viewer, existing.team_id);
          return {
            success: true,
            cycle: mapCycle(
              updateCycle(context.db, args.id, args.input, context.workspace.workspaceId),
            ),
          };
        },
        cycleDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const existing = await getPostgresCycle(context.persistence, args.id);
            if (existing && !apiKeyTeamsWithinLimit(context.auth, [existing.team_id])) {
              throw apiError("NOT_FOUND", "Cycle resource not found");
            }
            return { success: await deletePostgresCycle(context.persistence, viewer, args.id) };
          }
          const existing = getCycle(context.db, args.id, context.workspace.workspaceId);
          if (existing) assertCanManageTeam(context.db, viewer, existing.team_id);
          const affected = context.db
            .query(
              "SELECT id FROM issues WHERE cycle_id = ?1 AND (workspace_id = ?2 OR (workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1))",
            )
            .all(args.id, context.workspace.workspaceId)
            .map((row) => (row as { id: string }).id);
          const success = deleteCycle(
            context.db,
            viewer.id,
            args.id,
            context.workspace.workspaceId,
          );
          emitBulkIssueUpdates(context, viewer, affected, {
            cycle: { from: args.id, to: null },
          });
          return { success };
        },
        cycleCarryOver: async (
          _parent: unknown,
          args: { fromCycleId: string; toCycleId: string },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const fromCycle = await getPostgresCycle(context.persistence, args.fromCycleId);
            const toCycle = await getPostgresCycle(context.persistence, args.toCycleId);
            if (
              (fromCycle && !apiKeyTeamsWithinLimit(context.auth, [fromCycle.team_id])) ||
              (toCycle && !apiKeyTeamsWithinLimit(context.auth, [toCycle.team_id]))
            ) {
              throw apiError("NOT_FOUND", "Cycle resource not found");
            }
            const movedIssues = await carryOverPostgresCycle(
              context.persistence,
              viewer,
              args.fromCycleId,
              args.toCycleId,
            );
            return { success: true, movedIssues };
          }
          const fromCycle = getCycle(context.db, args.fromCycleId, context.workspace.workspaceId);
          if (fromCycle) assertCanManageTeam(context.db, viewer, fromCycle.team_id);
          const movedIssues = carryOverCycle(
            context.db,
            viewer.id,
            args.fromCycleId,
            args.toCycleId,
            context.workspace.workspaceId,
          );
          return { success: true, movedIssues };
        },
        reviewCreate: async (
          _parent: unknown,
          args: { input: { issueId: string; reviewerId: string } },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const issue = await requirePostgresReviewIssue(context, args.input.issueId);
            await assertPostgresReviewReviewer(context, issue.team_id, args.input.reviewerId);
            return {
              success: true,
              review: mapPostgresReview(
                await createPostgresReview(context.persistence, viewer.id, args.input),
              ),
            };
          }
          const issue = requireIssue(context, args.input.issueId);
          assertCanManageIssue(context.db, viewer, issue.team_id);
          if (args.input.reviewerId) {
            requireActor(context, args.input.reviewerId);
            assertCanAssignToTeam(context.db, viewer, issue.team_id, args.input.reviewerId);
          }
          return {
            success: true,
            review: mapReview(
              createReview(context.db, viewer.id, args.input, context.workspace.workspaceId),
            ),
          };
        },
        reviewUpdate: async (
          _parent: unknown,
          args: {
            id: string;
            input: { status?: string | null; reviewerId?: string | null };
          },
          context: Context,
        ) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const existing = await getPostgresReview(context.persistence, args.id);
            if (existing) {
              const issue = await requirePostgresReviewIssue(context, existing.issue_id);
              if (args.input.reviewerId) {
                await assertPostgresReviewReviewer(context, issue.team_id, args.input.reviewerId);
              }
            }
            return {
              success: true,
              review: mapPostgresReview(
                await updatePostgresReview(
                  context.persistence,
                  args.id,
                  viewer.id,
                  args.input,
                  isWorkspaceAdmin(viewer),
                ),
              ),
            };
          }
          const existing = getReview(context.db, args.id, context.workspace.workspaceId);
          if (existing) {
            const issue = lookupIssueById(context, existing.issue_id);
            assertCanManageIssue(context.db, viewer, issue?.team_id);
            if (args.input.reviewerId) {
              requireActor(context, args.input.reviewerId);
              assertCanAssignToTeam(context.db, viewer, issue!.team_id, args.input.reviewerId);
            }
          }
          return {
            success: true,
            review: mapReview(
              updateReview(
                context.db,
                args.id,
                viewer.id,
                args.input,
                isWorkspaceAdmin(viewer),
                context.workspace.workspaceId,
              ),
            ),
          };
        },
        reviewDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            const existing = await getPostgresReview(context.persistence, args.id);
            if (existing) await requirePostgresReviewIssue(context, existing.issue_id);
            return {
              success: await deletePostgresReview(
                context.persistence,
                args.id,
                viewer.id,
                isWorkspaceAdmin(viewer),
              ),
            };
          }
          const existing = getReview(context.db, args.id, context.workspace.workspaceId);
          if (existing) {
            const issue = lookupIssueById(context, existing.issue_id);
            assertCanManageIssue(context.db, viewer, issue?.team_id);
          }
          return {
            success: deleteReview(
              context.db,
              args.id,
              viewer.id,
              isWorkspaceAdmin(viewer),
              context.workspace.workspaceId,
            ),
          };
        },
        initiativeCreate: async (
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
          if (context.persistence) {
            await assertPostgresInitiativeKeyLimit(
              context,
              null,
              args.input.projectIds,
              args.input.teamIds,
            );
            const initiative = mapPostgresInitiative(
              await createPostgresInitiative(context.persistence, viewer, args.input),
            );
            return { success: true, initiative };
          }
          const initiative = mapInitiative(
            createInitiative(context.db, viewer, args.input, context.workspace.workspaceId),
          );
          return { success: true, initiative };
        },
        initiativeUpdate: async (
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
          if (context.persistence) {
            await assertPostgresInitiativeKeyLimit(
              context,
              args.id,
              args.input.projectIds,
              args.input.teamIds,
            );
            const initiative = mapPostgresInitiative(
              await updatePostgresInitiative(context.persistence, viewer, args.id, args.input),
            );
            return { success: true, initiative };
          }
          const initiative = mapInitiative(
            updateInitiative(
              context.db,
              args.id,
              viewer,
              args.input,
              context.workspace.workspaceId,
            ),
          );
          return { success: true, initiative };
        },
        initiativeDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            await assertPostgresInitiativeKeyLimit(context, args.id);
            const success = await deletePostgresInitiative(context.persistence, viewer, args.id);
            return { success };
          }
          return {
            success: deleteInitiative(context.db, args.id, viewer, context.workspace.workspaceId),
          };
        },
        inboxMarkRead: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            return {
              success: true,
              inboxItem: mapPostgresInboxActivity(
                await markPostgresInboxRead(
                  context.persistence,
                  args.id,
                  viewer,
                  context.auth?.teamIds,
                ),
              ),
            };
          }
          const row = markInboxRead(context.db, args.id, viewer, context.workspace.workspaceId);
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
        inboxArchive: async (_parent: unknown, args: { id: string }, context: Context) => {
          const viewer = requireViewer(context);
          if (context.persistence) {
            return {
              success: true,
              inboxItem: mapPostgresInboxActivity(
                await archivePostgresInboxItem(
                  context.persistence,
                  args.id,
                  viewer,
                  context.auth?.teamIds,
                ),
              ),
            };
          }
          const row = archiveInboxItem(context.db, args.id, viewer, context.workspace.workspaceId);
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
