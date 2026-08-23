// Resolvers del dominio project (AT-137). Se ensamblan en resolvers.ts.
import { mapActor } from "../domain/actors.ts";
import { mapIssue } from "../domain/issues.ts";
import {
  archiveProject,
  createProject,
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
import { mapTeam } from "../domain/teams.ts";
import type { Context } from "./context.ts";
import {
  lookupActor,
  lookupIssueById,
  lookupProject,
  lookupTeam,
  requireActor,
  requireProject,
  requireTeam,
  listIssuesInWorkspace,
  scopeWorkspaceRows,
} from "../domain/workspace-guards.ts";
import { issueEventData } from "./issue-resolvers.ts";
import { getPostgresActor, mapPostgresActor } from "../domain/postgres-actors.ts";
import { listPostgresIssues } from "../domain/postgres-issues.ts";
import {
  getPostgresProject,
  listPostgresProjectMilestones,
  listPostgresProjectTeamIds,
  listPostgresProjectUpdates,
  mapPostgresProject,
} from "../domain/postgres-planning.ts";
import {
  canDiscoverPostgresTeam,
  getPostgresTeam,
  mapPostgresTeam,
} from "../domain/postgres-teams.ts";
import { requireViewer } from "./errors.ts";
import { documentResolvers } from "./document-resolvers.ts";
import {
  assertCanCreateProject,
  assertCanManageProject,
  assertCanManageProjectTeams,
  apiKeyTeamsWithinLimit,
  canAccessProject,
  canAccessTeam,
  accessibleTeamIds,
} from "../auth/permissions.ts";

type MappedProject = ReturnType<typeof mapProject>;

function projectTeamsAllowed(context: Context, projectId: string): boolean {
  const viewer = requireViewer(context);
  const teamIds = listProjectTeamIds(context.db, projectId);
  return (
    canAccessProject(context.db, viewer, projectId) && apiKeyTeamsWithinLimit(context.auth, teamIds)
  );
}

export const projectResolvers = {
  Project: {
    lead: async (project: MappedProject, _args: unknown, context: Context) => {
      if (!project.leadId) return null;
      if (context.persistence) {
        const actor = await getPostgresActor(context.persistence, project.leadId);
        return actor ? mapPostgresActor(actor) : null;
      }
      return mapActor(lookupActor(context, project.leadId)!);
    },
    milestones: async (project: MappedProject, _args: unknown, context: Context) => {
      if (context.persistence) {
        const teamIds = await listPostgresProjectTeamIds(context.persistence, project.id);
        if (!teamIds.length) return [];
        const rows = await listPostgresProjectMilestones(context.persistence, project.id);
        return rows.map((row) => mapMilestone(row as never));
      }
      return projectTeamsAllowed(context, project.id)
        ? listMilestones(context.db, project.id).map(mapMilestone)
        : [];
    },
    teams: async (project: MappedProject, _args: unknown, context: Context) => {
      if (context.persistence) {
        const viewer = requireViewer(context);
        const ids = await listPostgresProjectTeamIds(context.persistence, project.id);
        const rows = await Promise.all(
          ids.map((id) => getPostgresTeam(context.persistence!, { id })),
        );
        const visible = await Promise.all(
          rows.map(async (row) =>
            row &&
            (await canDiscoverPostgresTeam(context.persistence!, viewer, row)) &&
            apiKeyTeamsWithinLimit(context.auth, [row.id])
              ? mapPostgresTeam(row)
              : null,
          ),
        );
        return visible.filter((row): row is NonNullable<typeof row> => row !== null);
      }
      return listProjectTeamIds(context.db, project.id)
        .filter((teamId) => canAccessTeam(context.db, requireViewer(context), teamId))
        .filter((teamId) => apiKeyTeamsWithinLimit(context.auth, [teamId]))
        .map((teamId) => mapTeam(lookupTeam(context, { id: teamId })!));
    },
    issues: async (
      project: MappedProject,
      args: { first?: number; after?: string | null },
      context: Context,
    ) => {
      const first = Math.min(Math.max(args.first ?? 50, 1), 250);
      if (context.persistence) {
        const teamIds = await listPostgresProjectTeamIds(context.persistence, project.id);
        const viewer = requireViewer(context);
        const visibleTeamIds: string[] = [];
        for (const teamId of teamIds) {
          const team = await getPostgresTeam(context.persistence, { id: teamId });
          if (
            team &&
            (await canDiscoverPostgresTeam(context.persistence, viewer, team)) &&
            apiKeyTeamsWithinLimit(context.auth, [teamId])
          ) {
            visibleTeamIds.push(teamId);
          }
        }
        const page = await listPostgresIssues(context.persistence, {
          filter: { project: { eq: project.id } },
          first,
          after: args.after,
          teamIds: visibleTeamIds,
        });
        return {
          nodes: page.rows.map(mapIssue),
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        };
      }
      if (!projectTeamsAllowed(context, project.id)) {
        return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      }
      const page = listIssuesInWorkspace(context, {
        filter: { project: { eq: project.id } },
        first,
        after: args.after,
        teamIds: accessibleTeamIds(context.db, requireViewer(context)),
      });
      return {
        nodes: page.rows.map(mapIssue),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
    updates: async (project: MappedProject, _args: unknown, context: Context) => {
      if (context.persistence) {
        const rows = await listPostgresProjectUpdates(context.persistence, project.id);
        return rows.map((row) => mapProjectUpdate(row as never));
      }
      return projectTeamsAllowed(context, project.id)
        ? listProjectUpdates(context.db, project.id).map(mapProjectUpdate)
        : [];
    },
    documents: (project: MappedProject, args: { includeArchived?: boolean }, context: Context) =>
      documentResolvers.Query.documents(
        null,
        { projectId: project.id, includeArchived: Boolean(args.includeArchived) },
        context,
      ),
  },

  ProjectStatusUpdate: {
    project: async (update: { projectId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const project = await getPostgresProject(context.persistence, update.projectId);
        return project ? mapPostgresProject(project) : null;
      }
      const project = lookupProject(context, update.projectId);
      return project && projectTeamsAllowed(context, project.id) ? mapProject(project) : null;
    },
    author: async (update: { authorId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const author = await getPostgresActor(context.persistence, update.authorId);
        return author ? mapPostgresActor(author) : null;
      }
      return mapActor(lookupActor(context, update.authorId)!);
    },
  },

  ProjectUpdateHealth: {
    ON_TRACK: "on_track",
    AT_RISK: "at_risk",
    OFF_TRACK: "off_track",
  },

  Milestone: {
    project: async (milestone: { projectId: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const project = await getPostgresProject(context.persistence, milestone.projectId);
        return project ? mapPostgresProject(project) : null;
      }
      const project = lookupProject(context, milestone.projectId);
      return project && projectTeamsAllowed(context, project.id) ? mapProject(project) : null;
    },
    issues: async (
      milestone: { id: string },
      args: { first?: number; after?: string | null },
      context: Context,
    ) => {
      if (context.persistence) {
        const milestoneRow = await context.persistence.one<{ project_id: string }>(
          "SELECT project_id FROM milestones WHERE id = $1",
          [milestone.id],
        );
        if (!milestoneRow) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        const teamIds = await listPostgresProjectTeamIds(
          context.persistence,
          milestoneRow.project_id,
        );
        const page = await listPostgresIssues(context.persistence, {
          filter: { milestone: { eq: milestone.id } },
          first: Math.min(Math.max(args.first ?? 100, 1), 250),
          after: args.after,
          teamIds,
        });
        return {
          nodes: page.rows.map(mapIssue),
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        };
      }
      const milestoneRow = getMilestone(context.db, milestone.id);
      if (!milestoneRow || !projectTeamsAllowed(context, milestoneRow.project_id)) {
        return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      }
      const page = listIssuesInWorkspace(context, {
        filter: { milestone: { eq: milestone.id } },
        first: Math.min(Math.max(args.first ?? 100, 1), 250),
        after: args.after,
        teamIds: accessibleTeamIds(context.db, requireViewer(context)),
      });
      return {
        nodes: page.rows.map(mapIssue),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
    progress: async (milestone: { id: string }, _args: unknown, context: Context) => {
      if (context.persistence) {
        const row = await context.persistence.one<{ total: number; done: number | null }>(
          `SELECT count(*)::int AS total,
                  coalesce(sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END), 0)::int AS done
           FROM issues JOIN workflow_states ON workflow_states.id = issues.state_id
           WHERE issues.milestone_id = $1 AND issues.archived_at IS NULL`,
          [milestone.id],
        );
        const total = Number(row?.total ?? 0);
        return total === 0 ? 0 : Number(row?.done ?? 0) / total;
      }
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
      const viewer = requireViewer(context);
      if (args.team) {
        const team = lookupTeam(context, { id: args.team });
        if (!team || !canAccessTeam(context.db, viewer, team.id)) return [];
        if (team.archived_at && !args.includeArchived) return [];
      }
      return scopeWorkspaceRows(
        context,
        listProjects(context.db, args.state, args.team, args.includeArchived),
      )
        .filter((project) => canAccessProject(context.db, viewer, project.id))
        .map(mapProject);
    },
    project: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      const row = lookupProject(context, args.id);
      return row && canAccessProject(context.db, viewer, row.id) ? mapProject(row) : null;
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
      if (args.input.leadId) requireActor(context, args.input.leadId);
      for (const teamId of args.input.teamIds ?? []) requireTeam(context, { id: teamId });
      const project = mapProject(
        createProject(context.db, args.input, context.workspace.workspaceId),
      );
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
        const issue = lookupIssueById(context, issueId);
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
      const projectBefore = requireProject(context, args.id);
      const archived = mapProject(archiveProject(context.db, args.id, true));
      context.events.emit("project.updated", viewer, archived, {
        archivedAt: { from: projectBefore.archived_at, to: archived.archivedAt },
      });
      return { success: true, project: archived };
    },
    projectUnarchive: (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      assertCanManageProject(context.db, viewer, args.id);
      const projectBefore = requireProject(context, args.id);
      const restored = mapProject(archiveProject(context.db, args.id, false));
      context.events.emit("project.updated", viewer, restored, {
        archivedAt: { from: projectBefore.archived_at, to: restored.archivedAt },
      });
      return { success: true, project: restored };
    },
    milestoneCreate: (
      _parent: unknown,
      args: { input: Parameters<typeof createMilestone>[1] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      assertCanManageProject(context.db, viewer, args.input.projectId);
      requireProject(context, args.input.projectId);
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
      requireProject(context, args.id);
      if (args.input.leadId) requireActor(context, args.input.leadId);
      if (args.input.teamIds !== undefined && args.input.teamIds !== null) {
        assertCanManageProjectTeams(context.db, viewer, args.input.teamIds);
        for (const teamId of args.input.teamIds) requireTeam(context, { id: teamId });
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
      requireProject(context, args.input.projectId);
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
