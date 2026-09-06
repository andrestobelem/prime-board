import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

interface LauncherIdentity {
  workspaceName: string;
  workspaceUrlKey: string;
  teamName: string;
  teamKey: string;
}

interface LauncherOptions {
  port?: number;
  db?: string;
  captureOutput?: boolean;
  identity?: LauncherIdentity;
  identityEnv?: LauncherIdentity;
}

async function runLauncher(
  project: string,
  home: string,
  { port, db, captureOutput = false, identity, identityEnv }: LauncherOptions = {},
): Promise<ReturnType<typeof Bun.spawn>> {
  const env = { ...process.env };
  delete env.PRIME_BOARD_REPO;
  delete env.PRIME_BOARD_DB;
  delete env.PRIME_BOARD_PORT;
  delete env.PRIME_BOARD_WORKSPACE_NAME;
  delete env.PRIME_BOARD_WORKSPACE_URL_KEY;
  delete env.PRIME_BOARD_TEAM_NAME;
  delete env.PRIME_BOARD_TEAM_KEY;
  env.HOME = home;
  env.PRIME_BOARD_AUTH_MODE = "local";
  const args = [process.execPath, "scripts/prime-board-project.ts", "--project", project];
  if (port !== undefined) args.push("--port", String(port));
  if (db !== undefined) args.push("--db", db);
  if (identityEnv) {
    env.PRIME_BOARD_WORKSPACE_NAME = identityEnv.workspaceName;
    env.PRIME_BOARD_WORKSPACE_URL_KEY = identityEnv.workspaceUrlKey;
    env.PRIME_BOARD_TEAM_NAME = identityEnv.teamName;
    env.PRIME_BOARD_TEAM_KEY = identityEnv.teamKey;
  }
  if (identity) {
    args.push("--workspace-name", identity.workspaceName);
    args.push("--workspace-url-key", identity.workspaceUrlKey);
    args.push("--team-name", identity.teamName);
    args.push("--team-key", identity.teamKey);
  }
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

async function waitForChildProcess(parentPid: number | undefined): Promise<number> {
  if (parentPid === undefined) throw new Error("Launcher did not expose a PID");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    const child = ps.stdout
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .find(([pid, ppid]) => ppid === parentPid && Number.isInteger(pid));
    if (child?.[0] !== undefined) return child[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for server child of ${parentPid}`);
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

  test("aborts a blocked handoff before reserving a port or spawning a child", async () => {
    const root = mkdtempSync(join(tmpdir(), "prime-board-blocked-handoff-"));
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", project]);
    const projectRoot = realpathSync(project);
    const databasePath = join(home, ".prime-board", "projects", "blocked.db");
    const healthServer = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          status: "ok",
          pid: process.pid,
          projectRoot,
          databasePath,
          instanceId: "blocked-owner",
          leaseToken: "blocked-instance-token",
        }),
    });
    const identity = deriveProjectIdentity(projectRoot, home, databasePath);
    mkdirSync(identity.lockPath, { recursive: true });
    writeFileSync(
      identity.metadataPath,
      `${JSON.stringify({
        version: 1,
        projectRoot,
        databasePath,
        port: healthServer.port,
        pid: 999999,
        launcherPid: 999998,
        instanceId: "blocked-owner",
        leaseToken: "blocked-instance-token",
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const launcher = Bun.spawn(
      [
        process.execPath,
        "scripts/prime-board-project.ts",
        "--project",
        project,
        "--db",
        databasePath,
        "--port",
        String(healthServer.port),
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, PRIME_BOARD_AUTH_MODE: "local" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const output = `${await streamText(launcher.stdout)}${await streamText(launcher.stderr)}`;
      expect(await launcher.exited).not.toBe(0);
      expect(output).toContain("ownership handoff is incomplete");
      expect(existsSync(databasePath)).toBe(false);
      expect(existsSync(join(home, ".prime-board", "ports"))).toBe(false);
    } finally {
      healthServer.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("conserva la instancia tras SIGKILL del launcher y rechaza duplicados", async () => {
    const root = mkdtempSync(join(tmpdir(), "prime-board-orphan-launcher-"));
    const home = join(root, "home");
    const project = join(root, "project");
    const port = 34935;
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", project]);

    const launcher = await runLauncher(project, home, { port });
    let serverPid: number | undefined;
    try {
      await waitForHealth(port);
      serverPid = await waitForChildProcess(launcher.pid);
      launcher.kill("SIGKILL");
      await launcher.exited;
      await waitForHealth(port);

      const identity = deriveProjectIdentity(realpathSync(project), home);
      const status = Bun.spawn(
        [process.execPath, "scripts/prime-board-project.ts", "--project", project, "--status"],
        { cwd: repoRoot, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      expect(await status.exited).toBe(0);
      const statusOutput = await streamText(status.stdout);
      expect(statusOutput).toContain("running");
      expect(statusOutput).toContain(`port=${port}`);
      expect(statusOutput).toContain(`pid=${serverPid}`);

      const explicit = await runLauncher(project, home, { port, captureOutput: true });
      const explicitOutput = `${await streamText(explicit.stdout)}${await streamText(explicit.stderr)}`;
      expect(await explicit.exited).toBe(0);
      expect(explicitOutput).toContain("already running");

      const implicit = await runLauncher(project, home, { captureOutput: true });
      const implicitOutput = `${await streamText(implicit.stdout)}${await streamText(implicit.stderr)}`;
      expect(await implicit.exited).toBe(0);
      expect(implicitOutput).toContain("already running");

      const after = classifyInstance(identity);
      expect(after.state).toBe("running");
      expect(after.record?.port).toBe(port);
      expect(after.record?.pid).toBe(serverPid);
    } finally {
      if (serverPid !== undefined) {
        try {
          process.kill(serverPid, "SIGTERM");
        } catch {
          // El server ya terminó durante la aserción.
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

async function readIdentity(port: number): Promise<{
  workspace: { name: string; urlKey: string };
  teams: Array<{ name: string; key: string }>;
}> {
  const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ workspace { name urlKey } teams { name key } }" }),
  });
  const payload = (await response.json()) as { data: any; errors?: unknown[] };
  if (payload.errors?.length) throw new Error(JSON.stringify(payload.errors));
  return payload.data;
}

test("rejects a linked worktree when shared core.bare is true", async () => {
  const root = mkdtempSync(join(tmpdir(), "prime-board-bare-guard-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const linked = join(root, "linked");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "-b", "main", project]);
  Bun.spawnSync(["git", "-C", project, "config", "user.email", "launcher@example.test"]);
  Bun.spawnSync(["git", "-C", project, "config", "user.name", "Launcher Test"]);
  writeFileSync(join(project, "README.md"), "fixture\n");
  Bun.spawnSync(["git", "-C", project, "add", "README.md"]);
  const commit = Bun.spawnSync(["git", "-C", project, "commit", "-qm", "fixture"]);
  expect(commit.exitCode).toBe(0);
  const added = Bun.spawnSync(["git", "-C", project, "worktree", "add", "-qb", "linked", linked]);
  expect(added.exitCode).toBe(0);
  const configured = Bun.spawnSync(["git", "-C", linked, "config", "--local", "core.bare", "true"]);
  expect(configured.exitCode).toBe(0);
  const launcher = await runLauncher(linked, home, { port: 34935, captureOutput: true });
  try {
    const output = `${await streamText(launcher.stdout)}${await streamText(launcher.stderr)}`;
    expect(await launcher.exited).not.toBe(0);
    expect(output).toContain("core.bare=true");
    expect(
      Bun.spawnSync(["git", "-C", project, "config", "--local", "--bool", "--get", "core.bare"])
        .stdout.toString()
        .trim(),
    ).toBe("true");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("configura la identidad inicial con flags y variables de entorno", async () => {
  const root = mkdtempSync(join(tmpdir(), "prime-board-identity-launcher-"));
  const home = join(root, "home");
  const flagsProject = join(root, "flags-project");
  const envProject = join(root, "env-project");
  mkdirSync(home, { recursive: true });
  mkdirSync(flagsProject, { recursive: true });
  mkdirSync(envProject, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", flagsProject]);
  Bun.spawnSync(["git", "init", "-q", envProject]);
  const flagsIdentity = {
    workspaceName: "Flags Workspace",
    workspaceUrlKey: "flags-workspace",
    teamName: "Flags Team",
    teamKey: "FLG",
  } satisfies LauncherIdentity;
  const envIdentity = {
    workspaceName: "Environment Workspace",
    workspaceUrlKey: "environment-workspace",
    teamName: "Environment Team",
    teamKey: "ENV",
  } satisfies LauncherIdentity;
  const flagsLauncher = await runLauncher(flagsProject, home, {
    port: 34933,
    identity: flagsIdentity,
    identityEnv: envIdentity,
  });
  const envLauncher = await runLauncher(envProject, home, {
    port: 34934,
    identityEnv: envIdentity,
  });
  try {
    await Promise.all([waitForHealth(34933), waitForHealth(34934)]);
    expect(await readIdentity(34933)).toEqual({
      workspace: { name: "Flags Workspace", urlKey: "flags-workspace" },
      teams: [{ name: "Flags Team", key: "FLG" }],
    });
    expect(await readIdentity(34934)).toEqual({
      workspace: { name: "Environment Workspace", urlKey: "environment-workspace" },
      teams: [{ name: "Environment Team", key: "ENV" }],
    });
  } finally {
    flagsLauncher.kill("SIGTERM");
    envLauncher.kill("SIGTERM");
    await Promise.all([flagsLauncher.exited, envLauncher.exited]);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

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
