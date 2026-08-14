// Resolvers raíz del esquema. Se ensamblan por dominio a medida que crece la API.
import { GraphQLScalarType, Kind } from "graphql";
import {
  createActor, createApiKey, getActor, listActors, mapActor, mapApiKey,
} from "../domain/actors.ts";
import {
  createTeam, createWorkflowState, getTeam, listTeamStates, mapTeam, mapWorkflowState,
  type TeamRow,
} from "../domain/teams.ts";
import type { Context } from "./context.ts";
import { apiError, requireViewer } from "./errors.ts";
import { issueResolvers } from "./issue-resolvers.ts";
import { createLabel, listLabels, mapLabel } from "../domain/labels.ts";

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
    TRIAGE: "triage", BACKLOG: "backlog", UNSTARTED: "unstarted",
    STARTED: "started", COMPLETED: "completed", CANCELED: "canceled",
  },

  Team: {
    states: (team: { id: string }, _args: unknown, context: Context) =>
      listTeamStates(context.db, team.id).map(mapWorkflowState),
    labels: (team: { id: string }, _args: unknown, context: Context) =>
      listLabels(context.db, team.id).map(mapLabel),
  },

  Issue: issueResolvers.Issue,
  Comment: issueResolvers.Comment,
  Activity: issueResolvers.Activity,

  ApiKey: {
    actor: (apiKey: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, apiKey.actorId)!),
  },

  Query: {
    ...issueResolvers.Query,
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
  },

  Mutation: {
    ...issueResolvers.Mutation,
    teamCreate: (
      _parent: unknown,
      args: { input: { name: string; key: string; description?: string | null } },
      context: Context,
    ) => {
      requireViewer(context);
      return { success: true, team: mapTeam(createTeam(context.db, args.input)) };
    },
    actorCreate: (
      _parent: unknown,
      args: { input: { name: string; type: string; email?: string | null } },
      context: Context,
    ) => {
      requireViewer(context);
      return { success: true, actor: mapActor(createActor(context.db, args.input)) };
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
    labelCreate: (
      _parent: unknown,
      args: { input: { name: string; color?: string | null; teamId?: string | null } },
      context: Context,
    ) => {
      requireViewer(context);
      return { success: true, label: mapLabel(createLabel(context.db, args.input)) };
    },
    workflowStateCreate: (
      _parent: unknown,
      args: { input: { teamId: string; name: string; type: string; color?: string | null; position?: number | null } },
      context: Context,
    ) => {
      requireViewer(context);
      return {
        success: true,
        workflowState: mapWorkflowState(createWorkflowState(context.db, args.input)),
      };
    },
  },
};
