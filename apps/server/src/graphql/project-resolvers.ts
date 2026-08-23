// Resolvers del dominio project (AT-137). Se ensamblan en resolvers.ts.
import { mapActor } from "../domain/actors.ts";
import { mapIssue } from "../domain/issues.ts";
import { getPostgresActor, mapPostgresActor } from "../domain/postgres-actors.ts";
import {
  archivePostgresProject,
  assertCanManagePostgresProject,
  canAccessPostgresProject,
  createPostgresProject,
  getPostgresProject,
  listPostgresProjectTeamIds,
  listPostgresProjects,
  mapPostgresProject,
  updatePostgresProject,
} from "../domain/postgres-projects.ts";
import { accessiblePostgresTeamIds, listPostgresIssues } from "../domain/postgres-issues.ts";
import {
  createPostgresMilestone,
  deletePostgresMilestone,
  getPostgresMilestone,
  listPostgresMilestones,
  mapPostgresMilestone,
  updatePostgresMilestone,
} from "../domain/postgres-milestones.ts";
import {
  canDiscoverPostgresTeam,
  getPostgresTeam,
  listPostgresTeams,
  mapPostgresTeam,
} from "../domain/postgres-teams.ts";
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
import { listPostgresProjectUpdates } from "../domain/postgres-planning.ts";
import { documentResolvers } from "./document-resolvers.ts";
import { apiError, requireViewer } from "./errors.ts";
import {
  assertCanCreateProject,
  assertCanManageProject,
  assertCanManageProjectTeams,
  apiKeyTeamsWithinLimit,
  canAccessProject,
  canAccessTeam,
  accessibleTeamIds,
} from "../auth/permissions.ts";

type MappedProject = ReturnType<typeof mapProject> | ReturnType<typeof mapPostgresProject>;

function projectTeamsAllowed(context: Context, projectId: string): boolean {
  const viewer = requireViewer(context);
  const teamIds = listProjectTeamIds(context.db, projectId);
  return (
    canAccessProject(context.db, viewer, projectId) && apiKeyTeamsWithinLimit(context.auth, teamIds)
  );
}

async function postgresProjectTeamsAllowed(context: Context, projectId: string): Promise<boolean> {
  const viewer = requireViewer(context);
  const teamIds = await listPostgresProjectTeamIds(context.persistence!, projectId);
  return (
    (await canAccessPostgresProject(context.persistence!, viewer, projectId)) &&
    apiKeyTeamsWithinLimit(context.auth, teamIds)
  );
}

async function assertPostgresProjectKeyLimit(
  context: Context,
  teamIds: readonly string[],
): Promise<void> {
  if (!apiKeyTeamsWithinLimit(context.auth, teamIds)) {
    throw apiError("UNAUTHORIZED", "API key is limited to different Teams");
  }
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
        return (await postgresProjectTeamsAllowed(context, project.id))
          ? (await listPostgresMilestones(context.persistence, project.id)).map(
              mapPostgresMilestone,
            )
          : [];
      }
      return projectTeamsAllowed(context, project.id)
        ? listMilestones(context.db, project.id).map(mapMilestone)
        : [];
    },
    teams: async (project: MappedProject, _args: unknown, context: Context) => {
      if (context.persistence) {
        const viewer = requireViewer(context);
        const teamIds = await listPostgresProjectTeamIds(context.persistence, project.id);
        const teams = [];
        for (const teamId of teamIds) {
          const team = await getPostgresTeam(context.persistence, { id: teamId });
          if (
            team &&
            (await canDiscoverPostgresTeam(context.persistence, viewer, team)) &&
            apiKeyTeamsWithinLimit(context.auth, [teamId])
          ) {
            teams.push(mapPostgresTeam(team));
          }
        }
        return teams;
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
        if (!(await postgresProjectTeamsAllowed(context, project.id))) {
          return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        }
        const page = await listPostgresIssues(context.persistence, {
          filter: { project: { eq: project.id } },
          first,
          after: args.after,
          teamIds: await accessiblePostgresTeamIds(
            context.persistence,
            requireViewer(context),
            context.auth,
          ),
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
        return (await postgresProjectTeamsAllowed(context, project.id))
          ? (await listPostgresProjectUpdates(context.persistence, project.id)).map(
              (row) => mapProjectUpdate(row as never),
            )
          : [];
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
        return project && (await postgresProjectTeamsAllowed(context, project.id))
          ? mapPostgresProject(project)
          : null;
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
        return project && (await postgresProjectTeamsAllowed(context, project.id))
          ? mapPostgresProject(project)
          : null;
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
        const milestoneRow = await getPostgresMilestone(context.persistence, milestone.id);
        if (
          !milestoneRow ||
          !(await postgresProjectTeamsAllowed(context, milestoneRow.project_id))
        ) {
          return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        }
        const page = await listPostgresIssues(context.persistence, {
          filter: { milestone: { eq: milestone.id } },
          first: Math.min(Math.max(args.first ?? 100, 1), 250),
          after: args.after,
          teamIds: await accessiblePostgresTeamIds(
            context.persistence,
            requireViewer(context),
            context.auth,
          ),
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
                  COALESCE(sum(CASE WHEN workflow_states.type IN ('completed', 'canceled') THEN 1 ELSE 0 END), 0)::int AS done
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
    projects: async (
      _parent: unknown,
      args: { state?: string; team?: string; includeArchived?: boolean },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        if (args.team) {
          const team = await getPostgresTeam(context.persistence, { id: args.team });
          if (!team || !(await canDiscoverPostgresTeam(context.persistence, viewer, team)))
            return [];
          if (team.archived_at && !args.includeArchived) return [];
        }
        const rows = await listPostgresProjects(
          context.persistence,
          args.state,
          args.team,
          args.includeArchived,
        );
        const visible = [];
        for (const project of rows) {
          if (
            (await canAccessPostgresProject(context.persistence, viewer, project.id)) &&
            apiKeyTeamsWithinLimit(
              context.auth,
              await listPostgresProjectTeamIds(context.persistence, project.id),
            )
          ) {
            visible.push(mapPostgresProject(project));
          }
        }
        return visible;
      }
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
    project: async (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const row = await getPostgresProject(context.persistence, args.id);
        return row &&
          (await canAccessPostgresProject(context.persistence, viewer, row.id)) &&
          apiKeyTeamsWithinLimit(
            context.auth,
            await listPostgresProjectTeamIds(context.persistence, row.id),
          )
          ? mapPostgresProject(row)
          : null;
      }
      const row = lookupProject(context, args.id);
      return row && canAccessProject(context.db, viewer, row.id) ? mapProject(row) : null;
    },
  },

  Mutation: {
    projectCreate: async (
      _parent: unknown,
      args: { input: Parameters<typeof createProject>[1] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const teamIds =
          args.input.teamIds == null
            ? (await listPostgresTeams(context.persistence)).map((team) => team.id)
            : args.input.teamIds;
        await assertPostgresProjectKeyLimit(context, teamIds);
        const project = mapPostgresProject(
          await createPostgresProject(context.persistence, viewer, args.input),
        );
        context.events.emit("project.created", viewer, project);
        return { success: true, project };
      }
      assertCanCreateProject(context.db, viewer, args.input.teamIds);
      if (args.input.leadId) requireActor(context, args.input.leadId);
      for (const teamId of args.input.teamIds ?? []) requireTeam(context, { id: teamId });
      const project = mapProject(
        createProject(context.db, args.input, context.workspace.workspaceId),
      );
      context.events.emit("project.created", viewer, project);
      return { success: true, project };
    },
    milestoneDelete: async (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const milestone = await getPostgresMilestone(context.persistence, args.id);
        if (milestone) {
          await assertPostgresProjectKeyLimit(
            context,
            await listPostgresProjectTeamIds(context.persistence, milestone.project_id),
          );
        }
        const orphaned = await deletePostgresMilestone(context.persistence, viewer, args.id);
        return { success: true, orphanedIssues: orphaned };
      }
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
    projectArchive: async (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const projectBefore = await assertCanManagePostgresProject(
          context.persistence,
          viewer,
          args.id,
        );
        await assertPostgresProjectKeyLimit(
          context,
          await listPostgresProjectTeamIds(context.persistence, args.id),
        );
        const archived = mapPostgresProject(
          await archivePostgresProject(context.persistence, args.id, true),
        );
        context.events.emit("project.updated", viewer, archived, {
          archivedAt: { from: projectBefore.archived_at, to: archived.archivedAt },
        });
        return { success: true, project: archived };
      }
      assertCanManageProject(context.db, viewer, args.id);
      const projectBefore = requireProject(context, args.id);
      const archived = mapProject(archiveProject(context.db, args.id, true));
      context.events.emit("project.updated", viewer, archived, {
        archivedAt: { from: projectBefore.archived_at, to: archived.archivedAt },
      });
      return { success: true, project: archived };
    },
    projectUnarchive: async (_parent: unknown, args: { id: string }, context: Context) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const projectBefore = await assertCanManagePostgresProject(
          context.persistence,
          viewer,
          args.id,
        );
        await assertPostgresProjectKeyLimit(
          context,
          await listPostgresProjectTeamIds(context.persistence, args.id),
        );
        const restored = mapPostgresProject(
          await archivePostgresProject(context.persistence, args.id, false),
        );
        context.events.emit("project.updated", viewer, restored, {
          archivedAt: { from: projectBefore.archived_at, to: restored.archivedAt },
        });
        return { success: true, project: restored };
      }
      assertCanManageProject(context.db, viewer, args.id);
      const projectBefore = requireProject(context, args.id);
      const restored = mapProject(archiveProject(context.db, args.id, false));
      context.events.emit("project.updated", viewer, restored, {
        archivedAt: { from: projectBefore.archived_at, to: restored.archivedAt },
      });
      return { success: true, project: restored };
    },
    milestoneCreate: async (
      _parent: unknown,
      args: { input: Parameters<typeof createMilestone>[1] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        await assertPostgresProjectKeyLimit(
          context,
          await listPostgresProjectTeamIds(context.persistence, args.input.projectId),
        );
        const created = mapPostgresMilestone(
          await createPostgresMilestone(context.persistence, viewer, args.input),
        );
        return { success: true, milestone: created };
      }
      assertCanManageProject(context.db, viewer, args.input.projectId);
      requireProject(context, args.input.projectId);
      const created = mapMilestone(createMilestone(context.db, args.input));
      return { success: true, milestone: created };
    },
    milestoneUpdate: async (
      _parent: unknown,
      args: { id: string; input: Parameters<typeof updateMilestone>[2] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const milestone = await getPostgresMilestone(context.persistence, args.id);
        if (milestone) {
          await assertPostgresProjectKeyLimit(
            context,
            await listPostgresProjectTeamIds(context.persistence, milestone.project_id),
          );
        }
        const updated = mapPostgresMilestone(
          await updatePostgresMilestone(context.persistence, viewer, args.id, args.input),
        );
        return { success: true, milestone: updated };
      }
      const milestone = getMilestone(context.db, args.id);
      if (milestone) assertCanManageProject(context.db, viewer, milestone.project_id);
      const updated = mapMilestone(updateMilestone(context.db, args.id, args.input));
      return { success: true, milestone: updated };
    },
    projectUpdate: async (
      _parent: unknown,
      args: { id: string; input: Parameters<typeof updateProject>[2] },
      context: Context,
    ) => {
      const viewer = requireViewer(context);
      if (context.persistence) {
        const currentTeams = await listPostgresProjectTeamIds(context.persistence, args.id);
        const targetTeams =
          args.input.teamIds === undefined ? currentTeams : (args.input.teamIds ?? []);
        await assertPostgresProjectKeyLimit(context, targetTeams);
        const project = mapPostgresProject(
          await updatePostgresProject(context.persistence, viewer, args.id, args.input),
        );
        context.events.emit("project.updated", viewer, project);
        return { success: true, project };
      }
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
