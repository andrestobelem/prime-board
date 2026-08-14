// Resolvers del dominio issue (AT-134). Se ensamblan en resolvers.ts.
import { getActor, mapActor } from "../domain/actors.ts";
import {
  archiveIssue, createIssue, getIssue, getIssueByRef, identifierOf, listChildren,
  listIssues, mapIssue, slugify, updateIssue,
  type IssueCreateInput, type IssueRow, type IssueUpdateInput, type SimpleIssueFilter,
} from "../domain/issues.ts";
import { listActivity, mapActivity } from "../domain/activity.ts";
import { createComment, listComments, mapComment } from "../domain/comments.ts";
import { listIssueLabels, mapLabel } from "../domain/labels.ts";
import { getProject, mapProject } from "../domain/projects.ts";
import { getTeam, listTeamStates, mapTeam, mapWorkflowState } from "../domain/teams.ts";
import type { Context } from "./context.ts";
import { requireViewer } from "./errors.ts";

type MappedIssue = ReturnType<typeof mapIssue>;

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
      args: { filter?: SimpleIssueFilter; first?: number; after?: string },
      context: Context,
    ) => {
      requireViewer(context);
      const first = Math.min(Math.max(args.first ?? 50, 1), 250);
      const { rows, hasNextPage } = listIssues(context.db, args.filter, first);
      return {
        nodes: rows.map(mapIssue),
        pageInfo: { hasNextPage, endCursor: null },
      };
    },
  },

  Mutation: {
    issueCreate: (_parent: unknown, args: { input: IssueCreateInput }, context: Context) => {
      const viewer = requireViewer(context);
      return { success: true, issue: mapIssue(createIssue(context.db, viewer.id, args.input)) };
    },
    issueUpdate: (
      _parent: unknown,
      args: { id: string; input: IssueUpdateInput },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      const { row } = updateIssue(context.db, viewer.id, args.id, args.input);
      return { success: true, issue: mapIssue(row) };
    },
    issueArchive: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      return { success: true, issue: mapIssue(archiveIssue(context.db, viewer.id, args.id)) };
    },
    commentCreate: (
      _parent: unknown,
      args: { input: { issueId: string; body: string } },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      return { success: true, comment: mapComment(createComment(context.db, viewer.id, args.input)) };
    },
  },
};
