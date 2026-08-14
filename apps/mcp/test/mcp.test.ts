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
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: [join(ROOT, "apps/mcp/src/index.ts")],
    env: {
      ...process.env as Record<string, string>,
      PRIME_BOARD_URL: `http://localhost:${PORT}`,
      PRIME_BOARD_API_KEY: apiKey,
    },
  }));
});

afterAll(async () => {
  await client.close();
  server.kill();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("mcp tools", () => {
  it("expone las 14 tools espejo de Linear", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "get_issue", "get_project", "get_team", "get_workspace",
      "list_comments", "list_issue_labels", "list_issue_statuses", "list_issues",
      "list_projects", "list_teams", "list_users",
      "save_comment", "save_issue", "save_project",
    ]);
  });

  it("get_workspace y list_teams responden", async () => {
    const workspace = parseResult(await client.callTool({ name: "get_workspace", arguments: {} }));
    expect(workspace.workspace.name).toBe("Prime Board");
    const teams = parseResult(await client.callTool({ name: "list_teams", arguments: {} }));
    expect(teams[0].key).toBe("PB");
  });

  it("save_issue crea y actualiza con referencias amigables", async () => {
    const created = parseResult(await client.callTool({
      name: "save_issue",
      arguments: { team: "PB", title: "From MCP", priority: "urgent", assignee: "me" },
    }));
    expect(created.identifier).toBe("PB-1");
    expect(created.priority).toBe(1);
    expect(created.assignee.name).toBe("admin");

    const updated = parseResult(await client.callTool({
      name: "save_issue",
      arguments: { id: "PB-1", state: "started" },
    }));
    expect(updated.state.type).toBe("STARTED");
  });

  it("save_comment y get_issue con historial", async () => {
    await client.callTool({
      name: "save_comment",
      arguments: { issue: "PB-1", body: "hello from MCP" },
    });
    const issue = parseResult(await client.callTool({ name: "get_issue", arguments: { id: "PB-1" } }));
    expect(issue.comments[0].body).toBe("hello from MCP");
    expect(issue.activity.map((a: any) => a.type)).toEqual([
      "created", "state_changed", "commented",
    ]);
  });

  it("list_issues filtra por estado semántico y búsqueda", async () => {
    const found = parseResult(await client.callTool({
      name: "list_issues",
      arguments: { team: "PB", state: "started", query: "mcp" },
    }));
    expect(found.nodes.map((n: any) => n.identifier)).toEqual(["PB-1"]);
  });

  it("save_project y get_project", async () => {
    const project = parseResult(await client.callTool({
      name: "save_project",
      arguments: { name: "MCP project", state: "started", lead: "me" },
    }));
    expect(project.lead.name).toBe("admin");
    await client.callTool({ name: "save_issue", arguments: { id: "PB-1", project: project.id } });
    const fetched = parseResult(await client.callTool({ name: "get_project", arguments: { id: project.id } }));
    expect(fetched.issues.nodes.map((n: any) => n.identifier)).toEqual(["PB-1"]);
  });

  it("los errores de la API viajan como errores MCP", async () => {
    const result = await client.callTool({ name: "get_issue", arguments: { id: "PB-99" } });
    expect(result.isError).toBe(true);
  });
});
