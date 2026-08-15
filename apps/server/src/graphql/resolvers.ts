// Resolvers raíz del esquema. Se ensamblan por dominio a medida que crece la API.
import { GraphQLScalarType, Kind } from "graphql";
import {
  createActor,
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
import { listProjects, mapProject } from "../domain/projects.ts";

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

  Team: {
    states: (team: { id: string }, _args: unknown, context: Context) =>
      listTeamStates(context.db, team.id).map(mapWorkflowState),
    defaultState: (team: { _row: TeamRow }, _args: unknown, context: Context) =>
      mapWorkflowState(getDefaultState(context.db, team._row)),
    labels: (team: { id: string }, _args: unknown, context: Context) =>
      listLabels(context.db, team.id).map(mapLabel),
    projects: (team: { id: string }, _args: unknown, context: Context) =>
      listProjects(context.db, null, team.id).map(mapProject),
  },

  Issue: issueResolvers.Issue,
  IssueRelation: issueResolvers.IssueRelation,
  Project: projectResolvers.Project,
  Milestone: projectResolvers.Milestone,
  Comment: issueResolvers.Comment,
  Activity: issueResolvers.Activity,

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
    labels: (_parent: unknown, args: { team?: string }, context: Context) => {
      requireViewer(context);
      return listLabels(context.db, args.team).map(mapLabel);
    },
    webhooks: (_parent: unknown, _args: unknown, context: Context) => {
      requireViewer(context);
      return listWebhooks(context.db).map(mapWebhook);
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
      requireViewer(context);
      const team = mapTeam(createTeam(context.db, args.input));
      context.repo?.sync();
      return { success: true, team };
    },
    teamUpdate: (
      _parent: unknown,
      args: { id: string; input: TeamUpdateInput },
      context: Context,
    ) => {
      requireViewer(context);
      const team = mapTeam(updateTeam(context.db, args.id, args.input));
      context.repo?.sync();
      return { success: true, team };
    },
    actorCreate: (
      _parent: unknown,
      args: { input: { name: string; type: string; email?: string | null } },
      context: Context,
    ) => {
      requireViewer(context);
      const actor = mapActor(createActor(context.db, args.input));
      context.repo?.sync();
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
      context.repo?.sync();
      return { success: true, label };
    },
    workflowStateUpdate: (
      _parent: unknown,
      args: { id: string; input: Parameters<typeof updateWorkflowState>[2] },
      context: Context,
    ) => {
      requireViewer(context);
      const state = mapWorkflowState(updateWorkflowState(context.db, args.id, args.input));
      context.repo?.sync();
      return { success: true, workflowState: state };
    },
    workflowStateDelete: (
      _parent: unknown,
      args: { id: string; moveToStateId?: string | null },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      const moved = deleteWorkflowState(context.db, viewer.id, args.id, args.moveToStateId);
      context.repo?.sync();
      return { success: true, movedIssues: moved };
    },
    labelUpdate: (
      _parent: unknown,
      args: { id: string; input: { name?: string | null; color?: string | null } },
      context: Context,
    ) => {
      requireViewer(context);
      const label = mapLabel(updateLabel(context.db, args.id, args.input));
      context.repo?.sync();
      return { success: true, label };
    },
    labelDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      const affected = deleteLabel(context.db, args.id);
      context.repo?.sync();
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
      context.repo?.sync();
      return { success: true, workflowState };
    },
  }),
};
