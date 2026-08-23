import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
