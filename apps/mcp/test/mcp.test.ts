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
      "archive_project",
      "delete_milestone",
      "delete_project_update",
      "delete_saved_view",
      "get_issue",
      "get_project",
      "get_team",
      "get_workspace",
      "link_issues",
      "list_comments",
      "list_issue_labels",
      "list_issue_statuses",
      "list_issues",
      "list_milestones",
      "list_project_updates",
      "list_projects",
      "list_saved_views",
      "list_teams",
      "list_users",
      "save_comment",
      "save_issue",
      "save_milestone",
      "save_project",
      "save_project_update",
      "save_saved_view",
      "unarchive_project",
      "unlink_issues",
    ]);
  });

  it("get_workspace y list_teams responden", async () => {
    const workspace = parseResult(await client.callTool({ name: "get_workspace", arguments: {} }));
    expect(workspace.workspace.name).toBe("Prime Board");
    const teams = parseResult(await client.callTool({ name: "list_teams", arguments: {} }));
    expect(teams[0].key).toBe("PB");
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
