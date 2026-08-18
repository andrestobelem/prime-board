// Resolvers del dominio project (AT-137). Se ensamblan en resolvers.ts.
import { getActor, mapActor } from "../domain/actors.ts";
import { getIssue, listIssues, mapIssue } from "../domain/issues.ts";
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  listProjectTeamIds,
  mapProject,
  updateProject,
} from "../domain/projects.ts";
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestones,
  mapMilestone,
  updateMilestone,
} from "../domain/milestones.ts";
import {
  createProjectUpdate,
  deleteProjectUpdate,
  getProjectUpdate,
  listProjectUpdates,
  mapProjectUpdate,
} from "../domain/project-updates.ts";
import { getTeam, mapTeam } from "../domain/teams.ts";
import type { Context } from "./context.ts";
import { issueEventData } from "./issue-resolvers.ts";
import { requireViewer } from "./errors.ts";
import {
  assertCanCreateProject,
  assertCanManageProject,
  assertCanManageProjectTeams,
} from "../auth/permissions.ts";

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
    issues: (
      project: MappedProject,
      args: { first?: number; after?: string | null },
      context: Context,
    ) => {
      const first = Math.min(Math.max(args.first ?? 50, 1), 250);
      const page = listIssues(context.db, {
        filter: { project: { eq: project.id } },
        first,
        after: args.after,
      });
      return {
        nodes: page.rows.map(mapIssue),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
    updates: (project: MappedProject, _args: unknown, context: Context) =>
      listProjectUpdates(context.db, project.id).map(mapProjectUpdate),
  },

  ProjectStatusUpdate: {
    project: (update: { projectId: string }, _args: unknown, context: Context) =>
      mapProject(getProject(context.db, update.projectId)!),
    author: (update: { authorId: string }, _args: unknown, context: Context) =>
      mapActor(getActor(context.db, update.authorId)!),
  },

  ProjectUpdateHealth: {
    ON_TRACK: "on_track",
    AT_RISK: "at_risk",
    OFF_TRACK: "off_track",
  },

  Milestone: {
    project: (milestone: { projectId: string }, _args: unknown, context: Context) =>
      mapProject(getProject(context.db, milestone.projectId)!),
    issues: (
      milestone: { id: string },
      args: { first?: number; after?: string | null },
      context: Context,
    ) => {
      const page = listIssues(context.db, {
        filter: { milestone: { eq: milestone.id } },
        first: Math.min(Math.max(args.first ?? 100, 1), 250),
        after: args.after,
      });
      return {
        nodes: page.rows.map(mapIssue),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
    progress: (milestone: { id: string }, _args: unknown, context: Context) => {
      const row = context.db
        .query(
          `SELECT count(*) AS total,
                sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END) AS done
         FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
         WHERE issues.milestone_id = ?1 AND issues.archived_at IS NULL`,
        )
        .get(milestone.id) as { total: number; done: number | null };
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
      if (args.team) {
        const team = getTeam(context.db, { id: args.team });
        if (team?.archived_at && !args.includeArchived) return [];
      }
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
      assertCanCreateProject(context.db, viewer, args.input.teamIds);
      const project = mapProject(createProject(context.db, args.input));
      context.events.emit("project.created", viewer, project);
      return { success: true, project };
    },
    milestoneDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      const milestone = getMilestone(context.db, args.id);
      if (milestone) assertCanManageProject(context.db, viewer, milestone.project_id);
      const affected = context.db
        .query("SELECT id FROM issues WHERE milestone_id = ?1")
        .all(args.id)
        .map((row) => (row as { id: string }).id);
      const orphaned = deleteMilestone(context.db, viewer.id, args.id);
      for (const issueId of affected) {
        const issue = getIssue(context.db, issueId);
        if (issue) {
          context.events.emit("issue.updated", viewer, issueEventData(issue), {
            milestone: { from: args.id, to: null },
          });
        }
      }
      return { success: true, orphanedIssues: orphaned };
    },
    projectArchive: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      assertCanManageProject(context.db, viewer, args.id);
      const archived = mapProject(archiveProject(context.db, args.id, true));
      return { success: true, project: archived };
    },
    projectUnarchive: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      assertCanManageProject(context.db, viewer, args.id);
      const restored = mapProject(archiveProject(context.db, args.id, false));
      return { success: true, project: restored };
    },
    milestoneCreate: (
      _parent: unknown,
      args: { input: Parameters<typeof createMilestone>[1] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      assertCanManageProject(context.db, viewer, args.input.projectId);
      const created = mapMilestone(createMilestone(context.db, args.input));
      return { success: true, milestone: created };
    },
    milestoneUpdate: (
      _parent: unknown,
      args: { id: string; input: Parameters<typeof updateMilestone>[2] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      const milestone = getMilestone(context.db, args.id);
      if (milestone) assertCanManageProject(context.db, viewer, milestone.project_id);
      const updated = mapMilestone(updateMilestone(context.db, args.id, args.input));
      return { success: true, milestone: updated };
    },
    projectUpdate: (
      _parent: unknown,
      args: { id: string; input: Parameters<typeof updateProject>[2] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      assertCanManageProject(context.db, viewer, args.id);
      if (args.input.teamIds !== undefined && args.input.teamIds !== null) {
        assertCanManageProjectTeams(context.db, viewer, args.input.teamIds);
      }
      const project = mapProject(updateProject(context.db, args.id, args.input));
      context.events.emit("project.updated", viewer, project);
      return { success: true, project };
    },
    projectUpdateCreate: (
      _parent: unknown,
      args: {
        input: {
          projectId: string;
          health: string;
          body: string;
          risks?: string | null;
        };
      },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      assertCanManageProject(context.db, viewer, args.input.projectId);
      const projectUpdate = mapProjectUpdate(
        createProjectUpdate(context.db, viewer.id, args.input),
      );
      context.events.emit("project.updated", viewer, {
        id: args.input.projectId,
        updateId: projectUpdate.id,
        health: projectUpdate.health,
        body: projectUpdate.body,
      });
      return { success: true, projectUpdate };
    },
    projectUpdateDelete: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      const projectUpdate = getProjectUpdate(context.db, args.id);
      if (projectUpdate) assertCanManageProject(context.db, viewer, projectUpdate.project_id);
      return { success: deleteProjectUpdate(context.db, args.id) };
    },
  },
};
