// Tests e2e de AT-142: cliente MCP real → stdio → pb-mcp → GraphQL server.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PORT = 3393;
let tempDir: string;
let server: Bun.Subprocess;
let client: Client;

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "pb-mcp-test-"));
  server = Bun.spawn(["bun", join(ROOT, "apps/server/src/index.ts")], {
    env: {
      ...process.env,
      PRIME_BOARD_DB: join(tempDir, "test.db"),
      PRIME_BOARD_PORT: String(PORT),
    },
    stdout: "pipe",
  });
  const stdout = server.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("listening")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
  }
  reader.releaseLock();
  const apiKey = buffer.match(/Admin API key.*: (pb_\S+)/)![1]!;

  // El cliente MCP lanza el server pb-mcp por stdio.
  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: [join(ROOT, "apps/mcp/src/index.ts")],
      env: {
        ...(process.env as Record<string, string>),
        PRIME_BOARD_URL: `http://localhost:${PORT}`,
        PRIME_BOARD_API_KEY: apiKey,
      },
    }),
  );
});

afterAll(async () => {
  await client.close();
  server.kill();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("mcp tools", () => {
  it("expone las tools espejo de Linear más vistas guardadas y link/unlink", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "accept_invitation",
      "archive_inbox",
      "archive_issue",
      "archive_project",
      "archive_team",
      "carry_over_cycle",
      "create_webhook",
      "delete_api_key",
      "delete_cycle",
      "delete_favorite",
      "delete_initiative",
      "delete_issue_label",
      "delete_issue_status",
      "delete_milestone",
      "delete_project_update",
      "delete_review",
      "delete_saved_view",
      "delete_team",
      "delete_team_membership",
      "delete_webhook",
      "duplicate_saved_view",
      "get_cycle",
      "get_initiative",
      "get_issue",
      "get_project",
      "get_review",
      "get_team",
      "get_workspace",
      "invite_user",
      "leave_workspace",
      "link_issues",
      "list_api_keys",
      "list_comments",
      "list_cycles",
      "list_favorites",
      "list_inbox",
      "list_initiatives",
      "list_invitations",
      "list_issue_labels",
      "list_issue_statuses",
      "list_issues",
      "list_milestones",
      "list_project_updates",
      "list_projects",
      "list_reviews",
      "list_saved_views",
      "list_team_memberships",
      "list_teams",
      "list_users",
      "list_webhooks",
      "mark_inbox_read",
      "reactivate_user",
      "reorder_favorite",
      "revoke_invitation",
      "revoke_user",
      "rotate_api_key",
      "save_api_key",
      "save_comment",
      "save_cycle",
      "save_favorite",
      "save_initiative",
      "save_issue",
      "save_issue_label",
      "save_issue_status",
      "save_milestone",
      "save_project",
      "save_project_update",
      "save_review",
      "save_saved_view",
      "save_team",
      "save_team_membership",
      "save_user",
      "save_workspace",
      "suspend_user",
      "unarchive_project",
      "unarchive_team",
      "unlink_issues",
    ]);
  });

  it("get_workspace y list_teams responden", async () => {
    const workspace = parseResult(await client.callTool({ name: "get_workspace", arguments: {} }));
    expect(workspace.workspace.name).toBe("workspace");
    const teams = parseResult(await client.callTool({ name: "list_teams", arguments: {} }));
    expect(teams[0].key).toBe("PB");
  });

  it("save_workspace renombra y conserva urlKey", async () => {
    const renamed = parseResult(
      await client.callTool({ name: "save_workspace", arguments: { name: "MCP Workspace" } }),
    );
    expect(renamed).toMatchObject({ name: "MCP Workspace", urlKey: "prime-board" });
    const current = parseResult(await client.callTool({ name: "get_workspace", arguments: {} }));
    expect(current.workspace).toMatchObject({ name: "MCP Workspace", urlKey: "prime-board" });
  });

  it("archiva y restaura teams conservando la consulta histórica", async () => {
    const team = parseResult(
      await client.callTool({
        name: "save_team",
        arguments: { name: "MCP archive team", key: "MARC" },
      }),
    );
    const archived = parseResult(
      await client.callTool({ name: "archive_team", arguments: { team: team.id } }),
    );
    expect(archived).toMatchObject({ id: team.id, key: "MARC" });
    expect(archived.archivedAt).toBeTruthy();
    const hidden = parseResult(await client.callTool({ name: "list_teams", arguments: {} }));
    expect(hidden.map((item: any) => item.key)).not.toContain("MARC");
    const history = parseResult(
      await client.callTool({ name: "list_teams", arguments: { includeArchived: true } }),
    );
    expect(history.find((item: any) => item.key === "MARC").archivedAt).toBeTruthy();
    const restored = parseResult(
      await client.callTool({ name: "unarchive_team", arguments: { team: "MARC" } }),
    );
    expect(restored.archivedAt).toBeNull();
  });

  it("borra definitivamente un Team vacío con confirmación explícita", async () => {
    const team = parseResult(
      await client.callTool({
        name: "save_team",
        arguments: { name: "MCP disposable", key: "MDL" },
      }),
    );
    const mismatch = await client.callTool({
      name: "delete_team",
      arguments: { team: team.id, confirmation: "WRONG" },
    });
    expect(mismatch.isError).toBe(true);
    expect(JSON.stringify(mismatch)).toContain("VALIDATION_FAILED");
    const deleted = parseResult(
      await client.callTool({
        name: "delete_team",
        arguments: { team: "MDL", confirmation: "MDL" },
      }),
    );
    expect(deleted).toEqual({ success: true });
    const history = parseResult(
      await client.callTool({ name: "list_teams", arguments: { includeArchived: true } }),
    );
    expect(history.map((item: any) => item.key)).not.toContain("MDL");
  });

  it("administra teams, actores, memberships, estados, labels y API keys", async () => {
    const team = parseResult(
      await client.callTool({
        name: "save_team",
        arguments: { name: "MCP admin team", key: "MADM" },
      }),
    );
    const updatedTeam = parseResult(
      await client.callTool({
        name: "save_team",
        arguments: { id: team.id, name: "MCP managed team" },
      }),
    );
    expect(updatedTeam.name).toBe("MCP managed team");
    const invalidTeamKey = await client.callTool({
      name: "save_team",
      arguments: { id: team.id, key: "OTHER" },
    });
    expect(invalidTeamKey.isError).toBe(true);
    expect(JSON.stringify(invalidTeamKey)).toContain("key");

    const actor = parseResult(
      await client.callTool({
        name: "save_user",
        arguments: { name: "mcp-managed-agent", type: "agent" },
      }),
    );
    const updatedActor = parseResult(
      await client.callTool({
        name: "save_user",
        arguments: { id: actor.id, email: "mcp@example.test" },
      }),
    );
    expect(updatedActor.email).toBe("mcp@example.test");
    const invalidActorType = await client.callTool({
      name: "save_user",
      arguments: { id: actor.id, type: "human" },
    });
    expect(invalidActorType.isError).toBe(true);
    expect(JSON.stringify(invalidActorType)).toContain("type");

    const key = parseResult(
      await client.callTool({
        name: "save_api_key",
        arguments: { actor: actor.id, name: "MCP managed key" },
      }),
    );
    expect(key.key).toMatch(/^pb_/);

    const membership = parseResult(
      await client.callTool({
        name: "save_team_membership",
        arguments: { team: "MADM", actor: actor.id, role: "member" },
      }),
    );
    const memberships = parseResult(
      await client.callTool({ name: "list_team_memberships", arguments: { team: "MADM" } }),
    );
    expect(memberships.map((item: any) => item.actorId)).toContain(actor.id);

    const state = parseResult(
      await client.callTool({
        name: "save_issue_status",
        arguments: { team: "MADM", name: "QA", type: "started" },
      }),
    );
    const updatedState = parseResult(
      await client.callTool({
        name: "save_issue_status",
        arguments: { id: state.id, name: "QA Ready" },
      }),
    );
    expect(updatedState.name).toBe("QA Ready");

    const label = parseResult(
      await client.callTool({
        name: "save_issue_label",
        arguments: { team: "MADM", name: "qa" },
      }),
    );
    const updatedLabel = parseResult(
      await client.callTool({
        name: "save_issue_label",
        arguments: { id: label.id, name: "qa-ready" },
      }),
    );
    expect(updatedLabel.name).toBe("qa-ready");

    expect(
      parseResult(
        await client.callTool({ name: "delete_issue_label", arguments: { id: label.id } }),
      ),
    ).toEqual({ success: true, affectedIssues: 0 });
    expect(
      parseResult(
        await client.callTool({ name: "delete_issue_status", arguments: { id: state.id } }),
      ),
    ).toEqual({ success: true, movedIssues: 0 });
    expect(
      parseResult(
        await client.callTool({ name: "delete_team_membership", arguments: { id: membership.id } }),
      ),
    ).toEqual({ success: true });
    expect(
      parseResult(
        await client.callTool({ name: "delete_api_key", arguments: { id: key.apiKey.id } }),
      ),
    ).toEqual({ success: true });
  });

  it("save_issue crea y actualiza con referencias amigables", async () => {
    const created = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { team: "PB", title: "From MCP", priority: "urgent", assignee: "me" },
      }),
    );
    expect(created.identifier).toBe("PB-1");
    expect(created.priority).toBe(1);
    expect(created.assignee.name).toBe("admin");

    const updated = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { id: "PB-1", state: "started" },
      }),
    );
    expect(updated.state.type).toBe("STARTED");

    const parent = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { team: "PB", title: "MCP parent" },
      }),
    );
    const parented = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { id: "PB-1", parent: parent.identifier },
      }),
    );
    expect(parented.parent.identifier).toBe(parent.identifier);

    const invalidParent = await client.callTool({
      name: "save_issue",
      arguments: { id: "PB-1", parent: "PB-404" },
    });
    expect(invalidParent.isError).toBe(true);
    expect(JSON.stringify(invalidParent)).toContain("NOT_FOUND");

    const unchanged = parseResult(
      await client.callTool({ name: "get_issue", arguments: { id: "PB-1" } }),
    );
    expect(unchanged.parent.identifier).toBe(parent.identifier);

    const detached = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { id: "PB-1", parent: null },
      }),
    );
    expect(detached.parent).toBeNull();
  });

  it("save_issue distingue omission de null al limpiar assignee, project y milestone", async () => {
    const project = parseResult(
      await client.callTool({ name: "save_project", arguments: { name: "MCP clear fields" } }),
    );
    const milestone = parseResult(
      await client.callTool({
        name: "save_milestone",
        arguments: { project: project.id, name: "MCP clear milestone" },
      }),
    );
    const issue = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: {
          team: "PB",
          title: "MCP nullable fields",
          description: "initial description",
          assignee: "me",
          project: project.id,
          milestone: milestone.id,
        },
      }),
    );
    const unchanged = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { id: issue.id, title: "MCP nullable fields renamed" },
      }),
    );
    expect(unchanged.assignee.name).toBe("admin");
    expect(unchanged.project.id).toBe(project.id);
    expect(unchanged.milestone.id).toBe(milestone.id);
    const cleared = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: {
          id: issue.id,
          description: null,
          assignee: null,
          project: null,
          milestone: null,
        },
      }),
    );
    expect(cleared.description).toBeNull();
    expect(cleared.assignee).toBeNull();
    expect(cleared.project).toBeNull();
    expect(cleared.milestone).toBeNull();
  });

  it("save_comment y get_issue con historial", async () => {
    await client.callTool({
      name: "save_comment",
      arguments: { issue: "PB-1", body: "hello from MCP" },
    });
    const issue = parseResult(
      await client.callTool({ name: "get_issue", arguments: { id: "PB-1" } }),
    );
    expect(issue.comments[0].body).toBe("hello from MCP");
    expect(issue.activity.map((a: any) => a.type)).toEqual([
      "created",
      "state_changed",
      "parent_changed",
      "parent_changed",
      "commented",
    ]);
  });

  it("list_issues filtra por estado semántico y búsqueda", async () => {
    const found = parseResult(
      await client.callTool({
        name: "list_issues",
        arguments: { team: "PB", state: "started", query: "mcp" },
      }),
    );
    expect(found.nodes.map((n: any) => n.identifier)).toEqual(["PB-1"]);
  });

  it("list_issues filtra por label ID sin exigir team", async () => {
    const label = parseResult(
      await client.callTool({
        name: "save_issue_label",
        arguments: { team: "PB", name: "mcp-id-filter" },
      }),
    );
    const issue = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { team: "PB", title: "MCP label ID filter", labels: [label.id] },
      }),
    );
    const found = parseResult(
      await client.callTool({
        name: "list_issues",
        arguments: { labels: [label.id] },
      }),
    );
    expect(found.nodes.map((node: any) => node.identifier)).toContain(issue.identifier);
  });

  it("gestiona webhooks y duplica saved views sin filtrar secretos", async () => {
    const created = parseResult(
      await client.callTool({
        name: "create_webhook",
        arguments: { url: "https://example.test/hooks", events: ["issue.created"] },
      }),
    );
    expect(created.webhook.url).toBe("https://example.test/hooks");
    expect(typeof created.secret).toBe("string");
    const listed = parseResult(await client.callTool({ name: "list_webhooks", arguments: {} }));
    expect(listed.find((item: any) => item.id === created.webhook.id)).not.toHaveProperty("secret");
    expect(
      parseResult(
        await client.callTool({ name: "delete_webhook", arguments: { id: created.webhook.id } }),
      ),
    ).toEqual({ success: true });

    const view = parseResult(
      await client.callTool({
        name: "save_saved_view",
        arguments: {
          name: "MCP duplicate source",
          scope: "personal",
          orderBy: "updated_desc",
          groupBy: "priority",
          columns: ["title"],
          filter: { priority: { eq: 1 } },
        },
      }),
    );
    const duplicate = parseResult(
      await client.callTool({ name: "duplicate_saved_view", arguments: { id: view.id } }),
    );
    expect(duplicate.id).not.toBe(view.id);
    expect(duplicate.filter).toEqual({ priority: { eq: 1 } });
    expect(duplicate.orderBy).toBe(view.orderBy);
    expect(duplicate.groupBy).toBe(view.groupBy);
    expect(duplicate.columns).toEqual(view.columns);
  });

  it("list_issues recorre cursores y filtros de creator/parent", async () => {
    const first = parseResult(
      await client.callTool({
        name: "list_issues",
        arguments: { team: "PB", limit: 1, orderBy: "CREATED_ASC" },
      }),
    );
    expect(first.nodes).toHaveLength(1);
    expect(first.pageInfo.endCursor).toBeTruthy();
    const second = parseResult(
      await client.callTool({
        name: "list_issues",
        arguments: {
          team: "PB",
          limit: 1,
          orderBy: "CREATED_ASC",
          after: first.pageInfo.endCursor,
        },
      }),
    );
    expect(second.nodes).toHaveLength(1);
    expect(second.nodes[0].identifier).not.toBe(first.nodes[0].identifier);
    const filtered = parseResult(
      await client.callTool({
        name: "list_issues",
        arguments: { team: "PB", creator: "me", parent: first.nodes[0].identifier },
      }),
    );
    expect(
      filtered.nodes.every((item: any) => item.parent.identifier === first.nodes[0].identifier),
    ).toBe(true);
  });

  it("save_project y get_project", async () => {
    const project = parseResult(
      await client.callTool({
        name: "save_project",
        arguments: { name: "MCP project", state: "started", lead: "me" },
      }),
    );
    expect(project.lead.name).toBe("admin");
    await client.callTool({ name: "save_issue", arguments: { id: "PB-1", project: project.id } });
    const fetched = parseResult(
      await client.callTool({ name: "get_project", arguments: { id: project.id } }),
    );
    expect(fetched.issues.nodes.map((n: any) => n.identifier)).toEqual(["PB-1"]);
  });

  it("rechaza referencias ambiguas y acepta scopes cualificados", async () => {
    const first = parseResult(
      await client.callTool({ name: "save_project", arguments: { name: "MCP ambiguous project" } }),
    );
    await client.callTool({ name: "save_project", arguments: { name: "MCP ambiguous project" } });
    const ambiguousProject = await client.callTool({
      name: "list_issues",
      arguments: { project: "MCP ambiguous project" },
    });
    expect(ambiguousProject.isError).toBe(true);
    expect(JSON.stringify(ambiguousProject)).toContain("ambiguous");

    const firstMilestone = parseResult(
      await client.callTool({
        name: "save_milestone",
        arguments: { project: first.id, name: "MCP ambiguous milestone" },
      }),
    );
    const second = parseResult(
      await client.callTool({ name: "save_project", arguments: { name: "MCP other project" } }),
    );
    await client.callTool({
      name: "save_milestone",
      arguments: { project: second.id, name: "MCP ambiguous milestone" },
    });
    const ambiguousMilestone = await client.callTool({
      name: "list_issues",
      arguments: { milestone: "MCP ambiguous milestone" },
    });
    expect(ambiguousMilestone.isError).toBe(true);
    const issue = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: {
          team: "PB",
          title: "MCP qualified milestone",
          project: first.id,
          milestone: "MCP ambiguous project/MCP ambiguous milestone",
        },
      }),
    );
    expect(issue.milestone.id).toBe(firstMilestone.id);

    const workspaceLabel = parseResult(
      await client.callTool({
        name: "save_issue_label",
        arguments: { name: "MCP scoped label" },
      }),
    );
    const teamLabel = parseResult(
      await client.callTool({
        name: "save_issue_label",
        arguments: { team: "PB", name: "MCP scoped label" },
      }),
    );
    const labeled = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { team: "PB", title: "MCP scoped label issue", labels: ["MCP scoped label"] },
      }),
    );
    expect(labeled.labels.map((label: any) => label.id)).toContain(teamLabel.id);
    expect(labeled.labels.map((label: any) => label.id)).not.toContain(workspaceLabel.id);
  });

  it("expone el ciclo de vida de proyectos, milestones y updates", async () => {
    const project = parseResult(
      await client.callTool({ name: "save_project", arguments: { name: "MCP lifecycle" } }),
    );
    const archived = parseResult(
      await client.callTool({ name: "archive_project", arguments: { id: project.id } }),
    );
    expect(archived.archivedAt).not.toBeNull();
    const hidden = parseResult(await client.callTool({ name: "list_projects", arguments: {} }));
    expect(hidden.map((item: any) => item.id)).not.toContain(project.id);
    const included = parseResult(
      await client.callTool({ name: "list_projects", arguments: { includeArchived: true } }),
    );
    expect(included.find((item: any) => item.id === project.id).archivedAt).not.toBeNull();
    const unarchived = parseResult(
      await client.callTool({ name: "unarchive_project", arguments: { id: project.id } }),
    );
    expect(unarchived.archivedAt).toBeNull();

    const milestone = parseResult(
      await client.callTool({
        name: "save_milestone",
        arguments: { project: project.id, name: "MCP milestone" },
      }),
    );
    const milestones = parseResult(
      await client.callTool({ name: "list_milestones", arguments: { project: project.id } }),
    );
    expect(milestones.map((item: any) => item.id)).toEqual([milestone.id]);
    const renamed = parseResult(
      await client.callTool({
        name: "save_milestone",
        arguments: { id: milestone.id, name: "MCP milestone updated" },
      }),
    );
    expect(renamed.name).toBe("MCP milestone updated");
    expect(
      parseResult(
        await client.callTool({ name: "delete_milestone", arguments: { id: milestone.id } }),
      ),
    ).toEqual({ success: true, orphanedIssues: 0 });

    const update = parseResult(
      await client.callTool({
        name: "save_project_update",
        arguments: { project: project.id, health: "on_track", body: "MCP update" },
      }),
    );
    const updates = parseResult(
      await client.callTool({ name: "list_project_updates", arguments: { project: project.id } }),
    );
    expect(updates.map((item: any) => item.id)).toEqual([update.id]);
    expect(
      parseResult(
        await client.callTool({ name: "delete_project_update", arguments: { id: update.id } }),
      ),
    ).toEqual({ success: true });
  });

  it("expone cycles, reviews, initiatives, inbox y favorites", async () => {
    const cycle = parseResult(
      await client.callTool({
        name: "save_cycle",
        arguments: { team: "PB", name: "MCP cycle", startsAt: "2031-01-01", endsAt: "2031-01-14" },
      }),
    );
    expect(cycle.name).toBe("MCP cycle");
    expect(
      parseResult(await client.callTool({ name: "list_cycles", arguments: { team: "PB" } })),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: cycle.id })]));
    const secondCycle = parseResult(
      await client.callTool({
        name: "save_cycle",
        arguments: {
          team: "PB",
          name: "MCP cycle 2",
          startsAt: "2031-02-01",
          endsAt: "2031-02-14",
        },
      }),
    );
    expect(
      parseResult(
        await client.callTool({
          name: "carry_over_cycle",
          arguments: { from: cycle.id, to: secondCycle.id },
        }),
      ),
    ).toEqual({ success: true, movedIssues: 0 });
    expect(
      parseResult(await client.callTool({ name: "delete_cycle", arguments: { id: cycle.id } })),
    ).toEqual({ success: true });
    expect(
      parseResult(
        await client.callTool({ name: "delete_cycle", arguments: { id: secondCycle.id } }),
      ),
    ).toEqual({ success: true });

    const issue = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { team: "PB", title: "MCP review target" },
      }),
    );
    const review = parseResult(
      await client.callTool({
        name: "save_review",
        arguments: { issue: issue.identifier, reviewer: "me" },
      }),
    );
    expect(review.status).toBe("REQUESTED");
    expect(
      parseResult(
        await client.callTool({
          name: "save_review",
          arguments: { id: review.id, status: "approved" },
        }),
      ),
    ).toMatchObject({ status: "APPROVED" });
    expect(
      parseResult(await client.callTool({ name: "delete_review", arguments: { id: review.id } })),
    ).toEqual({ success: true });

    const initiative = parseResult(
      await client.callTool({ name: "save_initiative", arguments: { name: "MCP initiative" } }),
    );
    expect(parseResult(await client.callTool({ name: "list_initiatives", arguments: {} }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: initiative.id })]),
    );
    expect(
      parseResult(
        await client.callTool({ name: "delete_initiative", arguments: { id: initiative.id } }),
      ),
    ).toEqual({ success: true });

    const project = parseResult(
      await client.callTool({ name: "save_project", arguments: { name: "MCP favorite project" } }),
    );
    const favorite = parseResult(
      await client.callTool({ name: "save_favorite", arguments: { project: project.id } }),
    );
    expect(parseResult(await client.callTool({ name: "list_favorites", arguments: {} }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: favorite.id })]),
    );
    expect(
      parseResult(
        await client.callTool({
          name: "reorder_favorite",
          arguments: { id: favorite.id, position: 0 },
        }),
      ),
    ).toMatchObject({ id: favorite.id, position: 0 });
    expect(
      parseResult(
        await client.callTool({ name: "delete_favorite", arguments: { id: favorite.id } }),
      ),
    ).toEqual({ success: true });

    expect(
      Array.isArray(parseResult(await client.callTool({ name: "list_inbox", arguments: {} }))),
    ).toBe(true);
    expect(
      (await client.callTool({ name: "mark_inbox_read", arguments: { id: "missing-inbox" } }))
        .isError,
    ).toBe(true);
    expect(
      (await client.callTool({ name: "archive_inbox", arguments: { id: "missing-inbox" } }))
        .isError,
    ).toBe(true);
  });

  it("los errores de la API viajan como errores MCP", async () => {
    const result = await client.callTool({ name: "get_issue", arguments: { id: "PB-99" } });
    expect(result.isError).toBe(true);
  });
});

describe("mcp issue relations (AT-179)", () => {
  it("link_issues crea la relación y get_issue la muestra desde ambos extremos", async () => {
    await client.callTool({ name: "save_issue", arguments: { team: "PB", title: "Blocker" } });
    const linked = parseResult(
      await client.callTool({
        name: "link_issues",
        arguments: { issue: "PB-1", relatedIssue: "PB-2", type: "blocked_by" },
      }),
    );
    expect(linked).toMatchObject({ type: "BLOCKED_BY", relatedIssue: { identifier: "PB-2" } });

    const other = parseResult(
      await client.callTool({ name: "get_issue", arguments: { id: "PB-2" } }),
    );
    expect(other.relations).toMatchObject([
      { type: "BLOCKS", relatedIssue: { identifier: "PB-1" } },
    ]);
  });

  it("list_issues con unblocked deja fuera al bloqueado", async () => {
    const frontier = parseResult(
      await client.callTool({
        name: "list_issues",
        arguments: { team: "PB", unblocked: true },
      }),
    );
    const identifiers = frontier.nodes.map((n: any) => n.identifier);
    expect(identifiers).toContain("PB-2");
    expect(identifiers).not.toContain("PB-1");
  });

  it("un ciclo de bloqueo viaja como error MCP", async () => {
    const result = await client.callTool({
      name: "link_issues",
      arguments: { issue: "PB-2", relatedIssue: "PB-1", type: "blocked_by" },
    });
    expect(result.isError).toBe(true);
  });

  it("unlink_issues duplicate-of funciona desde ambos extremos", async () => {
    const source = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { team: "PB", title: "MCP duplicate source" },
      }),
    );
    const target = parseResult(
      await client.callTool({
        name: "save_issue",
        arguments: { team: "PB", title: "MCP duplicate target" },
      }),
    );
    await client.callTool({
      name: "link_issues",
      arguments: {
        issue: source.identifier,
        relatedIssue: target.identifier,
        type: "duplicate_of",
      },
    });
    const inverse = parseResult(
      await client.callTool({
        name: "unlink_issues",
        arguments: {
          issue: target.identifier,
          relatedIssue: source.identifier,
          type: "duplicate_of",
        },
      }),
    );
    expect(inverse).toEqual({ deleted: 1 });

    await client.callTool({
      name: "link_issues",
      arguments: {
        issue: source.identifier,
        relatedIssue: target.identifier,
        type: "duplicate_of",
      },
    });
    const canonical = parseResult(
      await client.callTool({
        name: "unlink_issues",
        arguments: {
          issue: source.identifier,
          relatedIssue: target.identifier,
          type: "duplicate_of",
        },
      }),
    );
    expect(canonical).toEqual({ deleted: 1 });
  });

  it("unlink_issues borra la relación", async () => {
    const deleted = parseResult(
      await client.callTool({
        name: "unlink_issues",
        arguments: { issue: "PB-1", relatedIssue: "PB-2" },
      }),
    );
    expect(deleted).toEqual({ deleted: 1 });
    const issue = parseResult(
      await client.callTool({ name: "get_issue", arguments: { id: "PB-1" } }),
    );
    expect(issue.relations).toEqual([]);

    const missing = await client.callTool({
      name: "unlink_issues",
      arguments: { issue: "PB-1", relatedIssue: "PB-2" },
    });
    expect(missing.isError).toBe(true);
  });
});
