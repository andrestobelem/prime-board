import { createServer } from "node:net";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  databaseReservationPaths,
  deriveProjectIdentity,
  stableDatabasePath,
  type InstanceRecord,
} from "./prime-board-project-lib.ts";

export type CheckStatus = "pass" | "fail" | "warn";

export interface PreflightCheck {
  id: string;
  status: CheckStatus;
  message: string;
  details?: string[];
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (repoPath: string, args: string[]) => CommandResult;
export type PortProbe = (port: number) => Promise<boolean>;
export type ProcessProbe = (pid: number) => boolean;

export interface ActiveInstance {
  metadataPath: string;
  record: InstanceRecord;
}

export interface ActivePortReservation {
  metadataPath: string;
  port: number;
  pid: number;
}

export interface PreflightOptions {
  repoPath?: string;
  expectedBranch?: string;
  unit?: string;
  port?: number;
  databasePath?: string;
  homeDirectory?: string;
  hookPath?: string;
  strict?: boolean;
  gitRunner?: GitRunner;
  portProbe?: PortProbe;
  processProbe?: ProcessProbe;
}

export interface PreflightReport {
  passed: boolean;
  repoPath: string;
  repoRoot: string | null;
  branch: string | null;
  databasePath: string | null;
  port: number | null;
  checks: PreflightCheck[];
}

const DEFAULT_PORT = 3333;
const REQUIRED_TEST_PATHS = [
  "apps/cli/test",
  "apps/server",
  "apps/web",
  "apps/mcp",
  "packages",
  "scripts/prime-board-project.integration.test.ts",
  "scripts/prime-board-project.test.ts",
  "scripts/prime-board-preflight.test.ts",
] as const;

function check(
  id: string,
  status: CheckStatus,
  message: string,
  details?: string[],
): PreflightCheck {
  return details?.length ? { id, status, message, details } : { id, status, message };
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function defaultGitRunner(repoPath: string, args: string[]): CommandResult {
  const result = Bun.spawnSync(["git", "-C", repoPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  flush();
  return entries;
}

function pathCounts(paths: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  return counts;
}

function repeatedKeys(values: string[]): string[] {
  return [...pathCounts(values).entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

function includesUnit(value: string | null, unit: string): boolean {
  if (!value || !unit) return false;
  const escaped = unit.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`, "i").test(value);
}

function sameDatabase(left: string, right: string): boolean {
  if (canonicalPath(left) === canonicalPath(right)) return true;
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function databaseArtifacts(path: string): string[] {
  return [path, `${path}-wal`, `${path}-shm`];
}

export function inspectWorktrees(
  entries: WorktreeEntry[],
  repoRoot: string,
  branch: string,
  unit?: string,
): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const canonicalEntries = entries.map((entry) => ({
    ...entry,
    path: canonicalPath(entry.path),
  }));
  const current = canonicalEntries.find((entry) => entry.path === repoRoot);

  checks.push(
    current
      ? current.bare
        ? check("worktree-current", "fail", "The current worktree entry is marked as bare.", [
            repoRoot,
          ])
        : check("worktree-current", "pass", "The current worktree is registered and is not bare.")
      : check(
          "worktree-current",
          "fail",
          "The current worktree is not listed by `git worktree list`.",
          [repoRoot],
        ),
  );

  const repeatedPaths = repeatedKeys(canonicalEntries.map((entry) => entry.path));
  checks.push(
    repeatedPaths.length
      ? check(
          "worktree-duplicate-path",
          "fail",
          "Duplicate worktree paths were found.",
          repeatedPaths,
        )
      : check("worktree-duplicate-path", "pass", "No duplicate worktree paths were found."),
  );

  const branches = canonicalEntries.flatMap((entry) => (entry.branch ? [entry.branch] : []));
  const repeatedBranches = repeatedKeys(branches);
  checks.push(
    repeatedBranches.length
      ? check(
          "worktree-duplicate-branch",
          "fail",
          "Branches are assigned to more than one worktree.",
          repeatedBranches,
        )
      : check(
          "worktree-duplicate-branch",
          "pass",
          "No duplicate branches were found between worktrees.",
        ),
  );

  const branchEntries = canonicalEntries.filter((entry) => entry.branch === branch);
  checks.push(
    branchEntries.length === 1
      ? check("worktree-branch", "pass", `The current branch is unique: ${branch}.`)
      : check(
          "worktree-branch",
          "fail",
          `The expected branch does not have exactly one worktree: ${branch}.`,
          branchEntries.map((entry) => entry.path),
        ),
  );

  if (unit) {
    const normalizedUnit = unit.trim();
    const matchingEntries = canonicalEntries.filter(
      (entry) =>
        includesUnit(entry.branch, normalizedUnit) || includesUnit(entry.path, normalizedUnit),
    );
    checks.push(
      matchingEntries.length === 1
        ? check(
            "worktree-unit",
            "pass",
            `Unit ${normalizedUnit} has one worktree.`,
            matchingEntries.map((entry) => entry.path),
          )
        : matchingEntries.length === 0
          ? check(
              "worktree-unit",
              "fail",
              `No worktree has a reliable identity for unit ${normalizedUnit}; refusing to assume it is unique.`,
              canonicalEntries.map(
                (entry) =>
                  `${entry.branch ?? "(detached)"} — ${entry.path} — HEAD ${entry.head ?? "(unknown)"}`,
              ),
            )
          : check(
              "worktree-unit",
              "fail",
              `Unit ${normalizedUnit} appears in multiple worktrees.`,
              matchingEntries.map((entry) => `${entry.branch ?? "(detached)"} — ${entry.path}`),
            ),
    );
  } else {
    checks.push(
      check(
        "worktree-unit",
        "warn",
        "--unit was not provided; unit duplication cannot be checked.",
      ),
    );
  }

  return checks;
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const server = createServer();
    const finish = (available: boolean) => {
      server.removeAllListeners();
      resolveAvailability(available);
    };
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => finish(true));
    });
  });
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isInstanceRecord(value: unknown): value is InstanceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<InstanceRecord>;
  return (
    record.version === 1 &&
    typeof record.projectRoot === "string" &&
    typeof record.databasePath === "string" &&
    Number.isInteger(record.port) &&
    Number.isInteger(record.pid) &&
    typeof record.startedAt === "string"
  );
}

export function readActiveInstances(
  homeDirectory: string,
  probe: ProcessProbe = processIsAlive,
): ActiveInstance[] {
  const projectsRoot = join(resolve(homeDirectory), ".prime-board", "projects");
  if (!existsSync(projectsRoot)) return [];
  const instances: ActiveInstance[] = [];
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lock")) continue;
    const metadataPath = join(projectsRoot, entry.name, "instance.json");
    const value = readJson(metadataPath);
    if (isInstanceRecord(value) && probe(value.pid))
      instances.push({ metadataPath, record: value });
  }
  return instances.sort((left, right) => left.metadataPath.localeCompare(right.metadataPath));
}

export function readActivePortReservations(
  homeDirectory: string,
  probe: ProcessProbe = processIsAlive,
): ActivePortReservation[] {
  const portsRoot = join(resolve(homeDirectory), ".prime-board", "ports");
  if (!existsSync(portsRoot)) return [];
  const reservations: ActivePortReservation[] = [];
  for (const entry of readdirSync(portsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lock")) continue;
    const metadataPath = join(portsRoot, entry.name, "reservation.json");
    const value = readJson(metadataPath);
    const record = (
      value && typeof value === "object" ? value : {}
    ) as Partial<ActivePortReservation> & {
      version?: number;
      port?: number;
    };
    const port = Number(entry.name.slice(0, -".lock".length));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const pid = typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : 0;
    // A malformed or incomplete lock is occupied. The launcher uses the same
    // rule during its startup race and the read-only preflight must not steal it.
    if (record.version !== 1 || record.port !== port || pid === 0 || !probe(pid)) {
      reservations.push({ metadataPath, port, pid });
      continue;
    }
    reservations.push({ metadataPath, port, pid });
  }
  return reservations.sort((left, right) => left.metadataPath.localeCompare(right.metadataPath));
}

async function findAvailablePort(
  preferredPort: number,
  explicit: boolean,
  homeDirectory: string,
  portProbe: PortProbe,
  processProbe: ProcessProbe,
): Promise<{ port: number | null; skipped: number[] }> {
  const reservations = new Set(
    readActivePortReservations(homeDirectory, processProbe).map((reservation) => reservation.port),
  );
  const skipped: number[] = [];
  for (let port = preferredPort; port <= 65535; port += 1) {
    if (reservations.has(port) || !(await portProbe(port))) {
      skipped.push(port);
      if (explicit) return { port: null, skipped };
      continue;
    }
    return { port, skipped };
  }
  return { port: null, skipped };
}

export async function inspectResources(
  repoRoot: string,
  options: Pick<
    PreflightOptions,
    "port" | "databasePath" | "homeDirectory" | "portProbe" | "processProbe"
  >,
): Promise<{
  checks: PreflightCheck[];
  databasePath: string;
  port: number | null;
}> {
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const processProbe = options.processProbe ?? processIsAlive;
  const inheritedRepo = process.env.PRIME_BOARD_REPO;
  const inheritedRepoMatches = Boolean(
    inheritedRepo && canonicalPath(inheritedRepo) === canonicalPath(repoRoot),
  );
  const hasIncompleteInheritedResources =
    !inheritedRepo && Boolean(process.env.PRIME_BOARD_DB || process.env.PRIME_BOARD_PORT);
  const configuredDatabase =
    options.databasePath ?? (inheritedRepoMatches ? process.env.PRIME_BOARD_DB : undefined);
  const databasePath =
    configuredDatabase === ":memory:"
      ? ":memory:"
      : stableDatabasePath(
          configuredDatabase ?? deriveProjectIdentity(repoRoot, homeDirectory).databasePath,
        );
  const activeInstances = readActiveInstances(homeDirectory, processProbe);
  const databaseLockPaths =
    databasePath === ":memory:" ? [] : databaseReservationPaths(databasePath, homeDirectory);
  const databaseReservationPathsPresent = databaseLockPaths.filter((path) => existsSync(path));
  const databaseUsers = activeInstances.filter((instance) =>
    databaseArtifacts(instance.record.databasePath).some((candidate) =>
      databaseArtifacts(databasePath).some((requested) => sameDatabase(candidate, requested)),
    ),
  );
  const checks: PreflightCheck[] = [];
  if (hasIncompleteInheritedResources) {
    checks.push(
      check(
        "resource-inherited-env",
        "warn",
        "PRIME_BOARD_DB and PRIME_BOARD_PORT are ignored without PRIME_BOARD_REPO.",
        ["PRIME_BOARD_DB", "PRIME_BOARD_PORT"],
      ),
    );
  } else if (inheritedRepo && !inheritedRepoMatches) {
    checks.push(
      check(
        "resource-inherited-env",
        "warn",
        "Inherited configuration belongs to another worktree; its port and database are ignored.",
        ["PRIME_BOARD_REPO"],
      ),
    );
  } else {
    checks.push(
      check(
        "resource-inherited-env",
        "pass",
        "No configuration from another worktree is inherited.",
      ),
    );
  }
  if (databasePath === ":memory:") {
    checks.push(
      check(
        "resource-database",
        "fail",
        "`:memory:` does not identify an exclusive database between executions.",
      ),
    );
  } else {
    checks.push(
      databaseUsers.length || databaseReservationPathsPresent.length
        ? check(
            "resource-database",
            "fail",
            "The temporary database is already reserved by an active or starting instance.",
            [
              ...databaseUsers.map(
                (instance) => `${instance.record.projectRoot} — ${instance.metadataPath}`,
              ),
              ...databaseReservationPathsPresent,
            ],
          )
        : existsSync(databasePath)
          ? check(
              "resource-database",
              "warn",
              "The database exists, but no active instance claims it.",
              [databasePath],
            )
          : check(
              "resource-database",
              "pass",
              "The temporary database is not shared by an active instance.",
              [databasePath],
            ),
    );
  }

  const inheritedPort = inheritedRepoMatches ? process.env.PRIME_BOARD_PORT : undefined;
  const preferredPort = options.port ?? Number(inheritedPort ?? DEFAULT_PORT);
  const explicit = options.port !== undefined || inheritedPort !== undefined;
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
    checks.push(check("resource-port", "fail", `Invalid port: ${preferredPort}.`));
    return { checks, databasePath, port: null };
  }
  const available = await findAvailablePort(
    preferredPort,
    explicit,
    homeDirectory,
    options.portProbe ?? isPortInUse,
    processProbe,
  );
  if (available.port === null) {
    checks.push(
      check("resource-port", "fail", `No port is available from ${preferredPort}.`, [
        `Ports checked: ${available.skipped.length}`,
      ]),
    );
    return { checks, databasePath, port: null };
  }
  checks.push(
    available.port === preferredPort
      ? check("resource-port", "pass", `Port ${available.port} is available.`)
      : check(
          "resource-port",
          "pass",
          `Port ${preferredPort} is occupied; free port ${available.port} was selected.`,
        ),
  );
  return { checks, databasePath, port: available.port };
}

function hasHookPath(text: string, repoRoot: string, relativePath: string): boolean {
  return text.includes(`$ROOT/${relativePath}`) || text.includes(`${repoRoot}/${relativePath}`);
}

function hasRepoTestPath(line: string, repoRoot: string): boolean {
  return (
    line.includes("$ROOT/") ||
    line.includes(`${repoRoot}/`) ||
    /(?:^|\s|["'])\.?\/?(?:apps|packages|scripts)\//.test(line)
  );
}

function hasConcurrency(line: string, value: number): boolean {
  return new RegExp(`--max-concurrency(?:=|\\s+)${value}(?:\\s|$)`).test(line);
}

export function inspectTestPlan(hookText: string, repoRoot: string): PreflightCheck[] {
  const text = hookText.replaceAll(/\\\r?\n/g, " ");
  const testLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bbun\s+test\b/.test(line));
  const checks: PreflightCheck[] = [];

  checks.push(
    /^\s*set\s+-e(?:u)?(?:\s|$)/m.test(text)
      ? check("tests-fail-fast", "pass", "The hook stops the delivery when a step fails.")
      : check("tests-fail-fast", "fail", "The hook does not enable fail-fast mode (`set -e`)."),
  );

  checks.push(
    testLines.length === 0
      ? check("tests-command", "fail", "The hook has no `bun test` command.")
      : testLines.every((line) => hasRepoTestPath(line, repoRoot))
        ? check("tests-command", "pass", "Every `bun test` command uses explicit repository paths.")
        : check(
            "tests-command",
            "fail",
            "The hook contains a `bun test` command without explicit paths.",
            testLines.filter((line) => !hasRepoTestPath(line, repoRoot)),
          ),
  );

  checks.push(
    testLines.some((line) => /scratchpad/i.test(line))
      ? check(
          "tests-scratchpad",
          "fail",
          "The hook includes `scratchpad` in test discovery.",
          testLines.filter((line) => /scratchpad/i.test(line)),
        )
      : check("tests-scratchpad", "pass", "The hook does not pass `scratchpad` to Bun."),
  );

  const missingPaths = REQUIRED_TEST_PATHS.filter((relativePath) => {
    const absolutePath = resolve(repoRoot, relativePath);
    return !existsSync(absolutePath) || !hasHookPath(text, repoRoot, relativePath);
  });
  checks.push(
    missingPaths.length
      ? check(
          "tests-versioned-scope",
          "fail",
          "The hook does not cover all required versioned tests.",
          missingPaths,
        )
      : check(
          "tests-versioned-scope",
          "pass",
          "The hook covers versioned CLI, server, web, MCP, packages, and scripts.",
        ),
  );

  const generalLine = testLines.find(
    (line) => line.includes("apps/server") && !line.includes("prime-board-project"),
  );
  checks.push(
    generalLine && hasConcurrency(generalLine, 5)
      ? check(
          "tests-general-concurrency",
          "pass",
          "The general suite uses a maximum concurrency of 5.",
        )
      : check(
          "tests-general-concurrency",
          "fail",
          "The general suite does not declare `--max-concurrency=5`.",
          generalLine ? [generalLine] : undefined,
        ),
  );

  const launcherLines = testLines.filter((line) => line.includes("prime-board-project"));
  const integrationLines = launcherLines.filter((line) => line.includes(".integration.test.ts"));
  const unitLines = launcherLines.filter(
    (line) =>
      line.includes("prime-board-project.test.ts") && !line.includes(".integration.test.ts"),
  );
  const integrationLine = integrationLines[0];
  const unitLine = unitLines[0];
  const launcherSeparated =
    integrationLines.length === 1 &&
    unitLines.length === 1 &&
    integrationLine !== undefined &&
    unitLine !== undefined &&
    integrationLine !== unitLine &&
    hasConcurrency(integrationLine, 1) &&
    hasConcurrency(unitLine, 1);
  checks.push(
    launcherSeparated
      ? check(
          "tests-launcher-isolation",
          "pass",
          "Launcher tests are separated and use concurrency 1.",
        )
      : check(
          "tests-launcher-isolation",
          "fail",
          "Launcher tests can run in parallel or do not use concurrency 1.",
          launcherLines,
        ),
  );

  return checks;
}

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightReport> {
  const repoPath = canonicalPath(options.repoPath ?? process.cwd());
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const checks: PreflightCheck[] = [];
  let repoRoot: string | null = null;
  let branch: string | null = null;
  let databasePath: string | null = null;
  let port: number | null = null;

  const rootResult = gitRunner(repoPath, ["rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0) {
    repoRoot = repoPath;
    checks.push(
      check("git-repository", "fail", "The path is not a Git repository with a worktree.", [
        rootResult.stderr.trim() || repoPath,
      ]),
    );
  } else {
    repoRoot = canonicalPath(rootResult.stdout.trim());
    checks.push(check("git-repository", "pass", `Git repository: ${repoRoot}.`));
  }

  const insideWorktree = gitRunner(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  const bare = gitRunner(repoRoot, ["rev-parse", "--is-bare-repository"]);
  const commonDir = gitRunner(repoRoot, ["rev-parse", "--git-common-dir"]);
  const coreBare = gitRunner(repoRoot, ["config", "--local", "--bool", "--get", "core.bare"]);
  checks.push(
    commonDir.exitCode === 0
      ? check("git-common-dir", "pass", `Git common directory: ${commonDir.stdout.trim()}.`)
      : check("git-common-dir", "fail", "The Git common directory could not be resolved.", [
          commonDir.stderr.trim(),
        ]),
  );
  if (coreBare.stdout.trim().toLowerCase() === "true" || bare.stdout.trim() === "true") {
    checks.push(check("git-worktree", "fail", "`core.bare=true`; the checkout may be unusable."));
  } else if (insideWorktree.stdout.trim() === "true") {
    checks.push(check("git-worktree", "pass", "The checkout is a non-bare worktree."));
  } else {
    checks.push(check("git-worktree", "fail", "Git does not recognize a usable worktree."));
  }

  const status = gitRunner(repoRoot, ["status", "--porcelain=v2", "--untracked-files=all"]);
  checks.push(
    status.exitCode !== 0
      ? check("git-clean", "fail", "The worktree clean state could not be checked.", [
          status.stderr.trim(),
        ])
      : status.stdout.trim()
        ? check(
            "git-clean",
            "fail",
            "The worktree has changes before preflight.",
            status.stdout.trim().split(/\r?\n/),
          )
        : check("git-clean", "pass", "The worktree is clean."),
  );

  const branchResult = gitRunner(repoRoot, ["branch", "--show-current"]);
  branch = branchResult.stdout.trim() || null;
  checks.push(
    branch
      ? check("git-branch", "pass", `Current branch: ${branch}.`)
      : check("git-branch", "fail", "The checkout is detached; an explicit branch is required."),
  );
  if (options.expectedBranch && branch !== options.expectedBranch) {
    checks.push(
      check(
        "git-expected-branch",
        "fail",
        `The current branch does not match --branch: ${options.expectedBranch}.`,
        [branch ?? "(detached)"],
      ),
    );
  } else if (options.expectedBranch) {
    checks.push(
      check("git-expected-branch", "pass", `The branch matches ${options.expectedBranch}.`),
    );
  }

  const worktreeResult = gitRunner(repoRoot, ["worktree", "list", "--porcelain"]);
  const pruneResult = gitRunner(repoRoot, ["worktree", "prune", "--dry-run"]);
  checks.push(
    pruneResult.exitCode !== 0
      ? check("worktree-prune", "fail", "Orphaned worktrees could not be audited.", [
          pruneResult.stderr.trim(),
        ])
      : pruneResult.stdout.trim()
        ? check("worktree-prune", "fail", "Git reports worktree records that should be pruned.", [
            pruneResult.stdout.trim(),
          ])
        : check("worktree-prune", "pass", "No orphaned worktree records were found."),
  );
  if (worktreeResult.exitCode !== 0 || !branch) {
    checks.push(
      check("worktree-list", "fail", "The worktree list could not be read.", [
        worktreeResult.stderr.trim() || "The branch is not available.",
      ]),
    );
  } else {
    checks.push(check("worktree-list", "pass", "The worktree list was read successfully."));
    checks.push(
      ...inspectWorktrees(
        parseWorktreePorcelain(worktreeResult.stdout),
        repoRoot,
        branch,
        options.unit,
      ),
    );
  }

  const hookPath = options.hookPath ?? join(repoRoot, ".husky", "pre-commit");
  if (!existsSync(hookPath)) {
    checks.push(
      check("tests-hook", "fail", "The pre-commit hook to audit does not exist.", [hookPath]),
    );
  } else {
    checks.push(...inspectTestPlan(readFileSync(hookPath, "utf8"), repoRoot));
  }

  if (repoRoot) {
    const resources = await inspectResources(repoRoot, options);
    checks.push(...resources.checks);
    databasePath = resources.databasePath;
    port = resources.port;
  }

  const hasFailures = checks.some((item) => item.status === "fail");
  const hasWarnings = checks.some((item) => item.status === "warn");
  return {
    passed: !hasFailures && !(options.strict && hasWarnings),
    repoPath,
    repoRoot,
    branch,
    databasePath,
    port,
    checks,
  };
}
