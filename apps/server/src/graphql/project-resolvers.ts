// Resolvers del dominio project (AT-137). Se ensamblan en resolvers.ts.
import { getActor, mapActor } from "../domain/actors.ts";
import { listIssues, mapIssue } from "../domain/issues.ts";
import { createProject, getProject, listProjects, mapProject, updateProject } from "../domain/projects.ts";
import type { Context } from "./context.ts";
import { requireViewer } from "./errors.ts";

type MappedProject = ReturnType<typeof mapProject>;

export const projectResolvers = {
  Project: {
    lead: (project: MappedProject, _args: unknown, context: Context) =>
      project.leadId ? mapActor(getActor(context.db, project.leadId)!) : null,
    issues: (project: MappedProject, args: { first?: number }, context: Context) => {
      const first = Math.min(Math.max(args.first ?? 50, 1), 250);
      const page = listIssues(context.db, { filter: { project: { eq: project.id } }, first });
      return {
        nodes: page.rows.map(mapIssue),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
      };
    },
  },

  Query: {
    projects: (_parent: unknown, args: { state?: string }, context: Context) => {
      requireViewer(context);
      return listProjects(context.db, args.state).map(mapProject);
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
