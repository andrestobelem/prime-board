// Resolvers del dominio issue (AT-134). Se ensamblan en resolvers.ts.
import { mapActor } from "../domain/actors.ts";
import type { IssueFilter, IssueOrder } from "../domain/filters.ts";
import {
  archiveIssue,
  createIssue,
  identifierOf,
  mapIssue,
  slugify,
  updateIssue,
  type IssueCreateInput,
  type IssueRow,
  type IssueUpdateInput,
} from "../domain/issues.ts";
import { listActivity, mapActivity } from "../domain/activity.ts";
import { translateActivityRefs, type RefTable } from "../domain/activity-schema.ts";
import { createComment, listComments, mapComment } from "../domain/comments.ts";
import { listIssueLabels, mapLabel } from "../domain/labels.ts";
import { getMilestone, mapMilestone } from "../domain/milestones.ts";
import { mapProject } from "../domain/projects.ts";
import { getCycle, mapCycle } from "../domain/cycles.ts";
import {
  createRelation,
  deleteRelation,
  mapRelation,
  type RelationType,
  type StoredRelationType,
} from "../domain/relations.ts";
import { listTeamStates, mapTeam, mapWorkflowState } from "../domain/teams.ts";
import { assertCanManageIssue, assertCanUseImportFields } from "../auth/permissions.ts";
import type { Context } from "./context.ts";
import {
  lookupActor,
  lookupIssue,
  lookupIssueById,
  lookupProject,
  lookupTeam,
  requireIssue,
  requireActor,
  requireProject,
  requireTeam,
  listChildrenInWorkspace,
  listIssuesInWorkspace,
  listRelationsInWorkspace,
  requireRelation,
} from "../domain/workspace-guards.ts";
import { requireViewer } from "./errors.ts";

type MappedIssue = ReturnType<typeof mapIssue>;

function assertIssueAccess(
  context: Context,
  viewer: ReturnType<typeof requireViewer>,
  ref: string,
) {
  const issue = requireIssue(context, ref);
  assertCanManageIssue(context.db, viewer, issue.team_id);
  return issue;
}

function assertRelationAccess(
  context: Context,
  viewer: ReturnType<typeof requireViewer>,
  id: string,
): void {
  const relation = requireRelation(context, id);
  assertIssueAccess(context, viewer, relation.issue_id);
  assertIssueAccess(context, viewer, relation.related_id);
}

/** Forma plana del issue para payloads de webhooks. */
export function issueEventData(row: IssueRow) {
  return {
    id: row.id,
    identifier: identifierOf(row),
    title: row.title,
    description: row.description,
    priority: row.priority,
    teamId: row.team_id,
    stateId: row.state_id,
    assigneeId: row.assignee_id,
    parentId: row.parent_id,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export const issueResolvers = {
  Issue: {
    team: (issue: MappedIssue, _args: unknown, context: Context) =>
      mapTeam(lookupTeam(context, { id: issue._row.team_id })!),
    state: (issue: MappedIssue, _args: unknown, context: Context) => {
      const states = listTeamStates(context.db, issue._row.team_id);
      return mapWorkflowState(states.find((state) => state.id === issue._row.state_id)!);
    },
    assignee: (issue: MappedIssue, _args: unknown, context: Context) =>
      issue._row.assignee_id ? mapActor(lookupActor(context, issue._row.assignee_id)!) : null,
    creator: (issue: MappedIssue, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, issue._row.creator_id)!),
    parent: (issue: MappedIssue, _args: unknown, context: Context) => {
      if (!issue._row.parent_id) return null;
      const parent = lookupIssueById(context, issue._row.parent_id);
      return parent ? mapIssue(parent) : null;
    },
    children: (issue: MappedIssue, args: { includeArchived?: boolean | null }, context: Context) =>
      listChildrenInWorkspace(context, issue.id, Boolean(args.includeArchived)).map(mapIssue),
    labels: (issue: MappedIssue, _args: unknown, context: Context) =>
      listIssueLabels(context.db, issue.id).map(mapLabel),
    project: (issue: MappedIssue, _args: unknown, context: Context) =>
      issue._row.project_id ? mapProject(lookupProject(context, issue._row.project_id)!) : null,
    milestone: (issue: MappedIssue, _args: unknown, context: Context) =>
      issue._row.milestone_id
        ? mapMilestone(getMilestone(context.db, issue._row.milestone_id)!)
        : null,
    cycle: (issue: MappedIssue, _args: unknown, context: Context) =>
      issue._row.cycle_id ? mapCycle(getCycle(context.db, issue._row.cycle_id)!) : null,
    sortOrder: (issue: MappedIssue) => issue._row.sort_order,
    comments: (issue: MappedIssue, _args: unknown, context: Context) =>
      listComments(context.db, issue.id).map(mapComment),
    relations: (issue: MappedIssue, _args: unknown, context: Context) =>
      listRelationsInWorkspace(context, issue.id).map(mapRelation),
    activity: (issue: MappedIssue, _args: unknown, context: Context) =>
      listActivity(context.db, issue.id).map(mapActivity),
    url: (issue: MappedIssue, _args: unknown, context: Context) =>
      `http://localhost:${context.config.port}/issue/${issue.identifier}`,
    branchName: (issue: MappedIssue, _args: unknown, context: Context) => {
      const row: IssueRow = issue._row;
      const owner = row.assignee_id ? lookupActor(context, row.assignee_id) : null;
      const prefix = slugify(owner?.name ?? "board") || "board";
      const slug = slugify(row.title);
      return `${prefix}/${identifierOf(row).toLowerCase()}${slug ? `-${slug}` : ""}`;
    },
  },

  IssueRelation: {
    relatedIssue: (relation: { _relatedId: string }, _args: unknown, context: Context) =>
      mapIssue(lookupIssueById(context, relation._relatedId)!),
  },

  Comment: {
    actor: (comment: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, comment.actorId)!),
    issue: (comment: { issueId: string }, _args: unknown, context: Context) =>
      mapIssue(lookupIssueById(context, comment.issueId)!),
  },

  Activity: {
    actor: (activity: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(lookupActor(context, activity.actorId)!),
    // Traduce ids a nombres reales antes de mandar el payload al cliente
    // (AT-190): el esquema de referencias (AT-187) es el mismo que usan
    // exporter/importer, solo cambia el resolve — acá consulta la DB en vivo
    // en vez de un lookup pre-armado, porque no hay un export de por medio.
    payload: (
      activity: { type: string; payload: Record<string, unknown> },
      _args: unknown,
      context: Context,
    ) => {
      const queries: Record<RefTable, string> = {
        states: "SELECT name FROM workflow_states WHERE id = ?1",
        actors: "SELECT name FROM actors WHERE id = ?1",
        projects: "SELECT name FROM projects WHERE id = ?1",
        milestones: "SELECT name FROM milestones WHERE id = ?1",
        cycles:
          "SELECT teams.key || '/' || cycles.number AS name FROM cycles " +
          "JOIN teams ON teams.id = cycles.team_id WHERE cycles.id = ?1",
        teams: "SELECT key AS name FROM teams WHERE id = ?1",
        issues:
          "SELECT teams.key || '-' || issues.number AS name FROM issues " +
          "JOIN teams ON teams.id = issues.team_id WHERE issues.id = ?1",
      };
      const resolve = (table: RefTable, value: string): string | undefined =>
        (context.db.query(queries[table]).get(value) as { name: string } | null)?.name;
      return translateActivityRefs(activity.type, activity.payload, resolve);
    },
  },

  Query: {
    issue: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      const row = lookupIssue(context, args.id);
      return row ? mapIssue(row) : null;
    },
    issues: (
      _parent: unknown,
      args: { filter?: IssueFilter; first?: number; after?: string; orderBy?: IssueOrder },
      context: Context,
    ) => {
      requireViewer(context);
      const page = listIssuesInWorkspace(context, {
        filter: args.filter,
        first: args.first ?? 50,
        after: args.after,
        orderBy: args.orderBy,
      });
      return {
        nodes: page.rows.map(mapIssue),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
  },

  Mutation: {
    issueCreate: (_parent: unknown, args: { input: IssueCreateInput }, context: Context) => {
      const viewer = requireViewer(context);
      assertCanUseImportFields(viewer, args.input);
      const team = requireTeam(context, { id: args.input.teamId, key: args.input.teamKey });
      assertCanManageIssue(context.db, viewer, team.id);
      if (args.input.assigneeId) requireActor(context, args.input.assigneeId);
      if (args.input.parentId) requireIssue(context, args.input.parentId);
      if (args.input.projectId) requireProject(context, args.input.projectId);
      if (args.input.creatorId) requireActor(context, args.input.creatorId);
      const row = createIssue(context.db, viewer.id, args.input);
      context.events.emit("issue.created", viewer, issueEventData(row));
      return { success: true, issue: mapIssue(row) };
    },
    issueUpdate: (
      _parent: unknown,
      args: { id: string; input: IssueUpdateInput },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      assertIssueAccess(context, viewer, args.id);
      if (args.input.assigneeId) requireActor(context, args.input.assigneeId);
      if (args.input.parentId) requireIssue(context, args.input.parentId);
      if (args.input.projectId) requireProject(context, args.input.projectId);
      const { row, changes } = updateIssue(context.db, viewer.id, args.id, args.input);
      if (changes.length > 0) {
        const changeMap = Object.fromEntries(
          changes.map((change) => [change.field, { from: change.from, to: change.to }]),
        );
        context.events.emit("issue.updated", viewer, issueEventData(row), changeMap);
      }
      return { success: true, issue: mapIssue(row) };
    },
    issueArchive: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      assertIssueAccess(context, viewer, args.id);
      const row = archiveIssue(context.db, viewer.id, args.id);
      context.events.emit("issue.archived", viewer, issueEventData(row));
      return { success: true, issue: mapIssue(row) };
    },
    issueRelationCreate: (
      _parent: unknown,
      args: { input: { issueId: string; relatedIssueId: string; type: RelationType } },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      assertIssueAccess(context, viewer, args.input.issueId);
      assertIssueAccess(context, viewer, args.input.relatedIssueId);
      const created = createRelation(context.db, viewer.id, args.input);
      const inverse: Record<RelationType, RelationType> = {
        blocks: "blocked_by",
        blocked_by: "blocks",
        related: "related",
        duplicate_of: "duplicated_by",
        duplicated_by: "duplicate_of",
      };
      context.events.emit("issue.updated", viewer, issueEventData(created.issue), {
        relations: {
          from: null,
          to: { type: created.view.type, issue: identifierOf(created.relatedIssue) },
        },
      });
      context.events.emit("issue.updated", viewer, issueEventData(created.relatedIssue), {
        relations: {
          from: null,
          to: { type: inverse[created.view.type], issue: identifierOf(created.issue) },
        },
      });
      return { success: true, relation: mapRelation(created.view) };
    },
    issueRelationDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      assertRelationAccess(context, viewer, args.id);
      const removed = deleteRelation(context.db, viewer.id, args.id);
      const source = lookupIssueById(context, removed.issueId)!;
      const target = lookupIssueById(context, removed.relatedId)!;
      const inverse: Record<StoredRelationType, RelationType> = {
        blocks: "blocked_by",
        related: "related",
        duplicate_of: "duplicated_by",
      };
      context.events.emit("issue.updated", viewer, issueEventData(source), {
        relations: {
          from: { type: removed.type, issue: identifierOf(target) },
          to: null,
        },
      });
      context.events.emit("issue.updated", viewer, issueEventData(target), {
        relations: {
          from: { type: inverse[removed.type], issue: identifierOf(source) },
          to: null,
        },
      });
      return { success: true };
    },
    commentCreate: (
      _parent: unknown,
      args: {
        input: {
          issueId: string;
          body: string;
          createdAt?: string | null;
          authorId?: string | null;
        };
      },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      assertCanUseImportFields(viewer, args.input);
      assertIssueAccess(context, viewer, args.input.issueId);
      if (args.input.authorId) requireActor(context, args.input.authorId);
      const row = createComment(context.db, viewer.id, args.input);
      const issue = lookupIssueById(context, row.issue_id)!;
      context.events.emit("comment.created", viewer, {
        id: row.id,
        issueId: row.issue_id,
        issueIdentifier: identifierOf(issue),
        body: row.body,
        createdAt: row.created_at,
      });
      return { success: true, comment: mapComment(row) };
    },
  },
};
