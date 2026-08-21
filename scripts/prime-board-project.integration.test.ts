import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The child may still be booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function streamText(stream: ReturnType<typeof Bun.spawn>["stdout"]): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  return await new Response(stream).text();
}

async function runLauncher(
  project: string,
  home: string,
  port: number,
): Promise<ReturnType<typeof Bun.spawn>> {
  const env = { ...process.env };
  delete env.PRIME_BOARD_REPO;
  delete env.PRIME_BOARD_DB;
  delete env.PRIME_BOARD_PORT;
  env.HOME = home;
  env.PRIME_BOARD_AUTH_MODE = "local";
  return Bun.spawn(
    [
      process.execPath,
      "scripts/prime-board-project.ts",
      "--project",
      project,
      "--port",
      String(port),
    ],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
}

describe("project launcher lifecycle", () => {
  test("reuses one process and releases its lock on termination", async () => {
    const root = mkdtempSync(join(tmpdir(), "prime-board-launcher-"));
    const home = join(root, "home");
    const project = join(root, "project");
    const port = 34931;
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", project]);

    const launcher = await runLauncher(project, home, port);
    try {
      await waitForHealth(port);

      const second = await runLauncher(project, home, port);
      const secondOutput = `${await streamText(second.stdout)}${await streamText(second.stderr)}`;
      expect(await second.exited).toBe(0);
      expect(secondOutput).toContain("already running");

      const status = Bun.spawn(
        [process.execPath, "scripts/prime-board-project.ts", "--project", project, "--status"],
        { cwd: repoRoot, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      expect(await status.exited).toBe(0);
      expect(await streamText(status.stdout)).toContain("running");
    } finally {
      launcher.kill("SIGTERM");
      await launcher.exited;
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

test("ignora la configuración heredada de otro proyecto", async () => {
  const root = mkdtempSync(join(tmpdir(), "prime-board-env-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const other = join(root, "other");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(other, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", project]);
  Bun.spawnSync(["git", "init", "-q", other]);

  const env = {
    ...process.env,
    HOME: home,
    PRIME_BOARD_REPO: other,
    PRIME_BOARD_DB: join(root, "other.db"),
    PRIME_BOARD_PORT: "3333",
  };
  const childProcess = Bun.spawn(
    [process.execPath, "scripts/prime-board-project.ts", "--project", project, "--print-env"],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  try {
    expect(await childProcess.exited).toBe(0);
    const output = await streamText(childProcess.stdout);
    expect(output).toContain(`PRIME_BOARD_REPO='${realpathSync(project)}`);
    expect(output).toContain(`${home}/.prime-board/projects/`);
    expect(output).not.toContain("other.db");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
