// Tests e2e de AT-140: el CLI contra un server real (subprocess con DB temporal).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PORT = 3394;
let tempDir: string;
let server: Bun.Subprocess;
let apiKey = "";

function pb(args: string[], stdin?: string) {
  const proc = Bun.spawnSync(["bun", join(ROOT, "apps/cli/src/index.ts"), ...args], {
    env: {
      ...process.env,
      PRIME_BOARD_URL: `http://localhost:${PORT}`,
      PRIME_BOARD_API_KEY: apiKey,
    },
    stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "pb-cli-test-"));
  server = Bun.spawn(["bun", join(ROOT, "apps/server/src/index.ts")], {
    env: {
      ...process.env,
      PRIME_BOARD_DB: join(tempDir, "test.db"),
      PRIME_BOARD_PORT: String(PORT),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Espera el arranque y captura la key impresa una única vez.
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("listening")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
  }
  reader.releaseLock();
  const match = buffer.match(/Admin API key.*: (pb_\S+)/);
  if (!match) throw new Error(`No API key in server output: ${buffer}`);
  apiKey = match[1]!;
});

afterAll(() => {
  server.kill();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("pb auth", () => {
  it("status muestra el viewer autenticado", () => {
    const result = pb(["auth", "status"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.viewer.name).toBe("admin");
    expect(parsed.workspace.name).toBe("Prime Board");
  });
});

describe("pb issue", () => {
  it("crea un issue con prioridad y lo muestra", () => {
    const created = pb([
      "issue", "create", "--team", "PB", "--title", "CLI issue",
      "--description", "made from cli", "--priority", "high", "--assignee", "me", "--json",
    ]);
    expect(created.code).toBe(0);
    const issue = JSON.parse(created.out);
    expect(issue.identifier).toBe("PB-1");
    expect(issue.priority).toBe(2);
    expect(issue.assignee.name).toBe("admin");

    const view = pb(["issue", "view", "PB-1"]);
    expect(view.code).toBe(0);
    expect(view.out).toContain("CLI issue");
    expect(view.out).toContain("made from cli");
  });

  it("actualiza estado por nombre y lista con filtros", () => {
    const updated = pb(["issue", "update", "PB-1", "--state", "In Progress", "--json"]);
    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.out).state.name).toBe("In Progress");

    const listed = pb(["issue", "list", "--team", "PB", "--state", "started", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).nodes.map((n: any) => n.identifier)).toEqual(["PB-1"]);
  });

  it("comenta leyendo el body de stdin", () => {
    const commented = pb(["issue", "comment", "PB-1", "--body", "-"], "stdin comment body");
    expect(commented.code).toBe(0);
    const view = pb(["issue", "view", "PB-1", "--json"]);
    expect(JSON.parse(view.out).comments[0].body).toBe("stdin comment body");
  });

  it("busca full-text desde el CLI", () => {
    pb(["issue", "create", "--team", "PB", "--title", "Unrelated thing"]);
    const found = pb(["issue", "list", "--search", "cli", "--json"]);
    expect(JSON.parse(found.out).nodes.length).toBe(1);
  });

  it("devuelve exit code 1 en errores de API y 2 en errores de uso", () => {
    const apiError = pb(["issue", "view", "PB-99"]);
    expect(apiError.code).toBe(2); // NOT_FOUND del CLI es UsageError con mensaje claro
    const usage = pb(["issue", "unknown-action"]);
    expect(usage.code).toBe(2);
    const badPriority = pb(["issue", "create", "--team", "PB", "--title", "x", "--priority", "mega"]);
    expect(badPriority.code).toBe(2);
    // Con una key inválida el server responde UNAUTHORIZED → exit 1.
    const invalid = Bun.spawnSync(["bun", join(ROOT, "apps/cli/src/index.ts"), "auth", "status"], {
      env: { ...process.env, PRIME_BOARD_URL: `http://localhost:${PORT}`, PRIME_BOARD_API_KEY: "pb_bad" },
    });
    expect(invalid.exitCode).toBe(1);
  });
});
