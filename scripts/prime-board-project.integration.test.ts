import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyInstance, deriveProjectIdentity } from "./prime-board-project-lib.ts";

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

interface LauncherOptions {
  port?: number;
  db?: string;
  captureOutput?: boolean;
}

async function runLauncher(
  project: string,
  home: string,
  { port, db, captureOutput = false }: LauncherOptions = {},
): Promise<ReturnType<typeof Bun.spawn>> {
  const env = { ...process.env };
  delete env.PRIME_BOARD_REPO;
  delete env.PRIME_BOARD_DB;
  delete env.PRIME_BOARD_PORT;
  env.HOME = home;
  env.PRIME_BOARD_AUTH_MODE = "local";
  const args = [process.execPath, "scripts/prime-board-project.ts", "--project", project];
  if (port !== undefined) args.push("--port", String(port));
  if (db !== undefined) args.push("--db", db);
  const output: "pipe" | "ignore" = captureOutput ? "pipe" : "ignore";
  return Bun.spawn(args, { cwd: repoRoot, env, stdout: output, stderr: output });
}

async function waitForInstance(
  project: string,
  home: string,
): Promise<NonNullable<ReturnType<typeof classifyInstance>["record"]>> {
  const identity = deriveProjectIdentity(realpathSync(project), home);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = classifyInstance(identity);
    if (status.state === "running" && status.record) return status.record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for launcher instance: ${project}`);
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

    const launcher = await runLauncher(project, home, { port });
    try {
      await waitForHealth(port);

      const second = await runLauncher(project, home, { port, captureOutput: true });
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

test("reserva puertos implícitos distintos para proyectos concurrentes", async () => {
  const root = mkdtempSync(join(tmpdir(), "prime-board-concurrent-launcher-"));
  const home = join(root, "home");
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  mkdirSync(home, { recursive: true });
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", alpha]);
  Bun.spawnSync(["git", "init", "-q", beta]);

  const launchers = [await runLauncher(alpha, home), await runLauncher(beta, home)];
  try {
    const records = await Promise.all([waitForInstance(alpha, home), waitForInstance(beta, home)]);
    expect(records[0].port).not.toBe(records[1].port);
    expect(records[0].databasePath).not.toBe(records[1].databasePath);
    await Promise.all(records.map((record) => waitForHealth(record.port)));
  } finally {
    for (const launcher of launchers) {
      launcher.kill("SIGTERM");
    }
    await Promise.all(launchers.map((launcher) => launcher.exited));
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("libera la reserva y el lock si el servidor no puede arrancar", async () => {
  const root = mkdtempSync(join(tmpdir(), "prime-board-failed-launcher-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const port = 34932;
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", project]);

  const failed = await runLauncher(project, home, { port, db: "/dev/null/prime-board.db" });
  try {
    expect(await failed.exited).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const retryRoot = mkdtempSync(join(tmpdir(), "prime-board-retry-launcher-"));
  const retryHome = join(retryRoot, "home");
  const retryProject = join(retryRoot, "project");
  mkdirSync(retryHome, { recursive: true });
  mkdirSync(retryProject, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", retryProject]);
  const retry = await runLauncher(retryProject, retryHome, { port });
  try {
    await waitForHealth(port);
  } finally {
    retry.kill("SIGTERM");
    await retry.exited;
    rmSync(retryRoot, { recursive: true, force: true });
  }
}, 20_000);

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
