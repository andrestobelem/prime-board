// Resolvers del dominio project (AT-137). Se ensamblan en resolvers.ts.
import { getActor, mapActor } from "../domain/actors.ts";
import { listIssues, mapIssue } from "../domain/issues.ts";
import {
  archiveProject, createProject, getProject, listProjects, listProjectTeamIds, mapProject, updateProject,
} from "../domain/projects.ts";
import {
  createMilestone, getMilestone, listMilestones, mapMilestone, updateMilestone,
} from "../domain/milestones.ts";
import { getTeam, mapTeam } from "../domain/teams.ts";
import type { Context } from "./context.ts";
import { requireViewer } from "./errors.ts";

type MappedProject = ReturnType<typeof mapProject>;

export const projectResolvers = {
  Project: {
    lead: (project: MappedProject, _args: unknown, context: Context) =>
      project.leadId ? mapActor(getActor(context.db, project.leadId)!) : null,
    milestones: (project: MappedProject, _args: unknown, context: Context) =>
      listMilestones(context.db, project.id).map(mapMilestone),
    teams: (project: MappedProject, _args: unknown, context: Context) =>
      listProjectTeamIds(context.db, project.id).map((teamId) =>
        mapTeam(getTeam(context.db, { id: teamId })!),
      ),
    issues: (project: MappedProject, args: { first?: number }, context: Context) => {
      const first = Math.min(Math.max(args.first ?? 50, 1), 250);
      const page = listIssues(context.db, { filter: { project: { eq: project.id } }, first });
      return {
        nodes: page.rows.map(mapIssue),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
  },

  Milestone: {
    project: (milestone: { projectId: string }, _args: unknown, context: Context) =>
      mapProject(getProject(context.db, milestone.projectId)!),
    issues: (milestone: { id: string }, args: { first?: number }, context: Context) => {
      const page = listIssues(context.db, {
        filter: { milestone: { eq: milestone.id } },
        first: Math.min(Math.max(args.first ?? 100, 1), 250),
      });
      return {
        nodes: page.rows.map(mapIssue),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
    progress: (milestone: { id: string }, _args: unknown, context: Context) => {
      const row = context.db.query(
        `SELECT count(*) AS total,
                sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END) AS done
         FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
         WHERE issues.milestone_id = ?1 AND issues.archived_at IS NULL`,
      ).get(milestone.id) as { total: number; done: number | null };
      return row.total === 0 ? 0 : (row.done ?? 0) / row.total;
    },
  },

  Query: {
    projects: (
      _parent: unknown,
      args: { state?: string; team?: string; includeArchived?: boolean },
      context: Context,
    ) => {
      requireViewer(context);
      return listProjects(context.db, args.state, args.team, args.includeArchived).map(mapProject);
    },
    project: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      const row = getProject(context.db, args.id);
      return row ? mapProject(row) : null;
    },
  },

  Mutation: {
    projectCreate: (
      _parent: unknown,
      args: { input: Parameters<typeof createProject>[1] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      const project = mapProject(createProject(context.db, args.input));
      context.events.emit("project.created", viewer, project);
      return { success: true, project };
    },
    projectArchive: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      return { success: true, project: mapProject(archiveProject(context.db, args.id, true)) };
    },
    projectUnarchive: (_parent: unknown, args: { id: string }, context: Context) => {
      requireViewer(context);
      return { success: true, project: mapProject(archiveProject(context.db, args.id, false)) };
    },
    milestoneCreate: (
      _parent: unknown,
      args: { input: Parameters<typeof createMilestone>[1] },
      context: Context,
    ) => {
      requireViewer(context);
      return { success: true, milestone: mapMilestone(createMilestone(context.db, args.input)) };
    },
    milestoneUpdate: (
      _parent: unknown,
      args: { id: string; input: Parameters<typeof updateMilestone>[2] },
      context: Context,
    ) => {
      requireViewer(context);
      return { success: true, milestone: mapMilestone(updateMilestone(context.db, args.id, args.input)) };
    },
    projectUpdate: (
      _parent: unknown,
      args: { id: string; input: Parameters<typeof updateProject>[2] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      const project = mapProject(updateProject(context.db, args.id, args.input));
      context.events.emit("project.updated", viewer, project);
      return { success: true, project };
    },
  },
};
