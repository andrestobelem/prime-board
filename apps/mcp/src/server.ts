// MCP server de prime-board: tools espejo del MCP de Linear (spec §8),
// para que un agente que ya sabe operar Linear use prime-board sin cambios.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APP_VERSION } from "@prime-board/schema";
import { gqlRequest, type McpConfig } from "./api.ts";
import {
  resolveActor, resolveLabelIds, resolvePriority, resolveStateFilter, resolveTeam,
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

  server.registerTool("get_workspace", {
    description: "Retrieve the prime-board workspace.",
    inputSchema: {},
  }, async () => {
    const data = await gqlRequest(config, "{ workspace { id name urlKey } viewer { id name type } }");
    return json(data);
  });

  server.registerTool("list_teams", {
    description: "List teams in the workspace.",
    inputSchema: {},
  }, async () => json((await gqlRequest(config, "{ teams { id key name description } }")).teams));

  server.registerTool("get_team", {
    description: "Retrieve a team by key (e.g. PB) or ID, including its workflow states.",
    inputSchema: { team: z.string().describe("Team key or ID") },
  }, async ({ team }) => json(await resolveTeam(config, team)));

  server.registerTool("list_issue_statuses", {
    description: "List workflow states of a team.",
    inputSchema: { team: z.string().describe("Team key or ID") },
  }, async ({ team }) => json((await resolveTeam(config, team)).states));

  server.registerTool("list_users", {
    description: "List actors (humans and agents) in the workspace.",
    inputSchema: { type: z.enum(["human", "agent"]).optional() },
  }, async ({ type }) => {
    const data = await gqlRequest(config, `query($type: ActorType) {
      actors(type: $type) { id name email type }
    }`, { type: type ? type.toUpperCase() : null });
    return json(data.actors);
  });

  server.registerTool("list_issue_labels", {
    description: "List labels available in the workspace or a team.",
    inputSchema: { team: z.string().optional().describe("Team key or ID") },
  }, async ({ team }) => {
    const teamId = team ? (await resolveTeam(config, team)).id : null;
    const data = await gqlRequest(config, `query($team: ID) { labels(team: $team) { id name color teamId } }`, {
      team: teamId,
    });
    return json(data.labels);
  });

  server.registerTool("list_issues", {
    description: "List issues with optional filters and full-text search.",
    inputSchema: {
      team: z.string().optional().describe("Team key or ID"),
      state: z.string().optional().describe("State name, semantic type or ID"),
      assignee: z.string().optional().describe('Actor ID, name or "me"'),
      project: z.string().optional().describe("Project ID"),
      query: z.string().optional().describe("Full-text search on title/description"),
      limit: z.number().optional(),
    },
  }, async (args) => {
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
    const data = await gqlRequest(config, `query($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`, { filter, first: args.limit ?? 50 });
    return json(data.issues);
  });

  server.registerTool("get_issue", {
    description: "Retrieve an issue by ID or identifier (e.g. PB-1), including comments and activity.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const data = await gqlRequest(config, `query($id: ID!) {
      issue(id: $id) {
        ${ISSUE_FIELDS}
        children { identifier title state { name } }
        comments { id body actor { name type } createdAt }
        activity { type actor { name type } payload createdAt }
      }
    }`, { id });
    if (!data.issue) throw new Error(`NOT_FOUND: Issue not found: ${id}`);
    return json(data.issue);
  });

  server.registerTool("save_issue", {
    description: "Create or update an issue. Provide `id` to update, otherwise `team` and `title` to create.",
    inputSchema: {
      id: z.string().optional().describe("Issue ID or identifier to update"),
      team: z.string().optional().describe("Team key or ID (required to create)"),
      title: z.string().optional(),
      description: z.string().optional(),
      state: z.string().optional().describe("State name, semantic type or ID"),
      priority: z.union([z.number(), z.string()]).optional().describe("0-4 or none|urgent|high|medium|low"),
      assignee: z.string().optional().describe('Actor ID, name or "me"'),
      parent: z.string().optional().describe("Parent issue ID or identifier"),
      project: z.string().optional().describe("Project ID"),
      labels: z.array(z.string()).optional().describe("Label names to set"),
    },
  }, async (args) => {
    const input: Record<string, unknown> = {};
    if (args.title !== undefined) input.title = args.title;
    if (args.description !== undefined) input.description = args.description;
    if (args.priority !== undefined) input.priority = resolvePriority(args.priority);
    if (args.assignee !== undefined) input.assigneeId = await resolveActor(config, args.assignee);
    if (args.project !== undefined) input.projectId = args.project;

    if (args.id) {
      // Update: resuelve team para estados/labels/parent.
      const existing = await gqlRequest(config, `query($id: ID!) {
        issue(id: $id) { id team { id key states { id name type } } }
      }`, { id: args.id });
      if (!existing.issue) throw new Error(`NOT_FOUND: Issue not found: ${args.id}`);
      const team = existing.issue.team;
      if (args.state) {
        const resolved = resolveStateFilter(team.states, args.state);
        input.stateId = resolved.state?.eq ??
          team.states.find((s: any) => s.type.toLowerCase() === args.state!.toLowerCase())?.id;
      }
      if (args.parent) {
        const parent = await gqlRequest(config, `query($id: ID!) { issue(id: $id) { id } }`, { id: args.parent });
        input.parentId = parent.issue?.id ?? null;
      }
      if (args.labels) input.labelIds = await resolveLabelIds(config, team.id, args.labels);
      const data = await gqlRequest(config, `mutation($id: ID!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } }
      }`, { id: existing.issue.id, input });
      return json(data.issueUpdate.issue);
    }

    if (!args.team || !args.title) {
      throw new Error("VALIDATION_FAILED: `team` and `title` are required to create an issue");
    }
    const team = await resolveTeam(config, args.team);
    input.teamId = team.id;
    if (args.state) {
      const resolved = resolveStateFilter(team.states, args.state);
      input.stateId = resolved.state?.eq ??
        team.states.find((s: any) => s.type.toLowerCase() === args.state!.toLowerCase())?.id;
    }
    if (args.parent) {
      const parent = await gqlRequest(config, `query($id: ID!) { issue(id: $id) { id } }`, { id: args.parent });
      if (!parent.issue) throw new Error(`NOT_FOUND: Parent issue not found: ${args.parent}`);
      input.parentId = parent.issue.id;
    }
    const data = await gqlRequest(config, `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id ${ISSUE_FIELDS} } }
    }`, { input });
    let issue = data.issueCreate.issue;
    if (args.labels?.length) {
      const labelIds = await resolveLabelIds(config, team.id, args.labels);
      const updated = await gqlRequest(config, `mutation($id: ID!, $labels: [ID!]) {
        issueUpdate(id: $id, input: { labelIds: $labels }) { issue { ${ISSUE_FIELDS} } }
      }`, { id: issue.id, labels: labelIds });
      issue = updated.issueUpdate.issue;
    }
    return json(issue);
  });

  server.registerTool("list_comments", {
    description: "List comments on an issue (by ID or identifier).",
    inputSchema: { issue: z.string() },
  }, async ({ issue }) => {
    const data = await gqlRequest(config, `query($id: ID!) {
      issue(id: $id) { comments { id body actor { name type } createdAt } }
    }`, { id: issue });
    if (!data.issue) throw new Error(`NOT_FOUND: Issue not found: ${issue}`);
    return json(data.issue.comments);
  });

  server.registerTool("save_comment", {
    description: "Create a comment on an issue (by ID or identifier).",
    inputSchema: { issue: z.string(), body: z.string() },
  }, async ({ issue, body }) => {
    const data = await gqlRequest(config, `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        comment { id body actor { name type } issue { identifier } createdAt }
      }
    }`, { input: { issueId: issue, body } });
    return json(data.commentCreate.comment);
  });

  server.registerTool("list_projects", {
    description: "List projects, optionally filtered by state.",
    inputSchema: {
      state: z.enum(["backlog", "planned", "started", "paused", "completed", "canceled"]).optional(),
    },
  }, async ({ state }) => {
    const data = await gqlRequest(config, `query($state: ProjectState) {
      projects(state: $state) { id name description state targetDate lead { id name } }
    }`, { state: state ? state.toUpperCase() : null });
    return json(data.projects);
  });

  server.registerTool("get_project", {
    description: "Retrieve a project by ID, including its issues.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const data = await gqlRequest(config, `query($id: ID!) {
      project(id: $id) {
        id name description state targetDate lead { id name }
        issues(first: 100) { nodes { identifier title state { name type } assignee { name } } }
      }
    }`, { id });
    if (!data.project) throw new Error(`NOT_FOUND: Project not found: ${id}`);
    return json(data.project);
  });

  server.registerTool("save_project", {
    description: "Create or update a project. Provide `id` to update, otherwise `name` to create.",
    inputSchema: {
      id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      state: z.enum(["backlog", "planned", "started", "paused", "completed", "canceled"]).optional(),
      lead: z.string().optional().describe('Actor ID, name or "me"'),
      targetDate: z.string().optional(),
    },
  }, async (args) => {
    const input: Record<string, unknown> = {};
    if (args.name !== undefined) input.name = args.name;
    if (args.description !== undefined) input.description = args.description;
    if (args.state !== undefined) input.state = args.state.toUpperCase();
    if (args.lead !== undefined) input.leadId = await resolveActor(config, args.lead);
    if (args.targetDate !== undefined) input.targetDate = args.targetDate;

    if (args.id) {
      const data = await gqlRequest(config, `mutation($id: ID!, $input: ProjectUpdateInput!) {
        projectUpdate(id: $id, input: $input) {
          project { id name description state targetDate lead { id name } }
        }
      }`, { id: args.id, input });
      return json(data.projectUpdate.project);
    }
    if (!args.name) throw new Error("VALIDATION_FAILED: `name` is required to create a project");
    const data = await gqlRequest(config, `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        project { id name description state targetDate lead { id name } }
      }
    }`, { input });
    return json(data.projectCreate.project);
  });

  return server;
}
