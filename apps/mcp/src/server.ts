// MCP server de prime-board: tools espejo del MCP de Linear (spec §8),
// para que un agente que ya sabe operar Linear use prime-board sin cambios.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APP_VERSION } from "@prime-board/schema";
import { gqlRequest, type McpConfig } from "./api.ts";
import {
  resolveActor,
  resolveLabelIds,
  resolvePriority,
  resolveStateFilter,
  resolveTeam,
} from "./resolve.ts";

const ISSUE_FIELDS = `id identifier title description priority
  state { id name type } assignee { id name type } creator { id name type }
  labels { id name } project { id name } parent { identifier }
  url branchName createdAt updatedAt`;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createServer(config: McpConfig): McpServer {
  const server = new McpServer({ name: "prime-board", version: APP_VERSION });

  server.registerTool(
    "get_workspace",
    {
      description: "Retrieve the prime-board workspace.",
      inputSchema: {},
    },
    async () => {
      const data = await gqlRequest(
        config,
        "{ workspace { id name urlKey } viewer { id name type } }",
      );
      return json(data);
    },
  );

  server.registerTool(
    "list_teams",
    {
      description: "List teams in the workspace.",
      inputSchema: {},
    },
    async () => json((await gqlRequest(config, "{ teams { id key name description } }")).teams),
  );

  server.registerTool(
    "get_team",
    {
      description: "Retrieve a team by key (e.g. PB) or ID, including its workflow states.",
      inputSchema: { team: z.string().describe("Team key or ID") },
    },
    async ({ team }) => json(await resolveTeam(config, team)),
  );

  server.registerTool(
    "list_issue_statuses",
    {
      description: "List workflow states of a team.",
      inputSchema: { team: z.string().describe("Team key or ID") },
    },
    async ({ team }) => json((await resolveTeam(config, team)).states),
  );

  server.registerTool(
    "list_users",
    {
      description: "List actors (humans and agents) in the workspace.",
      inputSchema: { type: z.enum(["human", "agent"]).optional() },
    },
    async ({ type }) => {
      const data = await gqlRequest(
        config,
        `query($type: ActorType) {
      actors(type: $type) { id name email type }
    }`,
        { type: type ? type.toUpperCase() : null },
      );
      return json(data.actors);
    },
  );

  server.registerTool(
    "list_issue_labels",
    {
      description: "List labels available in the workspace or a team.",
      inputSchema: { team: z.string().optional().describe("Team key or ID") },
    },
    async ({ team }) => {
      const teamId = team ? (await resolveTeam(config, team)).id : null;
      const data = await gqlRequest(
        config,
        `query($team: ID) { labels(team: $team) { id name color teamId } }`,
        {
          team: teamId,
        },
      );
      return json(data.labels);
    },
  );

  server.registerTool(
    "list_issues",
    {
      description: "List issues with optional filters and full-text search.",
      inputSchema: {
        team: z.string().optional().describe("Team key or ID"),
        state: z.string().optional().describe("State name, semantic type or ID"),
        assignee: z.string().optional().describe('Actor ID, name or "me"'),
        project: z.string().optional().describe("Project ID"),
        query: z.string().optional().describe("Full-text search on title/description"),
        unblocked: z
          .boolean()
          .optional()
          .describe(
            "true: open issues whose blockers are all closed (the frontier); false: issues with an open blocker",
          ),
        limit: z.number().optional(),
      },
    },
    async (args) => {
      const filter: Record<string, unknown> = {};
      let states = null;
      if (args.team) {
        const team = await resolveTeam(config, args.team);
        filter.team = { eq: team.id };
        states = team.states;
      }
      if (args.state) Object.assign(filter, resolveStateFilter(states, args.state));
      if (args.assignee) filter.assignee = { eq: await resolveActor(config, args.assignee) };
      if (args.project) filter.project = { eq: args.project };
      if (args.query) filter.search = args.query;
      if (args.unblocked !== undefined) filter.unblocked = args.unblocked;
      const data = await gqlRequest(
        config,
        `query($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`,
        { filter, first: args.limit ?? 50 },
      );
      return json(data.issues);
    },
  );

  server.registerTool(
    "get_issue",
    {
      description:
        "Retrieve an issue by ID or identifier (e.g. PB-1), including comments and activity.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        config,
        `query($id: ID!) {
      issue(id: $id) {
        ${ISSUE_FIELDS}
        children { identifier title state { name } }
        relations { id type relatedIssue { identifier title state { name } } }
        comments { id body actor { name type } createdAt }
        activity { type actor { name type } payload createdAt }
      }
    }`,
        { id },
      );
      if (!data.issue) throw new Error(`NOT_FOUND: Issue not found: ${id}`);
      return json(data.issue);
    },
  );

  server.registerTool(
    "save_issue",
    {
      description:
        "Create or update an issue. Provide `id` to update, otherwise `team` and `title` to create.",
      inputSchema: {
        id: z.string().optional().describe("Issue ID or identifier to update"),
        team: z.string().optional().describe("Team key or ID (required to create)"),
        number: z.number().optional().describe("Fix the identifier number (imports only)"),
        title: z.string().optional(),
        description: z.string().optional(),
        state: z.string().optional().describe("State name, semantic type or ID"),
        priority: z
          .union([z.number(), z.string()])
          .optional()
          .describe("0-4 or none|urgent|high|medium|low"),
        assignee: z.string().optional().describe('Actor ID, name or "me"'),
        parent: z
          .union([z.string(), z.null()])
          .optional()
          .describe("Parent issue ID or identifier; null explicitly clears the parent"),
        project: z.string().optional().describe("Project ID"),
        milestone: z
          .string()
          .optional()
          .describe("Milestone ID (must belong to the issue's project)"),
        labels: z.array(z.string()).optional().describe("Label names to set"),
      },
    },
    async (args) => {
      const input: Record<string, unknown> = {};
      if (args.title !== undefined) input.title = args.title;
      if (args.description !== undefined) input.description = args.description;
      if (args.priority !== undefined) input.priority = resolvePriority(args.priority);
      if (args.assignee !== undefined) input.assigneeId = await resolveActor(config, args.assignee);
      if (args.project !== undefined) input.projectId = args.project;
      if (args.milestone !== undefined) input.milestoneId = args.milestone;

      if (args.id) {
        // Update: resuelve team para estados/labels/parent.
        const existing = await gqlRequest(
          config,
          `query($id: ID!) {
        issue(id: $id) { id team { id key states { id name type } } }
      }`,
          { id: args.id },
        );
        if (!existing.issue) throw new Error(`NOT_FOUND: Issue not found: ${args.id}`);
        const team = existing.issue.team;
        if (args.state) {
          const resolved = resolveStateFilter(team.states, args.state);
          input.stateId =
            resolved.state?.eq ??
            team.states.find((s: any) => s.type.toLowerCase() === args.state!.toLowerCase())?.id;
        }
        if (args.parent !== undefined) {
          if (args.parent === null) {
            input.parentId = null;
          } else {
            const parent = await gqlRequest(config, `query($id: ID!) { issue(id: $id) { id } }`, {
              id: args.parent,
            });
            if (!parent.issue) throw new Error(`NOT_FOUND: Parent issue not found: ${args.parent}`);
            input.parentId = parent.issue.id;
          }
        }
        if (args.labels) input.labelIds = await resolveLabelIds(config, team.id, args.labels);
        const data = await gqlRequest(
          config,
          `mutation($id: ID!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } }
      }`,
          { id: existing.issue.id, input },
        );
        return json(data.issueUpdate.issue);
      }

      if (!args.team || !args.title) {
        throw new Error("VALIDATION_FAILED: `team` and `title` are required to create an issue");
      }
      const team = await resolveTeam(config, args.team);
      input.teamId = team.id;
      if (args.number !== undefined) input.number = args.number;
      if (args.state) {
        const resolved = resolveStateFilter(team.states, args.state);
        input.stateId =
          resolved.state?.eq ??
          team.states.find((s: any) => s.type.toLowerCase() === args.state!.toLowerCase())?.id;
      }
      if (args.parent) {
        const parent = await gqlRequest(config, `query($id: ID!) { issue(id: $id) { id } }`, {
          id: args.parent,
        });
        if (!parent.issue) throw new Error(`NOT_FOUND: Parent issue not found: ${args.parent}`);
        input.parentId = parent.issue.id;
      }
      if (args.labels?.length) {
        input.labelIds = await resolveLabelIds(config, team.id, args.labels);
      }
      const data = await gqlRequest(
        config,
        `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id ${ISSUE_FIELDS} } }
    }`,
        { input },
      );
      return json(data.issueCreate.issue);
    },
  );

  const RELATION_TYPES = ["blocked_by", "blocks", "related", "duplicate_of"] as const;

  server.registerTool(
    "link_issues",
    {
      description:
        "Create a relation between two issues, from the perspective of `issue` " +
        "(e.g. type blocked_by means `issue` is blocked by `relatedIssue`).",
      inputSchema: {
        issue: z.string().describe("Issue ID or identifier (e.g. PB-1)"),
        relatedIssue: z.string().describe("The other issue ID or identifier"),
        type: z.enum(RELATION_TYPES),
      },
    },
    async ({ issue, relatedIssue, type }) => {
      const data = await gqlRequest(
        config,
        `mutation($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) {
        relation { id type relatedIssue { identifier title } }
      }
    }`,
        { input: { issueId: issue, relatedIssueId: relatedIssue, type: type.toUpperCase() } },
      );
      return json(data.issueRelationCreate.relation);
    },
  );

  server.registerTool(
    "unlink_issues",
    {
      description:
        "Delete relations between two issues. Without `type`, removes every relation between them.",
      inputSchema: {
        issue: z.string().describe("Issue ID or identifier"),
        relatedIssue: z.string().describe("The other issue ID or identifier"),
        type: z.enum(RELATION_TYPES).optional(),
      },
    },
    async ({ issue, relatedIssue, type }) => {
      const [source, other] = await Promise.all([
        gqlRequest(
          config,
          `query($id: ID!) {
        issue(id: $id) { identifier relations { id type relatedIssue { identifier } } }
      }`,
          { id: issue },
        ),
        gqlRequest(config, `query($id: ID!) { issue(id: $id) { identifier } }`, {
          id: relatedIssue,
        }),
      ]);
      if (!source.issue) throw new Error(`NOT_FOUND: Issue not found: ${issue}`);
      if (!other.issue) throw new Error(`NOT_FOUND: Issue not found: ${relatedIssue}`);
      const matches = source.issue.relations.filter(
        (relation: any) =>
          relation.relatedIssue.identifier === other.issue.identifier &&
          (!type || relation.type === type.toUpperCase()),
      );
      if (matches.length === 0) {
        throw new Error(
          `NOT_FOUND: No${type ? ` ${type}` : ""} relation between ${source.issue.identifier} and ${other.issue.identifier}`,
        );
      }
      for (const relation of matches) {
        await gqlRequest(
          config,
          `mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`,
          { id: relation.id },
        );
      }
      return json({ deleted: matches.length });
    },
  );

  server.registerTool(
    "list_comments",
    {
      description: "List comments on an issue (by ID or identifier).",
      inputSchema: { issue: z.string() },
    },
    async ({ issue }) => {
      const data = await gqlRequest(
        config,
        `query($id: ID!) {
      issue(id: $id) { comments { id body actor { name type } createdAt } }
    }`,
        { id: issue },
      );
      if (!data.issue) throw new Error(`NOT_FOUND: Issue not found: ${issue}`);
      return json(data.issue.comments);
    },
  );

  server.registerTool(
    "save_comment",
    {
      description: "Create a comment on an issue (by ID or identifier).",
      inputSchema: { issue: z.string(), body: z.string() },
    },
    async ({ issue, body }) => {
      const data = await gqlRequest(
        config,
        `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        comment { id body actor { name type } issue { identifier } createdAt }
      }
    }`,
        { input: { issueId: issue, body } },
      );
      return json(data.commentCreate.comment);
    },
  );

  server.registerTool(
    "list_projects",
    {
      description: "List projects, optionally filtered by state or team.",
      inputSchema: {
        state: z
          .enum(["backlog", "planned", "started", "paused", "completed", "canceled"])
          .optional(),
        team: z.string().optional().describe("Team key or ID"),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ state, team, includeArchived }) => {
      const teamId = team ? (await resolveTeam(config, team)).id : null;
      const data = await gqlRequest(
        config,
        `query($state: ProjectState, $team: ID, $includeArchived: Boolean) {
      projects(state: $state, team: $team, includeArchived: $includeArchived) {
        id name description state targetDate archivedAt lead { id name } teams { key }
      }
    }`,
        {
          state: state ? state.toUpperCase() : null,
          team: teamId,
          includeArchived: Boolean(includeArchived),
        },
      );
      return json(data.projects);
    },
  );

  server.registerTool(
    "get_project",
    {
      description: "Retrieve a project by ID, including its issues.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        config,
        `query($id: ID!) {
      project(id: $id) {
        id name description state targetDate archivedAt lead { id name }
        milestones { id name description targetDate position progress }
        updates { id health body risks createdAt updatedAt author { id name type } }
        issues(first: 100) { nodes { identifier title state { name type } assignee { name } milestone { name } } }
      }
    }`,
        { id },
      );
      if (!data.project) throw new Error(`NOT_FOUND: Project not found: ${id}`);
      return json(data.project);
    },
  );

  server.registerTool(
    "save_project",
    {
      description:
        "Create or update a project. Provide `id` to update, otherwise `name` to create.",
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        state: z
          .enum(["backlog", "planned", "started", "paused", "completed", "canceled"])
          .optional(),
        lead: z.string().optional().describe('Actor ID, name or "me"'),
        targetDate: z.string().optional(),
        teams: z.array(z.string()).optional().describe("Team keys or IDs"),
      },
    },
    async (args) => {
      const input: Record<string, unknown> = {};
      if (args.teams !== undefined) {
        input.teamIds = await Promise.all(
          args.teams.map(async (ref: string) => (await resolveTeam(config, ref)).id),
        );
      }
      if (args.name !== undefined) input.name = args.name;
      if (args.description !== undefined) input.description = args.description;
      if (args.state !== undefined) input.state = args.state.toUpperCase();
      if (args.lead !== undefined) input.leadId = await resolveActor(config, args.lead);
      if (args.targetDate !== undefined) input.targetDate = args.targetDate;

      if (args.id) {
        const data = await gqlRequest(
          config,
          `mutation($id: ID!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) {
          project { id name description state targetDate lead { id name } }
        }
      }`,
          { id: args.id, input },
        );
        return json(data.projectUpdate.project);
      }
      if (!args.name) throw new Error("VALIDATION_FAILED: `name` is required to create a project");
      const data = await gqlRequest(
        config,
        `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        project { id name description state targetDate lead { id name } }
      }
    }`,
        { input },
      );
      return json(data.projectCreate.project);
    },
  );

  server.registerTool(
    "archive_project",
    {
      description: "Archive a project by ID.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        config,
        `mutation($id: ID!) {
      projectArchive(id: $id) { project { id name state archivedAt } }
    }`,
        { id },
      );
      return json(data.projectArchive.project);
    },
  );

  server.registerTool(
    "unarchive_project",
    {
      description: "Unarchive a project by ID.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        config,
        `mutation($id: ID!) {
      projectUnarchive(id: $id) { project { id name state archivedAt } }
    }`,
        { id },
      );
      return json(data.projectUnarchive.project);
    },
  );

  server.registerTool(
    "list_milestones",
    {
      description: "List milestones belonging to a project.",
      inputSchema: { project: z.string().describe("Project ID") },
    },
    async ({ project }) => {
      const data = await gqlRequest(
        config,
        `query($id: ID!) {
      project(id: $id) { milestones { id name description targetDate position createdAt project { id name } } }
    }`,
        { id: project },
      );
      if (!data.project) throw new Error(`NOT_FOUND: Project not found: ${project}`);
      return json(data.project.milestones);
    },
  );

  server.registerTool(
    "save_milestone",
    {
      description: "Create or update a project milestone. Provide id to update.",
      inputSchema: {
        id: z.string().optional(),
        project: z.string().optional().describe("Project ID (required to create)"),
        name: z.string().optional(),
        description: z.string().optional(),
        targetDate: z.string().optional(),
        position: z.number().optional(),
      },
    },
    async (args) => {
      if (args.id) {
        const input: Record<string, unknown> = {};
        if (args.name !== undefined) input.name = args.name;
        if (args.description !== undefined) input.description = args.description;
        if (args.targetDate !== undefined) input.targetDate = args.targetDate;
        if (args.position !== undefined) input.position = args.position;
        const data = await gqlRequest(
          config,
          `mutation($id: ID!, $input: MilestoneUpdateInput!) {
        milestoneUpdate(id: $id, input: $input) {
          milestone { id name description targetDate position createdAt project { id name } }
        }
      }`,
          { id: args.id, input },
        );
        return json(data.milestoneUpdate.milestone);
      }
      if (!args.project || !args.name) {
        throw new Error(
          "VALIDATION_FAILED: `project` and `name` are required to create a milestone",
        );
      }
      const input: Record<string, unknown> = { projectId: args.project, name: args.name };
      if (args.description !== undefined) input.description = args.description;
      if (args.targetDate !== undefined) input.targetDate = args.targetDate;
      if (args.position !== undefined) input.position = args.position;
      const data = await gqlRequest(
        config,
        `mutation($input: MilestoneCreateInput!) {
      milestoneCreate(input: $input) {
        milestone { id name description targetDate position createdAt project { id name } }
      }
    }`,
        { input },
      );
      return json(data.milestoneCreate.milestone);
    },
  );

  server.registerTool(
    "delete_milestone",
    {
      description: "Delete a project milestone by ID.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        config,
        `mutation($id: ID!) { milestoneDelete(id: $id) { success orphanedIssues } }`,
        { id },
      );
      return json(data.milestoneDelete);
    },
  );

  server.registerTool(
    "list_project_updates",
    {
      description: "List narrative updates belonging to a project.",
      inputSchema: { project: z.string().describe("Project ID") },
    },
    async ({ project }) => {
      const data = await gqlRequest(
        config,
        `query($id: ID!) {
      project(id: $id) {
        updates { id health body risks createdAt updatedAt project { id name } author { id name type } }
      }
    }`,
        { id: project },
      );
      if (!data.project) throw new Error(`NOT_FOUND: Project not found: ${project}`);
      return json(data.project.updates);
    },
  );

  server.registerTool(
    "save_project_update",
    {
      description: "Create a narrative project update.",
      inputSchema: {
        project: z.string().describe("Project ID"),
        health: z.enum(["on_track", "at_risk", "off_track"]),
        body: z.string(),
        risks: z.string().optional(),
      },
    },
    async ({ project, health, body, risks }) => {
      const data = await gqlRequest(
        config,
        `mutation($input: ProjectUpdateCreateInput!) {
      projectUpdateCreate(input: $input) {
        projectUpdate { id health body risks createdAt updatedAt project { id name } author { id name type } }
      }
    }`,
        {
          input: {
            projectId: project,
            health: health.toUpperCase(),
            body,
            ...(risks === undefined ? {} : { risks }),
          },
        },
      );
      return json(data.projectUpdateCreate.projectUpdate);
    },
  );

  server.registerTool(
    "delete_project_update",
    {
      description: "Delete a narrative project update by ID.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        config,
        `mutation($id: ID!) { projectUpdateDelete(id: $id) { success } }`,
        { id },
      );
      return json(data.projectUpdateDelete);
    },
  );

  server.registerTool(
    "list_saved_views",
    {
      description: "List saved views visible to the authenticated actor.",
      inputSchema: {
        team: z.string().optional().describe("Team key or ID"),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ team, includeArchived }) => {
      const teamId = team ? (await resolveTeam(config, team)).id : null;
      const data = await gqlRequest(
        config,
        `query($teamId: ID, $includeArchived: Boolean) {
      savedViews(teamId: $teamId, includeArchived: $includeArchived) {
        id name scope orderBy groupBy columns archivedAt
        team { key } owner { name } filter
      }
    }`,
        { teamId, includeArchived: Boolean(includeArchived) },
      );
      return json(data.savedViews);
    },
  );

  server.registerTool(
    "save_saved_view",
    {
      description: "Create or update a saved view. Provide `id` to update.",
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        scope: z.enum(["personal", "team", "workspace"]).optional(),
        team: z.string().optional().describe("Team key or ID (required for team scope)"),
        orderBy: z.enum(["created_asc", "created_desc", "updated_asc", "updated_desc"]).optional(),
        groupBy: z.enum(["state", "milestone", "assignee", "priority"]).optional(),
        columns: z.array(z.string()).optional(),
        archived: z.boolean().optional(),
        filter: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      if (args.id) {
        const input: Record<string, unknown> = {};
        if (args.name !== undefined) input.name = args.name;
        if (args.orderBy !== undefined) input.orderBy = args.orderBy.toUpperCase();
        if (args.groupBy !== undefined) input.groupBy = args.groupBy;
        if (args.columns !== undefined) input.columns = args.columns;
        if (args.archived !== undefined) input.archived = args.archived;
        if (args.filter !== undefined) input.filter = args.filter;
        const data = await gqlRequest(
          config,
          `mutation($id: ID!, $input: SavedViewUpdateInput!) {
        savedViewUpdate(id: $id, input: $input) {
          savedView { id name scope orderBy groupBy columns archivedAt }
        }
      }`,
          { id: args.id, input },
        );
        return json(data.savedViewUpdate.savedView);
      }
      if (!args.name || !args.scope) {
        throw new Error(
          "VALIDATION_FAILED: `name` and `scope` are required to create a saved view",
        );
      }
      const input: Record<string, unknown> = {
        name: args.name,
        scope: args.scope.toUpperCase(),
        filter: args.filter ?? {},
      };
      if (args.team) input.teamId = (await resolveTeam(config, args.team)).id;
      if (args.orderBy) input.orderBy = args.orderBy.toUpperCase();
      if (args.groupBy) input.groupBy = args.groupBy;
      if (args.columns) input.columns = args.columns;
      const data = await gqlRequest(
        config,
        `mutation($input: SavedViewCreateInput!) {
      savedViewCreate(input: $input) {
        savedView { id name scope orderBy groupBy columns archivedAt }
      }
    }`,
        { input },
      );
      return json(data.savedViewCreate.savedView);
    },
  );

  server.registerTool(
    "delete_saved_view",
    {
      description: "Delete a saved view by ID.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        config,
        `mutation($id: ID!) {
      savedViewDelete(id: $id) { success }
    }`,
        { id },
      );
      return json(data.savedViewDelete);
    },
  );

  return server;
}
