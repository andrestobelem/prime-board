// Resolvers raíz del esquema. Se ensamblan por dominio a medida que crece la API.
import { GraphQLScalarType, Kind } from "graphql";
import {
  createActor,
  updateActor,
  createApiKey,
  deleteApiKey,
  getActor,
  listActors,
  listApiKeys,
  mapActor,
  mapApiKey,
} from "../domain/actors.ts";
import {
  createTeam,
  createWorkflowState,
  getDefaultState,
  getTeam,
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
import { apiError, requireViewer } from "./errors.ts";
import { withRepoSyncDispatch } from "./repo-sync-dispatch.ts";
import { issueResolvers } from "./issue-resolvers.ts";
import { projectResolvers } from "./project-resolvers.ts";
import { createLabel, deleteLabel, listLabels, mapLabel, updateLabel } from "../domain/labels.ts";
import { createWebhook, deleteWebhook, listWebhooks, mapWebhook } from "../domain/webhooks.ts";
import { getProject, listProjects, mapProject } from "../domain/projects.ts";
import {
  createSavedView,
  deleteSavedView,
  duplicateSavedView,
  getSavedView,
  listSavedViews,
  mapSavedView,
  updateSavedView,
} from "../domain/saved-views.ts";
import { archiveInboxItem, listInboxActivity, markInboxRead } from "../domain/inbox.ts";
import { mapActivity } from "../domain/activity.ts";
import { getIssue, mapIssue } from "../domain/issues.ts";
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
  listTeamMemberships,
  mapTeamMembership,
} from "../domain/team-memberships.ts";

// Scalars passthrough: los timestamps viajan como strings ISO-8601 UTC.
const DateTime = new GraphQLScalarType({
  name: "DateTime",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? ast.value : null),
});

const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  serialize: (value) => value,
  parseValue: (value) => value,
});

export const resolvers = {
  DateTime,
  JSON: JSONScalar,
  ActorType: { HUMAN: "human", AGENT: "agent" },
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
      listTeamStates(context.db, team.id).map(mapWorkflowState),
    defaultState: (team: { _row: TeamRow }, _args: unknown, context: Context) =>
      mapWorkflowState(getDefaultState(context.db, team._row)),
    labels: (team: { id: string }, _args: unknown, context: Context) =>
      listLabels(context.db, team.id).map(mapLabel),
    projects: (team: { id: string }, _args: unknown, context: Context) =>
      listProjects(context.db, null, team.id).map(mapProject),
    cycles: (team: { id: string }, _args: unknown, context: Context) =>
      listCycles(context.db, team.id).map(mapCycle),
    memberships: (team: { id: string }, _args: unknown, context: Context) =>
      listTeamMemberships(context.db, team.id).map(mapTeamMembership),
  },

  TeamMembership: {
    team: (membership: { teamId: string }, _args: unknown, context: Context) =>
      mapTeam(getTeam(context.db, { id: membership.teamId })!),
    actor: (membership: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, membership.actorId)!),
  },

  Issue: issueResolvers.Issue,
  IssueRelation: issueResolvers.IssueRelation,
  Project: projectResolvers.Project,
  ProjectStatusUpdate: projectResolvers.ProjectStatusUpdate,
  ProjectUpdateHealth: projectResolvers.ProjectUpdateHealth,
  Milestone: projectResolvers.Milestone,
  Comment: issueResolvers.Comment,
  Activity: issueResolvers.Activity,

  SavedView: {
    team: (view: { teamId: string | null }, _args: unknown, context: Context) => {
      if (!view.teamId) return null;
      const row = getTeam(context.db, { id: view.teamId });
      return row ? mapTeam(row) : null;
    },
    owner: (view: { ownerId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, view.ownerId)!),
  },

  InboxItem: {
    actor: (item: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, item.actorId)!),
    issue: (item: { issueId: string }, _args: unknown, context: Context) =>
      mapIssue(getIssue(context.db, item.issueId)!),
  },

  Cycle: {
    team: (cycle: { teamId: string }, _args: unknown, context: Context) =>
      mapTeam(getTeam(context.db, { id: cycle.teamId })!),
    progress: (cycle: { id: string }, _args: unknown, context: Context) =>
      cycleProgress(context.db, cycle.id).progress,
    completedIssues: (cycle: { id: string }, _args: unknown, context: Context) =>
      cycleProgress(context.db, cycle.id).completedIssues,
    totalIssues: (cycle: { id: string }, _args: unknown, context: Context) =>
      cycleProgress(context.db, cycle.id).totalIssues,
  },

  Review: {
    issue: (review: { issueId: string }, _args: unknown, context: Context) =>
      mapIssue(getIssue(context.db, review.issueId)!),
    requester: (review: { requesterId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, review.requesterId)!),
    reviewer: (review: { reviewerId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, review.reviewerId)!),
  },

  Initiative: {
    projects: (initiative: { id: string }, _args: unknown, context: Context) =>
      listInitiativeProjectIds(context.db, initiative.id)
        .map((projectId) => getProject(context.db, projectId))
        .filter(Boolean)
        .map((row) => mapProject(row!)),
    teams: (initiative: { id: string }, _args: unknown, context: Context) =>
      listInitiativeTeamIds(context.db, initiative.id)
        .map((teamId) => getTeam(context.db, { id: teamId }))
        .filter(Boolean)
        .map((row) => mapTeam(row!)),
    owner: (initiative: { ownerId: string | null }, _args: unknown, context: Context) =>
      initiative.ownerId ? mapActor(getActor(context.db, initiative.ownerId)!) : null,
    progress: (initiative: { id: string }, _args: unknown, context: Context) =>
      initiativeProgress(context.db, initiative.id).progress,
    completedIssues: (initiative: { id: string }, _args: unknown, context: Context) =>
      initiativeProgress(context.db, initiative.id).completedIssues,
    totalIssues: (initiative: { id: string }, _args: unknown, context: Context) =>
      initiativeProgress(context.db, initiative.id).totalIssues,
  },

  ApiKey: {
    actor: (apiKey: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, apiKey.actorId)!),
  },

  Actor: {
    apiKeys: (actor: { id: string }, _args: unknown, context: Context) =>
      listApiKeys(context.db, actor.id).map(mapApiKey),
  },

  Query: {
    ...issueResolvers.Query,
    ...projectResolvers.Query,
    viewer: (_parent: unknown, _args: unknown, context: Context) =>
      mapActor(requireViewer(context)),
    workspace: (_parent: unknown, _args: unknown, context: Context) => {
      requireViewer(context);
      const row = context.db
        .query("SELECT id, name, url_key, created_at FROM workspace LIMIT 1")
        .get() as { id: string; name: string; url_key: string; created_at: string } | null;
      if (!row) throw apiError("NOT_FOUND", "Workspace is not initialized");
      return { id: row.id, name: row.name, urlKey: row.url_key, createdAt: row.created_at };
    },
    teams: (_parent: unknown, _args: unknown, context: Context) => {
      requireViewer(context);
      const rows = context.db.query("SELECT * FROM teams ORDER BY created_at").all() as TeamRow[];
      return rows.map(mapTeam);
    },
    team: (_parent: unknown, args: { id?: string; key?: string }, context: Context) => {
      requireViewer(context);
      const row = getTeam(context.db, args);
      return row ? mapTeam(row) : null;
    },
    actors: (_parent: unknown, args: { type?: string }, context: Context) => {
      requireViewer(context);
      return listActors(context.db, args.type).map(mapActor);
    },
    teamMemberships: (_parent: unknown, args: { teamId: string }, context: Context) => {
      requireViewer(context);
      return listTeamMemberships(context.db, args.teamId).map(mapTeamMembership);
    },
    labels: (_parent: unknown, args: { team?: string }, context: Context) => {
      requireViewer(context);
      return listLabels(context.db, args.team).map(mapLabel);
    },
    webhooks: (_parent: unknown, _args: unknown, context: Context) => {
      requireViewer(context);
      return listWebhooks(context.db).map(mapWebhook);
    },
    savedViews: (
      _parent: unknown,
      args: { teamId?: string | null; includeArchived?: boolean | null },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      return listSavedViews(context.db, viewer.id, args.teamId, Boolean(args.includeArchived)).map(
        mapSavedView,
      );
    },
    savedView: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      const row = getSavedView(context.db, args.id);
      if (!row) return null;
      if (row.scope === "personal" && row.owner_id !== viewer.id) return null;
      return mapSavedView(row);
    },
    inbox: (
      _parent: unknown,
      args: { first?: number | null; includeArchived?: boolean | null },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      return listInboxActivity(context.db, viewer.id, {
        first: args.first ?? 50,
        includeArchived: Boolean(args.includeArchived),
      }).map((row) => ({
        ...mapActivity(row),
        issueId: row.issue_id,
        isRead: Boolean(row.is_read),
        isArchived: Boolean(row.is_archived),
      }));
    },
    cycles: (
      _parent: unknown,
      args: { teamId: string; includeArchived?: boolean | null },
      context: Context,
    ) => {
      requireViewer(context);
      return listCycles(context.db, args.teamId, Boolean(args.includeArchived)).map(mapCycle);
    },
    cycle: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      const row = getCycle(context.db, args.id);
      return row ? mapCycle(row) : null;
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
      return listReviews(context.db, viewer.id, {
        openOnly: Boolean(args.openOnly),
        first: args.first ?? 50,
        teamId: args.teamId,
        projectId: args.projectId,
        reviewerId: args.reviewerId,
        olderThanDays: args.olderThanDays,
      }).map(mapReview);
    },
    review: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      const row = getReview(context.db, args.id);
      if (!row) return null;
      if (row.reviewer_id !== viewer.id && row.requester_id !== viewer.id) return null;
      return mapReview(row);
    },
    initiatives: (
      _parent: unknown,
      args: { includeArchived?: boolean | null },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      return listInitiatives(context.db, Boolean(args.includeArchived), viewer.id).map(
        mapInitiative,
      );
    },
    initiative: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      const row = getInitiative(context.db, args.id);
      return row && canViewInitiative(context.db, row.id, viewer.id) ? mapInitiative(row) : null;
    },
  },

  // El resolver map entero pasa por el despacho de sync (AT-191): cualquier
  // mutation nueva que no llame a mano a repo?.sync()/syncIssue() igual queda
  // sincronizada, salvo que esté en SYNC_EXCLUDED_MUTATIONS.
  Mutation: withRepoSyncDispatch({
    ...issueResolvers.Mutation,
    ...projectResolvers.Mutation,
    teamCreate: (
      _parent: unknown,
      args: { input: { name: string; key: string; description?: string | null } },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      const team = mapTeam(createTeam(context.db, args.input, viewer.id));
      return { success: true, team };
    },
    teamUpdate: (
      _parent: unknown,
      args: { id: string; input: TeamUpdateInput },
      context: Context,
    ) => {
      requireViewer(context);
      const team = mapTeam(updateTeam(context.db, args.id, args.input));
      return { success: true, team };
    },
    teamMembershipCreate: (
      _parent: unknown,
      args: { input: { teamId: string; actorId: string; role?: string | null } },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      return {
        success: true,
        membership: mapTeamMembership(createTeamMembership(context.db, viewer.id, args.input)),
      };
    },
    teamMembershipDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      return { success: deleteTeamMembership(context.db, viewer.id, args.id) };
    },
    actorCreate: (
      _parent: unknown,
      args: { input: { name: string; type: string; email?: string | null } },
      context: Context,
    ) => {
      requireViewer(context);
      const actor = mapActor(createActor(context.db, args.input));
      return { success: true, actor };
    },
    actorUpdate: (
      _parent: unknown,
      args: { id: string; input: { name?: string | null; email?: string | null } },
      context: Context,
    ) => {
      requireViewer(context);
      const actor = mapActor(updateActor(context.db, args.id, args.input));
      return { success: true, actor };
    },
    apiKeyCreate: (
      _parent: unknown,
      args: { input: { actorId: string; name: string } },
      context: Context,
    ) => {
      requireViewer(context);
      const { row, key } = createApiKey(context.db, args.input);
      return { success: true, apiKey: mapApiKey(row), key };
    },
    apiKeyDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      return { success: deleteApiKey(context.db, args.id) };
    },
    webhookCreate: (
      _parent: unknown,
      args: { input: { url: string; secret?: string | null; events?: string[] | null } },
      context: Context,
    ) => {
      requireViewer(context);
      const { row, secret } = createWebhook(context.db, args.input);
      return { success: true, webhook: mapWebhook(row), secret };
    },
    webhookDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      return { success: deleteWebhook(context.db, args.id) };
    },
    labelCreate: (
      _parent: unknown,
      args: { input: { name: string; color?: string | null; teamId?: string | null } },
      context: Context,
    ) => {
      requireViewer(context);
      const label = mapLabel(createLabel(context.db, args.input));
      return { success: true, label };
    },
    workflowStateUpdate: (
      _parent: unknown,
      args: { id: string; input: Parameters<typeof updateWorkflowState>[2] },
      context: Context,
    ) => {
      requireViewer(context);
      const state = mapWorkflowState(updateWorkflowState(context.db, args.id, args.input));
      return { success: true, workflowState: state };
    },
    workflowStateDelete: (
      _parent: unknown,
      args: { id: string; moveToStateId?: string | null },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      const moved = deleteWorkflowState(context.db, viewer.id, args.id, args.moveToStateId);
      return { success: true, movedIssues: moved };
    },
    labelUpdate: (
      _parent: unknown,
      args: { id: string; input: { name?: string | null; color?: string | null } },
      context: Context,
    ) => {
      requireViewer(context);
      const label = mapLabel(updateLabel(context.db, args.id, args.input));
      return { success: true, label };
    },
    labelDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      const affected = deleteLabel(context.db, args.id);
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
      requireViewer(context);
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
      const savedView = mapSavedView(updateSavedView(context.db, args.id, viewer.id, args.input));
      return { success: true, savedView };
    },
    savedViewDuplicate: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      const savedView = mapSavedView(duplicateSavedView(context.db, args.id, viewer.id));
      return { success: true, savedView };
    },
    savedViewDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      return { success: deleteSavedView(context.db, args.id, viewer.id) };
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
      requireViewer(context);
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
      requireViewer(context);
      return { success: true, cycle: mapCycle(updateCycle(context.db, args.id, args.input)) };
    },
    cycleDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      return { success: deleteCycle(context.db, args.id) };
    },
    cycleCarryOver: (
      _parent: unknown,
      args: { fromCycleId: string; toCycleId: string },
      context: Context,
    ) => {
      requireViewer(context);
      const movedIssues = carryOverCycle(context.db, args.fromCycleId, args.toCycleId);
      return { success: true, movedIssues };
    },
    reviewCreate: (
      _parent: unknown,
      args: { input: { issueId: string; reviewerId: string } },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      return { success: true, review: mapReview(createReview(context.db, viewer.id, args.input)) };
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
      return {
        success: true,
        review: mapReview(updateReview(context.db, args.id, viewer.id, args.input)),
      };
    },
    reviewDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      return { success: deleteReview(context.db, args.id, viewer.id) };
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
  }),
};
