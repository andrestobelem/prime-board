import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type RuntimeState = "running" | "stopped" | "starting" | "unavailable" | "error";

export interface RuntimeStatus {
  projectRoot: string;
  url: string | null;
  state: RuntimeState;
  detail: string;
  pid?: number;
  port?: number;
  logPath: string;
  credentialPath: string;
}

export interface ProjectCredential {
  url?: string;
  apiKey: string;
  mcpUrl?: string;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RuntimeDependencies {
  runStatus?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => CommandResult;
  launch?: (
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    logPath: string,
  ) => ChildProcessLike;
  fetch?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  platform?: NodeJS.Platform;
  openUrl?: (command: string, args: string[]) => void;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface ChildProcessLike {
  pid?: number;
  unref?: () => void;
  once?: (event: string, listener: (...args: unknown[]) => void) => void;
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): void } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): void } | null;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 100;
const STATUS_SCRIPT = "scripts/prime-board-project.ts";

function projectHash(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

export function projectCredentialPath(projectRoot: string, home = homedir()): string {
  return join(home, ".prime-board", "credentials", `${projectHash(projectRoot)}.json`);
}

export function projectLogPath(projectRoot: string, home = homedir()): string {
  return join(home, ".prime-board", "logs", `${projectHash(projectRoot)}.log`);
}

export function saveProjectCredential(
  projectRoot: string,
  credential: ProjectCredential,
  home = homedir(),
): string {
  if (!credential.apiKey.trim()) throw new Error("API key cannot be empty");
  const path = projectCredentialPath(projectRoot, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credential)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function isProjectCredential(value: unknown): value is ProjectCredential {
  if (typeof value !== "object" || value === null || !("apiKey" in value)) return false;
  const apiKey = value.apiKey;
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function readProjectCredential(
  projectRoot: string,
  home = homedir(),
): ProjectCredential | null {
  const path = projectCredentialPath(projectRoot, home);
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isProjectCredential(value)) return null;
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) throw new Error(`Credential file must have mode 0600: ${path}`);
    return value;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(
      /(\b(?:prime[_ -]?board[_ -]?api[_ -]?key|api[_ -]?key|access[_ -]?token|secret)\b\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted-api-key]",
    )
    .replace(/(\bauthorization\b\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[redacted-bearer]")
    .replace(/(\bbearer\s+)[^\s,;]+/gi, "$1[redacted-bearer]")
    .replace(/\bpb_[A-Za-z0-9_-]+\b/g, "[redacted-api-key]");
}

function appendLog(path: string, chunk: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    writeFileSync(fd, redactSecrets(String(chunk)));
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function defaultRunStatus(args: string[], cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  try {
    const result = spawnSync(env.PRIME_BOARD_BUN ?? "bun", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5_000,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function defaultLaunch(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
): ChildProcessLike {
  const child = spawn(env.PRIME_BOARD_BUN ?? "bun", args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => appendLog(logPath, chunk));
  child.stderr?.on("data", (chunk) => appendLog(logPath, chunk));
  child.once?.("error", () => undefined);
  child.unref();
  return child;
}

function parseStatusOutput(
  projectRoot: string,
  output: string,
  logPath: string,
  credentialPath: string,
): RuntimeStatus {
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => /^(running|not-running|stale)\s/.test(value));
  if (!line) {
    return {
      projectRoot,
      url: null,
      state: "error",
      detail: output.trim() || "The runtime status command returned no state",
      logPath,
      credentialPath,
    };
  }
  const state = line.match(/^(running|not-running|stale)/)?.[1];
  const port = Number(line.match(/\bport=(\d+)/)?.[1]);
  const pid = Number(line.match(/\bpid=(\d+)/)?.[1]);
  const database = line.match(/\bdb=(\S+)/)?.[1];
  if (state === "running" && Number.isInteger(port)) {
    return {
      projectRoot,
      url: `http://127.0.0.1:${port}`,
      state: "running",
      detail: "Runtime is running",
      ...(Number.isInteger(pid) ? { pid } : {}),
      port,
      logPath,
      credentialPath,
    };
  }
  if (state === "stale") {
    return {
      projectRoot,
      url: null,
      state: "error",
      detail: "The runtime lock is stale; retrying will repair it",
      logPath,
      credentialPath,
    };
  }
  return {
    projectRoot,
    url: null,
    state: "stopped",
    detail: database ? `Runtime is stopped (database: ${database})` : "Runtime is stopped",
    logPath,
    credentialPath,
  };
}

function runtimeRootFor(projectRoot: string, env: NodeJS.ProcessEnv): string | null {
  const configured = env.PRIME_BOARD_ROOT?.trim();
  if (configured) return resolve(configured);
  if (existsSync(join(projectRoot, STATUS_SCRIPT))) return projectRoot;
  return null;
}

function runtimeArgs(projectRoot: string, action: "status" | "start"): string[] {
  return [STATUS_SCRIPT, "--project", projectRoot, ...(action === "status" ? ["--status"] : [])];
}

async function health(url: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const response = await fetchImpl(`${url}/health`, {
      signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sleepDefault(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createRuntimeController(
  dependencies: RuntimeDependencies = {},
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  const runStatus = dependencies.runStatus ?? defaultRunStatus;
  const launch = dependencies.launch ?? defaultLaunch;
  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? sleepDefault;
  const kill = dependencies.kill ?? ((pid, signal) => process.kill(pid, signal));
  const now = dependencies.now ?? Date.now;
  const pending = new Map<string, Promise<RuntimeStatus>>();
  const processes = new Map<string, ChildProcessLike>();

  function paths(projectRoot: string) {
    return {
      logPath: projectLogPath(projectRoot, home),
      credentialPath: projectCredentialPath(projectRoot, home),
    };
  }

  function unavailable(projectRoot: string, detail: string): RuntimeStatus {
    const { logPath, credentialPath } = paths(projectRoot);
    return { projectRoot, url: null, state: "unavailable", detail, logPath, credentialPath };
  }

  function rootOrUnavailable(projectRoot: string): string | RuntimeStatus {
    const root = runtimeRootFor(projectRoot, env);
    if (!root) {
      return unavailable(
        projectRoot,
        "Runtime source is unavailable. Set PRIME_BOARD_ROOT to a prime-board checkout with scripts/prime-board-project.ts.",
      );
    }
    if (!existsSync(join(root, STATUS_SCRIPT))) {
      return unavailable(projectRoot, `Runtime launcher not found: ${join(root, STATUS_SCRIPT)}`);
    }
    return root;
  }

  function status(projectRoot: string): RuntimeStatus {
    const root = rootOrUnavailable(projectRoot);
    if (typeof root !== "string") return root;
    const { logPath, credentialPath } = paths(projectRoot);
    const result = runStatus(runtimeArgs(projectRoot, "status"), root, env);
    if (result.error && !result.stdout && !result.stderr) {
      return unavailable(
        projectRoot,
        `Cannot run Bun runtime. Install Bun or set PRIME_BOARD_BUN: ${result.error.message}`,
      );
    }
    return parseStatusOutput(
      projectRoot,
      `${result.stdout}\n${result.stderr}`,
      logPath,
      credentialPath,
    );
  }

  async function waitForRuntime(projectRoot: string, timeoutMs: number): Promise<RuntimeStatus> {
    const startedAt = now();
    let last = status(projectRoot);
    while (now() - startedAt <= timeoutMs) {
      last = status(projectRoot);
      if (last.state === "running" && last.url && (await health(last.url, fetchImpl))) return last;
      await sleep(DEFAULT_POLL_MS);
    }
    if (last.state === "running") {
      return { ...last, state: "error", detail: `Runtime did not pass /health at ${last.url}` };
    }
    return {
      ...last,
      state: "error",
      detail: `${last.detail}. Check ${last.logPath} for redacted runtime logs.`,
    };
  }

  async function ensure(
    projectRoot: string,
    timeoutMs = DEFAULT_START_TIMEOUT_MS,
  ): Promise<RuntimeStatus> {
    const existing = pending.get(projectRoot);
    if (existing) return existing;
    const operation = (async () => {
      const current = status(projectRoot);
      if (current.state === "running" && current.url && (await health(current.url, fetchImpl))) {
        return current;
      }
      const root = rootOrUnavailable(projectRoot);
      if (typeof root !== "string") return root;
      const { logPath } = paths(projectRoot);
      const child = launch(runtimeArgs(projectRoot, "start"), root, env, logPath);
      processes.set(projectRoot, child);
      return waitForRuntime(projectRoot, timeoutMs);
    })();
    pending.set(projectRoot, operation);
    try {
      return await operation;
    } finally {
      pending.delete(projectRoot);
    }
  }

  async function stop(
    projectRoot: string,
    timeoutMs = DEFAULT_START_TIMEOUT_MS,
  ): Promise<RuntimeStatus> {
    const current = status(projectRoot);
    if (current.state !== "running" || !current.pid) return current;
    kill(current.pid, "SIGTERM");
    const startedAt = now();
    let last = current;
    while (now() - startedAt <= timeoutMs) {
      await sleep(DEFAULT_POLL_MS);
      last = status(projectRoot);
      if (last.state !== "running") {
        processes.delete(projectRoot);
        return last;
      }
    }
    return {
      ...last,
      state: "error",
      detail: `Runtime did not stop after SIGTERM (pid ${current.pid})`,
    };
  }

  function logs(projectRoot: string, lines = 80): string {
    const path = paths(projectRoot).logPath;
    try {
      const content = readFileSync(path, "utf8");
      return content.split(/\r?\n/).slice(-Math.max(1, lines)).map(redactSecrets).join("\n");
    } catch (error) {
      if (isMissingFile(error)) return "No runtime log is available.";
      throw error;
    }
  }

  function open(projectRoot: string): RuntimeStatus {
    const current = status(projectRoot);
    if (!current.url)
      return {
        ...current,
        state: "error",
        detail: "Runtime is not running; start it before opening the UI",
      };
    const platform = dependencies.platform ?? process.platform;
    const command =
      platform === "darwin" ? "open" : platform === "win32" ? "explorer.exe" : "xdg-open";
    (
      dependencies.openUrl ??
      ((name, args) => spawn(name, args, { detached: true, stdio: "ignore" }).unref())
    )(command, [current.url]);
    return { ...current, detail: `Opened ${current.url}` };
  }

  return { status, ensure, stop, logs, open, paths };
}

export function releaseRuntime(_projectRoot: string): void {
  // El launcher posee el lock del proceso. El cierre de una sesión solo libera
  // su referencia en memoria y no detiene un runtime compartido.
}
