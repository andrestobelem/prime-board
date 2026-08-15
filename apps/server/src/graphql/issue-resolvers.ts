// Resolvers del dominio issue (AT-134). Se ensamblan en resolvers.ts.
import { getActor, mapActor } from "../domain/actors.ts";
import type { IssueFilter, IssueOrder } from "../domain/filters.ts";
import {
  archiveIssue, createIssue, getIssue, getIssueByRef, identifierOf, listChildren,
  listIssues, mapIssue, slugify, updateIssue,
  type IssueCreateInput, type IssueRow, type IssueUpdateInput,
} from "../domain/issues.ts";
import { listActivity, mapActivity } from "../domain/activity.ts";
import { createComment, listComments, mapComment } from "../domain/comments.ts";
import { listIssueLabels, mapLabel } from "../domain/labels.ts";
import { getMilestone, mapMilestone } from "../domain/milestones.ts";
import { getProject, mapProject } from "../domain/projects.ts";
import { getTeam, listTeamStates, mapTeam, mapWorkflowState } from "../domain/teams.ts";
import type { Context } from "./context.ts";
import { requireViewer } from "./errors.ts";

type MappedIssue = ReturnType<typeof mapIssue>;

/** Forma plana del issue para payloads de webhooks. */
function issueEventData(row: IssueRow) {
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
      mapTeam(getTeam(context.db, { id: issue._row.team_id })!),
    state: (issue: MappedIssue, _args: unknown, context: Context) => {
      const states = listTeamStates(context.db, issue._row.team_id);
      return mapWorkflowState(states.find((state) => state.id === issue._row.state_id)!);
    },
    assignee: (issue: MappedIssue, _args: unknown, context: Context) =>
      issue._row.assignee_id ? mapActor(getActor(context.db, issue._row.assignee_id)!) : null,
    creator: (issue: MappedIssue, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, issue._row.creator_id)!),
    parent: (issue: MappedIssue, _args: unknown, context: Context) => {
      if (!issue._row.parent_id) return null;
      const parent = getIssue(context.db, issue._row.parent_id);
      return parent ? mapIssue(parent) : null;
    },
    children: (issue: MappedIssue, _args: unknown, context: Context) =>
      listChildren(context.db, issue.id).map(mapIssue),
    labels: (issue: MappedIssue, _args: unknown, context: Context) =>
      listIssueLabels(context.db, issue.id).map(mapLabel),
    project: (issue: MappedIssue, _args: unknown, context: Context) =>
      issue._row.project_id ? mapProject(getProject(context.db, issue._row.project_id)!) : null,
    milestone: (issue: MappedIssue, _args: unknown, context: Context) =>
      issue._row.milestone_id ? mapMilestone(getMilestone(context.db, issue._row.milestone_id)!) : null,
    comments: (issue: MappedIssue, _args: unknown, context: Context) =>
      listComments(context.db, issue.id).map(mapComment),
    activity: (issue: MappedIssue, _args: unknown, context: Context) =>
      listActivity(context.db, issue.id).map(mapActivity),
    url: (issue: MappedIssue, _args: unknown, context: Context) =>
      `http://localhost:${context.config.port}/issue/${issue.identifier}`,
    branchName: (issue: MappedIssue, _args: unknown, context: Context) => {
      const row: IssueRow = issue._row;
      const owner = row.assignee_id ? getActor(context.db, row.assignee_id) : null;
      const prefix = slugify(owner?.name ?? "board") || "board";
      const slug = slugify(row.title);
      return `${prefix}/${identifierOf(row).toLowerCase()}${slug ? `-${slug}` : ""}`;
    },
  },

  Comment: {
    actor: (comment: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, comment.actorId)!),
    issue: (comment: { issueId: string }, _args: unknown, context: Context) =>
      mapIssue(getIssue(context.db, comment.issueId)!),
  },

  Activity: {
    actor: (activity: { actorId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, activity.actorId)!),
  },

  Query: {
    issue: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      const row = getIssueByRef(context.db, args.id);
      return row ? mapIssue(row) : null;
    },
    issues: (
      _parent: unknown,
      args: { filter?: IssueFilter; first?: number; after?: string; orderBy?: IssueOrder },
      context: Context,
    ) => {
      requireViewer(context);
      const first = Math.min(Math.max(args.first ?? 50, 1), 250);
      const page = listIssues(context.db, {
        filter: args.filter,
        first,
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
      const row = archiveIssue(context.db, viewer.id, args.id);
      context.events.emit("issue.archived", viewer, issueEventData(row));
      return { success: true, issue: mapIssue(row) };
    },
    commentCreate: (
      _parent: unknown,
      args: { input: { issueId: string; body: string } },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      const row = createComment(context.db, viewer.id, args.input);
      const issue = getIssue(context.db, row.issue_id)!;
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
