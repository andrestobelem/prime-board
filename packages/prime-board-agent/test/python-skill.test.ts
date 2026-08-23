import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMcpHttpHandler } from "../../../apps/mcp/src/http.ts";
import { McpApiError } from "../../../apps/mcp/src/api.ts";

const SKILL_ROOT = join(import.meta.dir, "..", "skills", "prime-board-workflow");
const PYTHON = "/Users/andrestobelem/.prime/agent/kernel-venv/bin/python";

describe("prime-board Python skill", () => {
  it("imports in the managed Prime Agent kernel and reports missing auth without a secret", () => {
    const home = join(tmpdir(), `prime-board-skill-${crypto.randomUUID()}`);
    mkdirSync(home, { recursive: true });
    try {
      const result = spawnSync(
        PYTHON,
        [
          "-c",
          [
            "import asyncio, json, prime_board_workflow",
            "result = asyncio.run(prime_board_workflow.run('list_tools'))",
            "print(json.dumps(result))",
          ].join("; "),
        ],
        {
          cwd: SKILL_ROOT,
          env: {
            ...process.env,
            HOME: home,
            PYTHONPATH: join(SKILL_ROOT, "src"),
            PRIME_BOARD_API_KEY: "",
            PRIME_BOARD_MCP_URL: "",
          },
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"state": "unauthenticated"');
      expect(result.stdout).not.toContain("pb_");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("calls an authenticated MCP tool through the installed Python client", async () => {
    const home = join(tmpdir(), `prime-board-mcp-smoke-${crypto.randomUUID()}`);
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    expect(spawnSync("git", ["-C", project, "init", "-q"]).status).toBe(0);
    const credentials = join(home, ".prime-board", "credentials");
    mkdirSync(credentials, { recursive: true });
    const cryptoHash = spawnSync(
      "python3",
      [
        "-c",
        "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])",
        realpathSync(project),
      ],
      { encoding: "utf8" },
    ).stdout.trim();
    writeFileSync(
      join(credentials, `${cryptoHash}.json`),
      JSON.stringify({ apiKey: "pb_smoke", mcpUrl: "http://127.0.0.1:0/mcp" }),
    );
    const credential = join(credentials, `${cryptoHash}.json`);
    chmodSync(credential, 0o600);
    const handler = createMcpHttpHandler(
      { url: "http://board.invalid" },
      {
        createSession: async ({ apiKey }) => {
          if (apiKey !== "pb_smoke") throw new McpApiError("UNAUTHORIZED", "invalid key");
          return {
            url: "http://board.invalid",
            apiKey,
            context: {
              workspaceId: "workspace-1",
              workspaceName: "Board",
              workspaceUrlKey: "board",
              actorId: "agent-1",
              actorName: "agent",
              actorType: "AGENT",
            },
          };
        },
      },
    );
    const server = Bun.serve({ port: 0, fetch: handler.fetch });
    try {
      const endpoint = `${server.url}mcp`;
      writeFileSync(credential, JSON.stringify({ apiKey: "pb_smoke", mcpUrl: endpoint }));
      chmodSync(credential, 0o600);
      const child = Bun.spawn(
        [
          PYTHON,
          "-c",
          [
            "import asyncio, json, prime_board_workflow",
            "result = asyncio.run(prime_board_workflow.run('list_tools', cwd=None))",
            "print(json.dumps(result))",
          ].join("; "),
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            HOME: home,
            PYTHONPATH: join(SKILL_ROOT, "src"),
            PRIME_BOARD_API_KEY: "",
            PRIME_BOARD_MCP_URL: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(status).toBe(0);
      expect(`${stdout}\n${stderr}`).toContain('"state": "healthy"');
      expect(stdout).toContain("list_issues");
      expect(stdout).not.toContain("pb_smoke");
    } finally {
      server.stop(true);
      await handler.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses a project-scoped MCP endpoint and enforces 0600 credentials", () => {
    const home = join(tmpdir(), `prime-board-skill-${crypto.randomUUID()}`);
    const project = join(home, "project");
    const credentials = join(home, ".prime-board", "credentials");
    mkdirSync(credentials, { recursive: true });
    try {
      const cryptoHash = spawnSync(
        "python3",
        [
          "-c",
          "import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])",
          project,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
      const path = join(credentials, `${cryptoHash}.json`);
      writeFileSync(
        path,
        JSON.stringify({ apiKey: "pb_project", mcpUrl: "http://127.0.0.1:3501/mcp" }),
      );
      chmodSync(path, 0o600);
      const result = spawnSync(
        PYTHON,
        [
          "-c",
          "import sys; sys.path.insert(0, sys.argv[1]); import prime_board_workflow; print(prime_board_workflow._endpoint(__import__('pathlib').Path(sys.argv[2]), None))",
          join(SKILL_ROOT, "src"),
          project,
        ],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("http://127.0.0.1:3501/mcp");
      const precedence = spawnSync(
        PYTHON,
        [
          "-c",
          "import sys; sys.path.insert(0, sys.argv[1]); import prime_board_workflow; print(prime_board_workflow._credential(__import__('pathlib').Path(sys.argv[2]), None))",
          join(SKILL_ROOT, "src"),
          project,
        ],
        {
          env: { ...process.env, HOME: home, PRIME_BOARD_API_KEY: "pb_environment" },
          encoding: "utf8",
        },
      );
      expect(precedence.status).toBe(0);
      expect(precedence.stdout).toContain("pb_environment");
      expect(precedence.stdout).not.toContain("pb_project");
      const redacted = spawnSync(
        PYTHON,
        [
          "-c",
          "import sys; sys.path.insert(0, sys.argv[1]); import prime_board_workflow; print(prime_board_workflow._safe_error(Exception('API_KEY=pb_environment Authorization: Bearer bearer_secret'), 'pb_environment'))",
          join(SKILL_ROOT, "src"),
        ],
        {
          env: { ...process.env, HOME: home, PRIME_BOARD_API_KEY: "pb_environment" },
          encoding: "utf8",
        },
      );
      expect(redacted.status).toBe(0);
      expect(redacted.stdout).not.toContain("pb_environment");
      expect(redacted.stdout).not.toContain("bearer_secret");
      chmodSync(path, 0o644);
      const rejected = spawnSync(
        PYTHON,
        [
          "-c",
          "import sys; sys.path.insert(0, sys.argv[1]); import prime_board_workflow; prime_board_workflow._credential(__import__('pathlib').Path(sys.argv[2]), None)",
          join(SKILL_ROOT, "src"),
          project,
        ],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("0600");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
