// MCP server de prime-board: tools espejo del MCP de Linear (spec §8),
// para que un agente que ya sabe operar Linear use prime-board sin cambios.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APP_VERSION } from "@prime-board/schema";
import { gqlRequest, type McpConfig, type McpSession } from "./api.ts";
import {
  resolveActor,
  resolveCycle,
  UUID_RE,
  resolveIssueId,
  resolveLabelIds,
  resolveMilestone,
  resolveProject,
  resolvePriority,
  resolveStateFilter,
  resolveTeam,
} from "./resolve.ts";

const ISSUE_FIELDS = `id identifier title description priority
  state { id name type } assignee { id name type } creator { id name type }
  labels { id name } project { id name } milestone { id name } cycle { id number name }
  parent { identifier }
  url branchName createdAt updatedAt`;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function createServer(config: McpConfig | McpSession): McpServer {
  // Una instancia MCP es una sesión fija: ninguna tool puede cambiar credencial o contexto.
  const sessionConfig: McpConfig = Object.freeze({ url: config.url, apiKey: config.apiKey });
  const server = new McpServer({ name: "prime-board", version: APP_VERSION });

  server.registerTool(
    "get_workspace",
    {
      description: "Retrieve the prime-board workspace.",
      inputSchema: {},
    },
    async () => {
      const data = await gqlRequest(
        sessionConfig,
        "{ workspace { id name urlKey } viewer { id name type } }",
      );
      return json(data);
    },
  );

  server.registerTool(
    "save_workspace",
    {
      description: "Rename the workspace. Only Workspace Admins can perform this operation.",
      inputSchema: { name: z.string().min(1).describe("New workspace name") },
    },
    async ({ name }) => {
      if (!name.trim()) throw new Error("VALIDATION_FAILED: `name` cannot be empty");
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: WorkspaceUpdateInput!) {
          workspaceUpdate(input: $input) { workspace { id name urlKey createdAt } }
        }`,
        { input: { name } },
      );
      return json(data.workspaceUpdate.workspace);
    },
  );

  server.registerTool(
    "list_teams",
    {
      description: "List teams in the workspace.",
      inputSchema: { includeArchived: z.boolean().optional() },
    },
    async ({ includeArchived }) =>
      json(
        (
          await gqlRequest(
            sessionConfig,
            "query($includeArchived: Boolean) { teams(includeArchived: $includeArchived) { id key name description archivedAt } }",
            { includeArchived: Boolean(includeArchived) },
          )
        ).teams,
      ),
  );

  server.registerTool(
    "get_team",
    {
      description: "Retrieve a team by key (e.g. PB) or ID, including its workflow states.",
      inputSchema: {
        team: z.string().describe("Team key or ID"),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ team, includeArchived }) =>
      json(await resolveTeam(sessionConfig, team, includeArchived)),
  );

  for (const [toolName, archived, description] of [
    ["archive_team", true, "Archive a team while preserving its history."],
    ["unarchive_team", false, "Restore an archived team and its normal operations."],
  ] as const) {
    server.registerTool(
      toolName,
      {
        description,
        inputSchema: { team: z.string().describe("Team key or ID") },
      },
      async ({ team }) => {
        const resolved = await resolveTeam(sessionConfig, team, !archived);
        const mutation = archived ? "teamArchive" : "teamUnarchive";
        const data = await gqlRequest(
          sessionConfig,
          `mutation($id: ID!) { ${mutation}(id: $id) { team { id key name description createdAt archivedAt } } }`,
          { id: resolved.id },
        );
        return json(data[mutation].team);
      },
    );
  }

  server.registerTool(
    "delete_team",
    {
      description:
        "Permanently delete an empty team. This removes its memberships and workflow states; Issues, Projects, Cycles, Labels, Saved Views and Initiatives must already be removed. Confirmation must exactly match the team key.",
      inputSchema: {
        team: z.string().describe("Team key or ID"),
        confirmation: z.string().min(1).describe("Exact team key confirmation"),
      },
    },
    async ({ team, confirmation }) => {
      const resolved = await resolveTeam(sessionConfig, team, true);
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!, $confirmation: String!) {
          teamDelete(id: $id, confirmation: $confirmation) { success }
        }`,
        { id: resolved.id, confirmation },
      );
      return json(data.teamDelete);
    },
  );

  server.registerTool(
    "save_team",
    {
      description: "Create or update a team. Provide id to update, otherwise name and key.",
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        key: z.string().optional(),
        description: z.string().optional(),
        defaultState: z.string().optional().describe("Workflow state ID"),
      },
    },
    async (args) => {
      if (args.id) {
        if (args.key !== undefined) {
          throw new Error("VALIDATION_FAILED: `key` can only be set when creating a team");
        }
        const input: Record<string, unknown> = {};
        if (args.name !== undefined) input.name = args.name;
        if (args.description !== undefined) input.description = args.description;
        if (args.defaultState !== undefined) input.defaultStateId = args.defaultState;
        const data = await gqlRequest(
          sessionConfig,
          `mutation($id: ID!, $input: TeamUpdateInput!) {
        teamUpdate(id: $id, input: $input) { team { id key name description createdAt archivedAt states { id name type color position } } }
      }`,
          { id: args.id, input },
        );
        return json(data.teamUpdate.team);
      }
      if (!args.name || !args.key)
        throw new Error("VALIDATION_FAILED: `name` and `key` are required to create a team");
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: TeamCreateInput!) {
      teamCreate(input: $input) { team { id key name description createdAt archivedAt states { id name type color position } } }
    }`,
        {
          input: {
            name: args.name,
            key: args.key,
            ...(args.description === undefined ? {} : { description: args.description }),
          },
        },
      );
      return json(data.teamCreate.team);
    },
  );

  server.registerTool(
    "list_team_memberships",
    {
      description: "List memberships for a team.",
      inputSchema: { team: z.string().describe("Team key or ID") },
    },
    async ({ team }) => {
      const teamId = (await resolveTeam(sessionConfig, team)).id;
      const data = await gqlRequest(
        sessionConfig,
        `query($teamId: ID!) { teamMemberships(teamId: $teamId) {
      id teamId actorId role createdAt team { id key name } actor { id name email type workspaceRole }
    } }`,
        { teamId },
      );
      return json(data.teamMemberships);
    },
  );

  server.registerTool(
    "save_team_membership",
    {
      description:
        "Add an actor to a team. The GraphQL API does not update memberships; omit id to create.",
      inputSchema: {
        team: z.string().describe("Team key or ID"),
        actor: z.string().describe('Actor ID, name or "me"'),
        role: z.enum(["member", "owner"]).optional(),
      },
    },
    async ({ team, actor, role }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: TeamMembershipCreateInput!) { teamMembershipCreate(input: $input) {
      membership { id teamId actorId role createdAt team { id key name } actor { id name email type workspaceRole } }
    } }`,
        {
          input: {
            teamId: (await resolveTeam(sessionConfig, team)).id,
            actorId: await resolveActor(sessionConfig, actor),
            ...(role === undefined ? {} : { role: role.toUpperCase() }),
          },
        },
      );
      return json(data.teamMembershipCreate.membership);
    },
  );

  server.registerTool(
    "delete_team_membership",
    { description: "Delete a team membership by ID.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`,
        { id },
      );
      return json(data.teamMembershipDelete);
    },
  );

  server.registerTool(
    "list_issue_statuses",
    {
      description: "List workflow states of a team.",
      inputSchema: { team: z.string().describe("Team key or ID") },
    },
    async ({ team }) => json((await resolveTeam(sessionConfig, team)).states),
  );

  server.registerTool(
    "save_issue_status",
    {
      description:
        "Create or update a workflow state. Provide id to update, otherwise team, name and type.",
      inputSchema: {
        id: z.string().optional(),
        team: z.string().optional().describe("Team key or ID (required to create)"),
        name: z.string().optional(),
        type: z
          .enum(["triage", "backlog", "unstarted", "started", "completed", "canceled"])
          .optional(),
        color: z.string().optional(),
        position: z.number().optional(),
      },
    },
    async (args) => {
      if (args.id) {
        const input: Record<string, unknown> = {};
        if (args.name !== undefined) input.name = args.name;
        if (args.type !== undefined) input.type = args.type.toUpperCase();
        if (args.color !== undefined) input.color = args.color;
        if (args.position !== undefined) input.position = args.position;
        if (!Object.keys(input).length)
          throw new Error("VALIDATION_FAILED: provide at least one field to update");
        const data = await gqlRequest(
          sessionConfig,
          `mutation($id: ID!, $input: WorkflowStateUpdateInput!) { workflowStateUpdate(id: $id, input: $input) {
        workflowState { id name type color position }
      } }`,
          { id: args.id, input },
        );
        return json(data.workflowStateUpdate.workflowState);
      }
      if (!args.team || !args.name || !args.type)
        throw new Error(
          "VALIDATION_FAILED: `team`, `name` and `type` are required to create a workflow state",
        );
      const input: Record<string, unknown> = {
        teamId: (await resolveTeam(sessionConfig, args.team)).id,
        name: args.name,
        type: args.type.toUpperCase(),
      };
      if (args.color !== undefined) input.color = args.color;
      if (args.position !== undefined) input.position = args.position;
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) {
      workflowState { id name type color position }
    } }`,
        { input },
      );
      return json(data.workflowStateCreate.workflowState);
    },
  );

  server.registerTool(
    "delete_issue_status",
    {
      description: "Delete a workflow state by ID, optionally moving its issues to another state.",
      inputSchema: { id: z.string(), moveTo: z.string().optional() },
    },
    async ({ id, moveTo }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!, $moveToStateId: ID) { workflowStateDelete(id: $id, moveToStateId: $moveToStateId) { success movedIssues } }`,
        { id, moveToStateId: moveTo ?? null },
      );
      return json(data.workflowStateDelete);
    },
  );

  server.registerTool(
    "list_users",
    {
      description: "List actors (humans and agents) in the workspace.",
      inputSchema: { type: z.enum(["human", "agent"]).optional() },
    },
    async ({ type }) => {
      const data = await gqlRequest(
        sessionConfig,
        `query($type: ActorType) {
      actors(type: $type) { id name email type status }
    }`,
        { type: type ? type.toUpperCase() : null },
      );
      return json(data.actors);
    },
  );

  server.registerTool(
    "save_user",
    {
      description: "Create or update an actor. Provide id to update, otherwise name and type.",
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        type: z.enum(["human", "agent"]).optional(),
        email: z.string().optional(),
      },
    },
    async (args) => {
      if (args.id) {
        if (args.type !== undefined) {
          throw new Error("VALIDATION_FAILED: `type` can only be set when creating an actor");
        }
        const input: Record<string, unknown> = {};
        if (args.name !== undefined) input.name = args.name;
        if (args.email !== undefined) input.email = args.email;
        const data = await gqlRequest(
          sessionConfig,
          `mutation($id: ID!, $input: ActorUpdateInput!) { actorUpdate(id: $id, input: $input) {
        actor { id name email type workspaceRole status createdAt }
      } }`,
          { id: args.id, input },
        );
        return json(data.actorUpdate.actor);
      }
      if (!args.name || !args.type)
        throw new Error("VALIDATION_FAILED: `name` and `type` are required to create an actor");
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: ActorCreateInput!) { actorCreate(input: $input) {
      actor { id name email type workspaceRole status createdAt }
    } }`,
        {
          input: {
            name: args.name,
            type: args.type.toUpperCase(),
            ...(args.email === undefined ? {} : { email: args.email }),
          },
        },
      );
      return json(data.actorCreate.actor);
    },
  );

  server.registerTool(
    "invite_user",
    {
      description: "Invite an actor. The bearer token is returned only once.",
      inputSchema: {
        email: z.string().optional(),
        name: z.string().optional(),
        type: z.enum(["human", "agent"]).optional(),
        expiresAt: z.string().optional(),
      },
    },
    async ({ email, name, type, expiresAt }) => {
      const input = {
        ...(email === undefined ? {} : { email }),
        ...(name === undefined ? {} : { name }),
        ...(type === undefined ? {} : { type: type.toUpperCase() }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: ActorInviteInput!) { actorInvite(input: $input) {
        invitation { id email name type status expiresAt } token
      } }`,
        { input },
      );
      return json(data.actorInvite);
    },
  );

  server.registerTool(
    "accept_invitation",
    {
      description: "Accept an invitation and receive a new API key once.",
      inputSchema: {
        token: z.string(),
        name: z.string().optional(),
        type: z.enum(["human", "agent"]).optional(),
      },
    },
    async ({ token, name, type }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($token: String!, $input: ActorInvitationAcceptInput!) {
        actorInvitationAccept(token: $token, input: $input) {
          actor { id name email type workspaceRole status createdAt } invitation { id status } key
        }
      }`,
        {
          token,
          input: {
            ...(name === undefined ? {} : { name }),
            ...(type === undefined ? {} : { type: type.toUpperCase() }),
          },
        },
      );
      return json(data.actorInvitationAccept);
    },
  );

  server.registerTool(
    "list_invitations",
    {
      description: "List pending or historical actor invitations (Workspace Admin only).",
      inputSchema: { includeRevoked: z.boolean().optional() },
    },
    async ({ includeRevoked }) => {
      const data = await gqlRequest(
        sessionConfig,
        `query($includeRevoked: Boolean) { actorInvitations(includeRevoked: $includeRevoked) {
        id email name type status actorId expiresAt createdAt
      } }`,
        { includeRevoked: includeRevoked ?? false },
      );
      return json(data.actorInvitations);
    },
  );

  server.registerTool(
    "revoke_invitation",
    {
      description: "Revoke a pending actor invitation.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { actorInvitationRevoke(id: $id) { success invitation { id status } } }`,
        { id },
      );
      return json(data.actorInvitationRevoke);
    },
  );

  for (const [tool, mutation, description] of [
    ["suspend_user", "actorSuspend", "Suspend an actor's access without deleting its identity."],
    ["reactivate_user", "actorReactivate", "Reactivate a suspended actor."],
    [
      "revoke_user",
      "actorRevoke",
      "Permanently revoke an actor's access while preserving history.",
    ],
  ] as const) {
    server.registerTool(
      tool,
      { description, inputSchema: { actor: z.string().describe('Actor ID, name or "me"') } },
      async ({ actor }) => {
        const data = await gqlRequest(
          sessionConfig,
          `mutation($id: ID!) { ${mutation}(id: $id) { success actor { id name email type workspaceRole status createdAt } } }`,
          { id: await resolveActor(sessionConfig, actor) },
        );
        return json(data[mutation]);
      },
    );
  }

  server.registerTool(
    "leave_workspace",
    {
      description: "Leave the current workspace as the authenticated actor.",
      inputSchema: {},
    },
    async () => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation { actorLeave { success actor { id name status } } }`,
      );
      return json(data.actorLeave);
    },
  );

  server.registerTool(
    "save_api_key",
    {
      description: "Create an API key for an actor. The secret is returned only once.",
      inputSchema: {
        actor: z.string().describe('Actor ID, name or "me"'),
        name: z.string(),
      },
    },
    async ({ actor, name }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: ApiKeyCreateInput!) { apiKeyCreate(input: $input) {
      apiKey { id name createdAt lastUsedAt actor { id name type } } key
    } }`,
        { input: { actorId: await resolveActor(sessionConfig, actor), name } },
      );
      return json(data.apiKeyCreate);
    },
  );

  server.registerTool(
    "delete_api_key",
    { description: "Delete an API key by ID.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { apiKeyDelete(id: $id) { success } }`,
        { id },
      );
      return json(data.apiKeyDelete);
    },
  );

  server.registerTool(
    "list_issue_labels",
    {
      description: "List labels available in the workspace or a team.",
      inputSchema: { team: z.string().optional().describe("Team key or ID") },
    },
    async ({ team }) => {
      const teamId = team ? (await resolveTeam(sessionConfig, team)).id : null;
      const data = await gqlRequest(
        sessionConfig,
        `query($team: ID) { labels(team: $team) { id name color teamId } }`,
        {
          team: teamId,
        },
      );
      return json(data.labels);
    },
  );

  server.registerTool(
    "save_issue_label",
    {
      description: "Create or update a label. Omit team to create a workspace label.",
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        color: z.string().optional(),
        team: z.string().optional().describe("Team key or ID (create only)"),
      },
    },
    async (args) => {
      if (args.id) {
        const input: Record<string, unknown> = {};
        if (args.name !== undefined) input.name = args.name;
        if (args.color !== undefined) input.color = args.color;
        if (!Object.keys(input).length)
          throw new Error("VALIDATION_FAILED: provide at least one field to update");
        const data = await gqlRequest(
          sessionConfig,
          `mutation($id: ID!, $input: LabelUpdateInput!) { labelUpdate(id: $id, input: $input) {
        label { id name color teamId }
      } }`,
          { id: args.id, input },
        );
        return json(data.labelUpdate.label);
      }
      if (!args.name) throw new Error("VALIDATION_FAILED: `name` is required to create a label");
      const input: Record<string, unknown> = { name: args.name };
      if (args.color !== undefined) input.color = args.color;
      if (args.team !== undefined) input.teamId = (await resolveTeam(sessionConfig, args.team)).id;
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: LabelCreateInput!) { labelCreate(input: $input) { label { id name color teamId } } }`,
        { input },
      );
      return json(data.labelCreate.label);
    },
  );

  server.registerTool(
    "delete_issue_label",
    { description: "Delete a label by ID.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { labelDelete(id: $id) { success affectedIssues } }`,
        { id },
      );
      return json(data.labelDelete);
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
        creator: z.string().optional().describe("Creator actor ID or name"),
        project: z.string().optional().describe("Project ID or name"),
        milestone: z.string().optional().describe("Milestone ID or name"),
        cycle: z.string().optional().describe("Cycle ID, number or name"),
        parent: z.string().optional().describe("Parent issue ID or identifier"),
        labels: z
          .array(z.string())
          .optional()
          .describe("Label IDs or names; requires team for names"),
        filter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Raw IssueFilter, including and/or comparators"),
        query: z.string().optional().describe("Full-text search on title/description"),
        includeArchived: z.boolean().optional().describe("Include archived issues"),
        unblocked: z
          .boolean()
          .optional()
          .describe(
            "true: open issues whose blockers are all closed (the frontier); false: issues with an open blocker",
          ),
        limit: z.number().int().min(1).max(250).optional(),
        after: z.string().optional().describe("Cursor from pageInfo.endCursor"),
        orderBy: z.enum(["CREATED_ASC", "CREATED_DESC", "UPDATED_ASC", "UPDATED_DESC"]).optional(),
      },
    },
    async (args) => {
      const filter: Record<string, unknown> = { ...(args.filter ?? {}) };
      let states = null;
      let teamId: string | undefined;
      if (args.team) {
        const team = await resolveTeam(sessionConfig, args.team, Boolean(args.includeArchived));
        teamId = team.id;
        filter.team = { eq: team.id };
        states = team.states;
      }
      if (args.state) Object.assign(filter, resolveStateFilter(states, args.state));
      if (args.assignee) filter.assignee = { eq: await resolveActor(sessionConfig, args.assignee) };
      if (args.creator) filter.creator = { eq: await resolveActor(sessionConfig, args.creator) };
      if (args.project) filter.project = { eq: await resolveProject(sessionConfig, args.project) };
      if (args.milestone)
        filter.milestone = { eq: await resolveMilestone(sessionConfig, args.milestone) };
      if (args.cycle) filter.cycle = { eq: await resolveCycle(sessionConfig, args.cycle, teamId) };
      if (args.parent) filter.parent = { eq: await resolveIssueId(sessionConfig, args.parent) };
      if (args.labels?.length) {
        const hasLabelName = args.labels.some((label) => !UUID_RE.test(label));
        if (!teamId && hasLabelName)
          throw new Error("VALIDATION_FAILED: team is required to resolve labels by name");
        const labelIds = await resolveLabelIds(sessionConfig, teamId, args.labels);
        filter.labels = { includesAll: labelIds };
      }
      if (args.query) filter.search = args.query;
      if (args.includeArchived !== undefined) filter.includeArchived = args.includeArchived;
      if (args.unblocked !== undefined) filter.unblocked = args.unblocked;
      const data = await gqlRequest(
        sessionConfig,
        `query($filter: IssueFilter, $first: Int, $after: String, $orderBy: IssueOrder) {
      issues(filter: $filter, first: $first, after: $after, orderBy: $orderBy) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`,
        {
          filter,
          first: args.limit ?? 50,
          after: args.after ?? null,
          orderBy: args.orderBy ?? null,
        },
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
        sessionConfig,
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
        description: z
          .union([z.string(), z.null()])
          .optional()
          .describe("Description; null explicitly clears it"),
        state: z.string().optional().describe("State name, semantic type or ID"),
        priority: z
          .union([z.number(), z.string()])
          .optional()
          .describe("0-4 or none|urgent|high|medium|low"),
        assignee: z
          .union([z.string(), z.null()])
          .optional()
          .describe('Actor ID, name, "me", or null to clear'),
        cycle: z
          .union([z.string(), z.null()])
          .optional()
          .describe("Cycle ID, number or name; null explicitly clears the cycle"),
        sortOrder: z.number().optional().describe("Board ordering position"),
        parent: z
          .union([z.string(), z.null()])
          .optional()
          .describe("Parent issue ID or identifier; null explicitly clears the parent"),
        project: z
          .union([z.string(), z.null()])
          .optional()
          .describe("Project ID or name; null explicitly clears the project"),
        milestone: z
          .union([z.string(), z.null()])
          .optional()
          .describe("Milestone ID or name; null explicitly clears the milestone"),
        labels: z.array(z.string()).optional().describe("Label names to set"),
      },
    },
    async (args) => {
      const input: Record<string, unknown> = {};
      if (args.title !== undefined) input.title = args.title;
      if (args.description !== undefined) input.description = args.description;
      if (args.priority !== undefined) input.priority = resolvePriority(args.priority);
      if (args.assignee !== undefined) {
        input.assigneeId =
          args.assignee === null ? null : await resolveActor(sessionConfig, args.assignee);
      }
      if (args.project !== undefined) {
        input.projectId =
          args.project === null ? null : await resolveProject(sessionConfig, args.project);
      }
      // Milestones are resolved after the issue/project context is known.
      if (args.cycle !== undefined || args.sortOrder !== undefined) {
        if (!args.id)
          throw new Error(
            "VALIDATION_FAILED: cycle and sortOrder are only supported when updating an issue",
          );
        const cycleTeam = await gqlRequest(
          sessionConfig,
          `query($id: ID!) { issue(id: $id) { team { id } } }`,
          { id: args.id },
        );
        if (!cycleTeam.issue) throw new Error(`NOT_FOUND: Issue not found: ${args.id}`);
        if (args.cycle !== undefined) {
          input.cycleId =
            args.cycle === null
              ? null
              : await resolveCycle(sessionConfig, args.cycle, cycleTeam.issue.team.id);
        }
        if (args.sortOrder !== undefined) input.sortOrder = args.sortOrder;
      }

      if (args.id) {
        // Update: resuelve team para estados/labels/parent.
        const existing = await gqlRequest(
          sessionConfig,
          `query($id: ID!) {
        issue(id: $id) {
          id project { id name }
          team { id key states { id name type } }
        }
      }`,
          { id: args.id },
        );
        if (!existing.issue) throw new Error(`NOT_FOUND: Issue not found: ${args.id}`);
        const team = existing.issue.team;
        if (args.milestone !== undefined) {
          input.milestoneId =
            args.milestone === null
              ? null
              : await resolveMilestone(
                  sessionConfig,
                  args.milestone,
                  typeof input.projectId === "string"
                    ? input.projectId
                    : existing.issue.project?.id,
                );
        }
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
            const parent = await gqlRequest(
              sessionConfig,
              `query($id: ID!) { issue(id: $id) { id } }`,
              {
                id: args.parent,
              },
            );
            if (!parent.issue) throw new Error(`NOT_FOUND: Parent issue not found: ${args.parent}`);
            input.parentId = parent.issue.id;
          }
        }
        if (args.labels)
          input.labelIds = await resolveLabelIds(sessionConfig, team.id, args.labels);
        const data = await gqlRequest(
          sessionConfig,
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
      const team = await resolveTeam(sessionConfig, args.team);
      input.teamId = team.id;
      if (args.number !== undefined) input.number = args.number;
      if (args.state) {
        const resolved = resolveStateFilter(team.states, args.state);
        input.stateId =
          resolved.state?.eq ??
          team.states.find((s: any) => s.type.toLowerCase() === args.state!.toLowerCase())?.id;
      }
      if (args.parent) {
        const parent = await gqlRequest(
          sessionConfig,
          `query($id: ID!) { issue(id: $id) { id } }`,
          {
            id: args.parent,
          },
        );
        if (!parent.issue) throw new Error(`NOT_FOUND: Parent issue not found: ${args.parent}`);
        input.parentId = parent.issue.id;
      }
      if (args.milestone !== undefined) {
        input.milestoneId =
          args.milestone === null
            ? null
            : await resolveMilestone(
                sessionConfig,
                args.milestone,
                typeof input.projectId === "string" ? input.projectId : undefined,
              );
      }
      if (args.labels?.length) {
        input.labelIds = await resolveLabelIds(sessionConfig, team.id, args.labels);
      }
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id ${ISSUE_FIELDS} } }
    }`,
        { input },
      );
      return json(data.issueCreate.issue);
    },
  );

  server.registerTool(
    "archive_issue",
    {
      description: "Archive an issue by ID or identifier.",
      inputSchema: { id: z.string().describe("Issue ID or identifier (e.g. PB-1)") },
    },
    async ({ id }) => {
      const existing = await gqlRequest(
        sessionConfig,
        `query($id: ID!) { issue(id: $id) { id } }`,
        {
          id,
        },
      );
      if (!existing.issue) throw new Error(`NOT_FOUND: Issue not found: ${id}`);
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { issueArchive(id: $id) { issue { ${ISSUE_FIELDS} archivedAt } } }`,
        { id: existing.issue.id },
      );
      return json(data.issueArchive.issue);
    },
  );

  server.registerTool(
    "list_cycles",
    {
      description: "List cycles for a team.",
      inputSchema: {
        team: z.string().describe("Team key or ID"),
        includeArchived: z.boolean().optional(),
      },
    },
    async ({ team, includeArchived }) => {
      const teamId = (await resolveTeam(sessionConfig, team, Boolean(includeArchived))).id;
      const data = await gqlRequest(
        sessionConfig,
        `query($teamId: ID!, $includeArchived: Boolean) {
      cycles(teamId: $teamId, includeArchived: $includeArchived) {
        id number name startsAt endsAt state progress completedIssues totalIssues archivedAt createdAt updatedAt
        team { id key name }
      }
    }`,
        { teamId, includeArchived: Boolean(includeArchived) },
      );
      return json(data.cycles);
    },
  );

  server.registerTool(
    "get_cycle",
    { description: "Retrieve a cycle by ID.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `query($id: ID!) { cycle(id: $id) {
          id number name startsAt endsAt state progress completedIssues totalIssues archivedAt createdAt updatedAt
          team { id key name }
        } }`,
        { id },
      );
      if (!data.cycle) throw new Error(`NOT_FOUND: Cycle not found: ${id}`);
      return json(data.cycle);
    },
  );

  server.registerTool(
    "save_cycle",
    {
      description: "Create or update a cycle. Provide id to update.",
      inputSchema: {
        id: z.string().optional(),
        team: z.string().optional(),
        name: z.string().optional(),
        startsAt: z.string().optional(),
        endsAt: z.string().optional(),
        state: z.enum(["upcoming", "active", "completed"]).optional(),
        archived: z.boolean().optional(),
      },
    },
    async (args) => {
      if (args.id) {
        const input: Record<string, unknown> = {};
        if (args.name !== undefined) input.name = args.name;
        if (args.startsAt !== undefined) input.startsAt = args.startsAt;
        if (args.endsAt !== undefined) input.endsAt = args.endsAt;
        if (args.state !== undefined) input.state = args.state.toUpperCase();
        if (args.archived !== undefined) input.archived = args.archived;
        const data = await gqlRequest(
          sessionConfig,
          `mutation($id: ID!, $input: CycleUpdateInput!) { cycleUpdate(id: $id, input: $input) {
            cycle { id number name startsAt endsAt state progress completedIssues totalIssues archivedAt createdAt updatedAt team { id key name } }
          } }`,
          { id: args.id, input },
        );
        return json(data.cycleUpdate.cycle);
      }
      if (!args.team || !args.name || !args.startsAt || !args.endsAt) {
        throw new Error(
          "VALIDATION_FAILED: `team`, `name`, `startsAt` and `endsAt` are required to create a cycle",
        );
      }
      const input: Record<string, unknown> = {
        teamId: (await resolveTeam(sessionConfig, args.team)).id,
        name: args.name,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
      };
      if (args.state !== undefined) input.state = args.state.toUpperCase();
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: CycleCreateInput!) { cycleCreate(input: $input) {
          cycle { id number name startsAt endsAt state progress completedIssues totalIssues archivedAt createdAt updatedAt team { id key name } }
        } }`,
        { input },
      );
      return json(data.cycleCreate.cycle);
    },
  );

  server.registerTool(
    "delete_cycle",
    { description: "Delete a cycle by ID.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { cycleDelete(id: $id) { success } }`,
        { id },
      );
      return json(data.cycleDelete);
    },
  );

  server.registerTool(
    "carry_over_cycle",
    {
      description: "Move open issues from one cycle to another.",
      inputSchema: { from: z.string(), to: z.string() },
    },
    async ({ from, to }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($from: ID!, $to: ID!) { cycleCarryOver(fromCycleId: $from, toCycleId: $to) { success movedIssues } }`,
        { from, to },
      );
      return json(data.cycleCarryOver);
    },
  );

  server.registerTool(
    "list_reviews",
    {
      description: "List reviews visible to the authenticated actor.",
      inputSchema: {
        openOnly: z.boolean().optional(),
        first: z.number().optional(),
        team: z.string().optional(),
        project: z.string().optional(),
        reviewer: z.string().optional(),
        olderThanDays: z.number().optional(),
      },
    },
    async ({ openOnly, first, team, project, reviewer, olderThanDays }) => {
      const data = await gqlRequest(
        sessionConfig,
        `query($openOnly: Boolean, $first: Int, $teamId: ID, $projectId: ID, $reviewerId: ID, $olderThanDays: Int) {
      reviews(openOnly: $openOnly, first: $first, teamId: $teamId, projectId: $projectId, reviewerId: $reviewerId, olderThanDays: $olderThanDays) {
        id status createdAt updatedAt issue { id identifier title } requester { id name type } reviewer { id name type }
      }
    }`,
        {
          openOnly: Boolean(openOnly),
          first: first ?? 50,
          teamId: team ? (await resolveTeam(sessionConfig, team)).id : null,
          projectId: project ?? null,
          reviewerId: reviewer ? await resolveActor(sessionConfig, reviewer) : null,
          olderThanDays: olderThanDays ?? null,
        },
      );
      return json(data.reviews);
    },
  );

  server.registerTool(
    "get_review",
    {
      description: "Retrieve a review visible to the authenticated actor.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `query($id: ID!) { review(id: $id) {
        id status createdAt updatedAt issue { id identifier title } requester { id name type } reviewer { id name type }
      } }`,
        { id },
      );
      if (!data.review) throw new Error(`NOT_FOUND: Review not found: ${id}`);
      return json(data.review);
    },
  );

  server.registerTool(
    "save_review",
    {
      description: "Create or update a review. Provide id to update.",
      inputSchema: {
        id: z.string().optional(),
        issue: z.string().optional(),
        reviewer: z.string().optional(),
        status: z.enum(["requested", "in_progress", "approved", "rejected"]).optional(),
      },
    },
    async (args) => {
      if (args.id) {
        const input: Record<string, unknown> = {};
        if (args.status !== undefined) input.status = args.status.toUpperCase();
        if (args.reviewer !== undefined)
          input.reviewerId = await resolveActor(sessionConfig, args.reviewer);
        const data = await gqlRequest(
          sessionConfig,
          `mutation($id: ID!, $input: ReviewUpdateInput!) { reviewUpdate(id: $id, input: $input) {
          review { id status createdAt updatedAt issue { id identifier title } requester { id name type } reviewer { id name type } }
        } }`,
          { id: args.id, input },
        );
        return json(data.reviewUpdate.review);
      }
      if (!args.issue || !args.reviewer)
        throw new Error(
          "VALIDATION_FAILED: `issue` and `reviewer` are required to create a review",
        );
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: ReviewCreateInput!) { reviewCreate(input: $input) {
        review { id status createdAt updatedAt issue { id identifier title } requester { id name type } reviewer { id name type } }
      } }`,
        {
          input: {
            issueId: args.issue,
            reviewerId: await resolveActor(sessionConfig, args.reviewer),
          },
        },
      );
      return json(data.reviewCreate.review);
    },
  );

  server.registerTool(
    "delete_review",
    {
      description: "Delete a review visible to the authenticated actor.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { reviewDelete(id: $id) { success } }`,
        { id },
      );
      return json(data.reviewDelete);
    },
  );

  server.registerTool(
    "list_initiatives",
    {
      description: "List initiatives visible to the authenticated actor.",
      inputSchema: { includeArchived: z.boolean().optional() },
    },
    async ({ includeArchived }) => {
      const data = await gqlRequest(
        sessionConfig,
        `query($includeArchived: Boolean) { initiatives(includeArchived: $includeArchived) {
        id name description state targetDate archivedAt progress completedIssues totalIssues createdAt updatedAt owner { id name type } projects { id name } teams { id key name }
      } }`,
        { includeArchived: Boolean(includeArchived) },
      );
      return json(data.initiatives);
    },
  );

  server.registerTool(
    "get_initiative",
    {
      description: "Retrieve an initiative visible to the authenticated actor.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `query($id: ID!) { initiative(id: $id) {
        id name description state targetDate archivedAt progress completedIssues totalIssues createdAt updatedAt owner { id name type } projects { id name } teams { id key name }
      } }`,
        { id },
      );
      if (!data.initiative) throw new Error(`NOT_FOUND: Initiative not found: ${id}`);
      return json(data.initiative);
    },
  );

  server.registerTool(
    "save_initiative",
    {
      description: "Create or update an initiative. Provide id to update.",
      inputSchema: {
        id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        state: z.enum(["planned", "active", "completed", "canceled"]).optional(),
        targetDate: z.string().optional(),
        projects: z.array(z.string()).optional(),
        teams: z.array(z.string()).optional(),
        archived: z.boolean().optional(),
      },
    },
    async (args) => {
      const input: Record<string, unknown> = {};
      if (args.name !== undefined) input.name = args.name;
      if (args.description !== undefined) input.description = args.description;
      if (args.state !== undefined) input.state = args.state.toUpperCase();
      if (args.targetDate !== undefined) input.targetDate = args.targetDate;
      if (args.projects !== undefined) input.projectIds = args.projects;
      if (args.teams !== undefined)
        input.teamIds = await Promise.all(
          args.teams.map(async (team) => (await resolveTeam(sessionConfig, team)).id),
        );
      if (args.archived !== undefined) input.archived = args.archived;
      if (args.id) {
        const data = await gqlRequest(
          sessionConfig,
          `mutation($id: ID!, $input: InitiativeUpdateInput!) { initiativeUpdate(id: $id, input: $input) { initiative {
          id name description state targetDate archivedAt progress completedIssues totalIssues createdAt updatedAt owner { id name type } projects { id name } teams { id key name }
        } } }`,
          { id: args.id, input },
        );
        return json(data.initiativeUpdate.initiative);
      }
      if (!args.name)
        throw new Error("VALIDATION_FAILED: `name` is required to create an initiative");
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: InitiativeCreateInput!) { initiativeCreate(input: $input) { initiative {
        id name description state targetDate archivedAt progress completedIssues totalIssues createdAt updatedAt owner { id name type } projects { id name } teams { id key name }
      } } }`,
        { input },
      );
      return json(data.initiativeCreate.initiative);
    },
  );

  server.registerTool(
    "delete_initiative",
    { description: "Delete an initiative by ID.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { initiativeDelete(id: $id) { success } }`,
        { id },
      );
      return json(data.initiativeDelete);
    },
  );

  server.registerTool(
    "list_inbox",
    {
      description: "List inbox activity for the authenticated actor.",
      inputSchema: { first: z.number().optional(), includeArchived: z.boolean().optional() },
    },
    async ({ first, includeArchived }) => {
      const data = await gqlRequest(
        sessionConfig,
        `query($first: Int, $includeArchived: Boolean) { inbox(first: $first, includeArchived: $includeArchived) {
        id type payload createdAt isRead isArchived actor { id name type } issue { id identifier title }
      } }`,
        { first: first ?? 50, includeArchived: Boolean(includeArchived) },
      );
      return json(data.inbox);
    },
  );

  server.registerTool(
    "mark_inbox_read",
    { description: "Mark an inbox item as read.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { inboxMarkRead(id: $id) { inboxItem {
        id type payload createdAt isRead isArchived actor { id name type } issue { id identifier title }
      } } }`,
        { id },
      );
      return json(data.inboxMarkRead.inboxItem);
    },
  );

  server.registerTool(
    "archive_inbox",
    { description: "Archive an inbox item.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { inboxArchive(id: $id) { inboxItem {
        id type payload createdAt isRead isArchived actor { id name type } issue { id identifier title }
      } } }`,
        { id },
      );
      return json(data.inboxArchive.inboxItem);
    },
  );

  server.registerTool(
    "list_favorites",
    { description: "List private favorites of the authenticated actor.", inputSchema: {} },
    async () => {
      const data = await gqlRequest(
        sessionConfig,
        `{ favorites {
        id position project { id name archivedAt } savedView { id name scope archivedAt }
      } }`,
      );
      return json(data.favorites);
    },
  );

  server.registerTool(
    "save_favorite",
    {
      description: "Create a private favorite for a project or saved view.",
      inputSchema: { project: z.string().optional(), savedView: z.string().optional() },
    },
    async ({ project, savedView }) => {
      if ((project ? 1 : 0) + (savedView ? 1 : 0) !== 1)
        throw new Error("VALIDATION_FAILED: exactly one of `project` or `savedView` is required");
      const input = project ? { projectId: project } : { savedViewId: savedView };
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: FavoriteCreateInput!) { favoriteCreate(input: $input) { favorite {
        id position project { id name archivedAt } savedView { id name scope archivedAt }
      } } }`,
        { input },
      );
      return json(data.favoriteCreate.favorite);
    },
  );

  server.registerTool(
    "delete_favorite",
    { description: "Delete a private favorite by ID.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { favoriteDelete(id: $id) { success } }`,
        { id },
      );
      return json(data.favoriteDelete);
    },
  );

  server.registerTool(
    "reorder_favorite",
    {
      description: "Move a private favorite to a position.",
      inputSchema: { id: z.string(), position: z.number().int().min(0) },
    },
    async ({ id, position }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!, $position: Int!) { favoriteReorder(id: $id, position: $position) { favorite {
        id position project { id name archivedAt } savedView { id name scope archivedAt }
      } } }`,
        { id, position },
      );
      return json(data.favoriteReorder.favorite);
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
        sessionConfig,
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
          sessionConfig,
          `query($id: ID!) {
        issue(id: $id) { identifier relations { id type relatedIssue { identifier } } }
      }`,
          { id: issue },
        ),
        gqlRequest(sessionConfig, `query($id: ID!) { issue(id: $id) { identifier } }`, {
          id: relatedIssue,
        }),
      ]);
      if (!source.issue) throw new Error(`NOT_FOUND: Issue not found: ${issue}`);
      if (!other.issue) throw new Error(`NOT_FOUND: Issue not found: ${relatedIssue}`);
      const matches = source.issue.relations.filter(
        (relation: any) =>
          relation.relatedIssue.identifier === other.issue.identifier &&
          (!type ||
            relation.type === type.toUpperCase() ||
            (type === "duplicate_of" && relation.type === "DUPLICATED_BY")),
      );
      if (matches.length === 0) {
        throw new Error(
          `NOT_FOUND: No${type ? ` ${type}` : ""} relation between ${source.issue.identifier} and ${other.issue.identifier}`,
        );
      }
      for (const relation of matches) {
        await gqlRequest(
          sessionConfig,
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
        sessionConfig,
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
        sessionConfig,
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
      const teamId = team ? (await resolveTeam(sessionConfig, team)).id : null;
      const data = await gqlRequest(
        sessionConfig,
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
        sessionConfig,
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
          args.teams.map(async (ref: string) => (await resolveTeam(sessionConfig, ref)).id),
        );
      }
      if (args.name !== undefined) input.name = args.name;
      if (args.description !== undefined) input.description = args.description;
      if (args.state !== undefined) input.state = args.state.toUpperCase();
      if (args.lead !== undefined) input.leadId = await resolveActor(sessionConfig, args.lead);
      if (args.targetDate !== undefined) input.targetDate = args.targetDate;

      if (args.id) {
        const data = await gqlRequest(
          sessionConfig,
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
        sessionConfig,
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
        sessionConfig,
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
        sessionConfig,
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
        sessionConfig,
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
          sessionConfig,
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
        sessionConfig,
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
        sessionConfig,
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
        sessionConfig,
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
        sessionConfig,
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
        sessionConfig,
        `mutation($id: ID!) { projectUpdateDelete(id: $id) { success } }`,
        { id },
      );
      return json(data.projectUpdateDelete);
    },
  );

  server.registerTool(
    "list_webhooks",
    {
      description: "List webhook subscriptions. Secrets are never returned by this tool.",
      inputSchema: {},
    },
    async () => {
      const data = await gqlRequest(
        sessionConfig,
        `{ webhooks { id url events enabled createdAt } }`,
      );
      return json(data.webhooks);
    },
  );

  server.registerTool(
    "create_webhook",
    {
      description: "Create a webhook subscription. The signing secret is returned once.",
      inputSchema: {
        url: z.string().url(),
        events: z.array(z.string()).optional().describe("Event names; omitted subscribes to all"),
        secret: z.string().optional().describe("Optional signing secret"),
      },
    },
    async ({ url, events, secret }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) {
          webhook { id url events enabled createdAt } secret
        } }`,
        {
          input: {
            url,
            ...(events === undefined ? {} : { events }),
            ...(secret === undefined ? {} : { secret }),
          },
        },
      );
      return json(data.webhookCreate);
    },
  );

  server.registerTool(
    "delete_webhook",
    {
      description: "Delete a webhook subscription by ID.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { webhookDelete(id: $id) { success } }`,
        { id },
      );
      return json(data.webhookDelete);
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
      const teamId = team ? (await resolveTeam(sessionConfig, team)).id : null;
      const data = await gqlRequest(
        sessionConfig,
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
          sessionConfig,
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
      if (args.team) input.teamId = (await resolveTeam(sessionConfig, args.team)).id;
      if (args.orderBy) input.orderBy = args.orderBy.toUpperCase();
      if (args.groupBy) input.groupBy = args.groupBy;
      if (args.columns) input.columns = args.columns;
      const data = await gqlRequest(
        sessionConfig,
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
    "duplicate_saved_view",
    {
      description:
        "Duplicate a visible saved view, preserving its filter, order, grouping and columns.",
      inputSchema: { id: z.string().describe("Saved view ID") },
    },
    async ({ id }) => {
      const data = await gqlRequest(
        sessionConfig,
        `mutation($id: ID!) { savedViewDuplicate(id: $id) {
          savedView { id name scope filter orderBy groupBy columns archivedAt team { id key } owner { id name } }
        } }`,
        { id },
      );
      return json(data.savedViewDuplicate.savedView);
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
        sessionConfig,
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
