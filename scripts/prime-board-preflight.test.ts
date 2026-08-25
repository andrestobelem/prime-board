import { describe, expect, test } from "bun:test";
import {
  inspectTestPlan,
  inspectWorktrees,
  readActivePortReservations,
  runPreflight,
  type WorktreeEntry,
} from "./prime-board-preflight-lib.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveProjectIdentity } from "./prime-board-project-lib.ts";

const hook = readFileSync(join(import.meta.dir, "..", ".husky", "pre-commit"), "utf8");

function fixtureHook(): string {
  return hook.replaceAll('"$ROOT/apps/cli/test"', '"$ROOT/apps/cli/test"');
}

function createGitFixture(): { root: string; home: string; db: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "prime-board-preflight-git-"));
  const home = join(root, "home");
  const db = join(root, "state", "run.db");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, ".husky"), { recursive: true });
  for (const relativePath of [
    "apps/cli/test",
    "apps/server",
    "apps/web",
    "apps/mcp",
    "packages",
    "scripts",
  ]) {
    mkdirSync(join(root, relativePath), { recursive: true });
  }
  for (const relativePath of [
    "apps/cli/test/sentinel.test.ts",
    "apps/server/sentinel.test.ts",
    "apps/web/sentinel.test.ts",
    "apps/mcp/sentinel.test.ts",
    "packages/sentinel.test.ts",
    "scripts/prime-board-project.integration.test.ts",
    "scripts/prime-board-project.test.ts",
  ]) {
    writeFileSync(join(root, relativePath), "export {};\n");
  }
  writeFileSync(join(root, ".husky", "pre-commit"), fixtureHook());
  Bun.spawnSync(["git", "init", "-q", "-b", "main", root]);
  Bun.spawnSync(["git", "-C", root, "config", "user.email", "preflight@example.test"]);
  Bun.spawnSync(["git", "-C", root, "config", "user.name", "Preflight Test"]);
  Bun.spawnSync(["git", "-C", root, "add", "."]);
  const commit = Bun.spawnSync(["git", "-C", root, "commit", "-qm", "fixture"]);
  if (commit.exitCode !== 0) throw new Error(commit.stderr.toString());
  Bun.spawnSync(["git", "-C", root, "checkout", "-qb", "ghostty-scout/prb-543"]);
  return { root, home, db, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function gitAt(root: string, args: string[]): GitCommandResult {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("PRB-567 hook Git isolation", () => {
  test("el hook conserva HEAD, índice y archivos del repositorio llamador", () => {
    const caller = createGitFixture();
    const resetGitContext = hook.split(/\r?\n/u).find((line) => line.startsWith("unset GIT_DIR "));
    const before = {
      head: gitAt(caller.root, ["rev-parse", "HEAD"]).stdout,
      index: gitAt(caller.root, ["write-tree"]).stdout,
      status: gitAt(caller.root, ["status", "--porcelain=v2", "--untracked-files=all"]).stdout,
      bare: gitAt(caller.root, ["config", "--local", "--bool", "--get", "core.bare"]).stdout,
    };
    const fixtureRoot = mkdtempSync(join(tmpdir(), "prime-board-preflight-child-"));
    const environment = {
      ...process.env,
      GIT_DIR: join(caller.root, ".git"),
      GIT_WORK_TREE: caller.root,
      GIT_INDEX_FILE: join(caller.root, ".git", "index"),
      GIT_COMMON_DIR: join(caller.root, ".git"),
    };
    const script = `${resetGitContext ?? ""}
set -eu
fixture="$1"
mkdir -p "$fixture/apps/cli/test"
printf 'export {}\n' > "$fixture/apps/cli/test/sentinel.test.ts"
git init -q -b main "$fixture"
git -C "$fixture" config user.email preflight@example.test
git -C "$fixture" config user.name "Preflight Test"
git -C "$fixture" add .
git -C "$fixture" commit -qm fixture
`;
    try {
      expect(resetGitContext).toBe(
        "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX",
      );
      const result = Bun.spawnSync(["sh", "-eu", "-c", script, "preflight-fixture", fixtureRoot], {
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(gitAt(caller.root, ["rev-parse", "HEAD"]).stdout).toBe(before.head);
      expect(gitAt(caller.root, ["write-tree"]).stdout).toBe(before.index);
      expect(gitAt(caller.root, ["status", "--porcelain=v2", "--untracked-files=all"]).stdout).toBe(
        before.status,
      );
      expect(gitAt(caller.root, ["config", "--local", "--bool", "--get", "core.bare"]).stdout).toBe(
        before.bare,
      );
      expect(gitAt(fixtureRoot, ["rev-parse", "--show-toplevel"]).stdout.trim()).toBe(
        realpathSync(fixtureRoot),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      caller.cleanup();
    }
  });
});

describe("PRB-543 test plan", () => {
  test("PRB-506: rejects discovery without explicit paths or with scratchpad", () => {
    const checks = inspectTestPlan("bun test\nbun test scratchpad/worktrees/fake", "/tmp/repo");
    expect(checks.find((item) => item.id === "tests-command")?.status).toBe("fail");
    expect(checks.find((item) => item.id === "tests-scratchpad")?.status).toBe("fail");
  });

  test("PRB-507: requires separate launcher commands at concurrency one", () => {
    const badHook = `
      bun test --max-concurrency=5 "$ROOT/apps/server" "$ROOT/packages"
      bun test --max-concurrency=5 "$ROOT/scripts/prime-board-project.integration.test.ts" "$ROOT/scripts/prime-board-project.test.ts"
    `;
    const checks = inspectTestPlan(badHook, "/tmp/repo");
    expect(checks.find((item) => item.id === "tests-general-concurrency")?.status).toBe("pass");
    expect(checks.find((item) => item.id === "tests-launcher-isolation")?.status).toBe("fail");
  });

  test("PRB-506: an explicit Bun path does not discover a scratchpad sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "prime-board-bun-scope-"));
    try {
      const versioned = join(root, "apps", "server");
      const scratchpad = join(root, "scratchpad", "worktrees", "fake");
      mkdirSync(versioned, { recursive: true });
      mkdirSync(scratchpad, { recursive: true });
      writeFileSync(
        join(versioned, "versioned.test.ts"),
        'import { expect, test } from "bun:test"; test("versioned", () => expect(true).toBe(true));\n',
      );
      writeFileSync(
        join(scratchpad, "sentinel.test.ts"),
        'throw new Error("scratchpad sentinel ran");\n',
      );
      const result = Bun.spawnSync(
        [process.execPath, "test", join(versioned, "versioned.test.ts")],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout.toString()}${result.stderr.toString()}`).not.toContain(
        "scratchpad sentinel ran",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts the versioned hook scope and launcher isolation", () => {
    const checks = inspectTestPlan(hook, process.cwd());
    expect(checks.every((item) => item.status === "pass")).toBe(true);
  });
});

describe("PRB-543 Git preflight", () => {
  test("PRB-495: checks a real bare repository without modifying it", async () => {
    const root = mkdtempSync(join(tmpdir(), "prime-board-preflight-bare-"));
    const bare = join(root, "repo.git");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    try {
      const initialized = Bun.spawnSync(["git", "init", "--bare", "-q", bare]);
      expect(initialized.exitCode).toBe(0);
      const report = await runPreflight({
        repoPath: bare,
        expectedBranch: "main",
        unit: "PRB-495",
        homeDirectory: home,
        databasePath: join(root, "state", "bare.db"),
        port: 41009,
        portProbe: async () => true,
        processProbe: () => false,
      });
      expect(report.passed).toBe(false);
      expect(report.checks.find((item) => item.id === "git-worktree")?.status).toBe("fail");
      expect(
        Bun.spawnSync(["git", "-C", bare, "rev-parse", "--is-bare-repository"])
          .stdout.toString()
          .trim(),
      ).toBe("true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PRB-495: creates, uses, and removes one worktree without touching the user's worktree", () => {
    const fixture = createGitFixture();
    const userWorktree = join(fixture.root, "user-worktree");
    const diagnosticWorktree = join(fixture.root, "diagnostic-worktree");
    const git = (path: string, args: string[]) =>
      Bun.spawnSync(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
    try {
      const user = git(fixture.root, ["worktree", "add", "-qb", "user/worktree", userWorktree]);
      expect(user.exitCode).toBe(0);
      const before = git(fixture.root, ["worktree", "list", "--porcelain"]);
      expect(before.exitCode).toBe(0);
      expect(
        git(fixture.root, ["config", "--local", "--bool", "--get", "core.bare"])
          .stdout.toString()
          .trim(),
      ).toBe("false");

      const created = git(fixture.root, [
        "worktree",
        "add",
        "-qb",
        "diagnostic/worktree",
        diagnosticWorktree,
      ]);
      expect(created.exitCode).toBe(0);
      expect(git(diagnosticWorktree, ["status", "--short", "--branch"]).exitCode).toBe(0);
      expect(
        git(fixture.root, ["config", "--local", "--bool", "--get", "core.bare"])
          .stdout.toString()
          .trim(),
      ).toBe("false");

      const removed = git(fixture.root, ["worktree", "remove", diagnosticWorktree]);
      expect(removed.exitCode).toBe(0);
      const after = git(fixture.root, ["worktree", "list", "--porcelain"]);
      expect(after.exitCode).toBe(0);
      expect(after.stdout.toString()).toBe(before.stdout.toString());
      expect(existsSync(userWorktree)).toBe(true);
      expect(git(userWorktree, ["status", "--short", "--branch"]).exitCode).toBe(0);
      expect(
        git(fixture.root, ["config", "--local", "--bool", "--get", "core.bare"])
          .stdout.toString()
          .trim(),
      ).toBe("false");
    } finally {
      fixture.cleanup();
    }
  });

  test("PRB-495: reports core.bare without modifying the repository", async () => {
    const fixture = createGitFixture();
    try {
      Bun.spawnSync(["git", "-C", fixture.root, "config", "core.bare", "true"]);
      const report = await runPreflight({
        repoPath: fixture.root,
        expectedBranch: "ghostty-scout/prb-543",
        unit: "PRB-543",
        homeDirectory: fixture.home,
        databasePath: fixture.db,
        port: 41001,
        portProbe: async () => true,
        processProbe: () => false,
      });
      expect(report.passed).toBe(false);
      expect(report.checks.find((item) => item.id === "git-worktree")?.status).toBe("fail");
      expect(
        Bun.spawnSync(["git", "-C", fixture.root, "config", "--get", "core.bare"])
          .stdout.toString()
          .trim(),
      ).toBe("true");
    } finally {
      fixture.cleanup();
    }
  });

  test("passes a clean branch and detects dirty state without stashing", async () => {
    const fixture = createGitFixture();
    try {
      const clean = await runPreflight({
        repoPath: fixture.root,
        expectedBranch: "ghostty-scout/prb-543",
        unit: "PRB-543",
        homeDirectory: fixture.home,
        databasePath: fixture.db,
        port: 41002,
        portProbe: async () => true,
        processProbe: () => false,
      });
      expect(clean.checks.find((item) => item.id === "git-clean")?.status).toBe("pass");
      writeFileSync(join(fixture.root, "untracked.txt"), "do not hide me\n");
      const dirty = await runPreflight({
        repoPath: fixture.root,
        expectedBranch: "ghostty-scout/prb-543",
        unit: "PRB-543",
        homeDirectory: fixture.home,
        databasePath: fixture.db,
        port: 41002,
        portProbe: async () => true,
        processProbe: () => false,
      });
      const cleanCheck = dirty.checks.find((item) => item.id === "git-clean");
      expect(cleanCheck?.status).toBe("fail");
      expect(cleanCheck?.details?.join(" ")).not.toContain("do not hide me");
    } finally {
      fixture.cleanup();
    }
  });

  test("detects two branches for one unit but not a longer unit token", () => {
    const entries: WorktreeEntry[] = [
      {
        path: "/tmp/ghostty-scout-prb-543",
        head: "a",
        branch: "ghostty-scout/prb-543",
        bare: false,
      },
      { path: "/tmp/other-prb-543", head: "b", branch: "other/prb-543", bare: false },
    ];
    const duplicate = inspectWorktrees(
      entries,
      "/tmp/ghostty-scout-prb-543",
      "ghostty-scout/prb-543",
      "PRB-543",
    );
    expect(duplicate.find((item) => item.id === "worktree-unit")?.status).toBe("fail");

    const nonMatching: WorktreeEntry[] = [
      {
        path: "/tmp/ghostty-scout-prb-543",
        head: "a",
        branch: "ghostty-scout/prb-543",
        bare: false,
      },
      { path: "/tmp/other-prb-5430", head: "b", branch: "other/prb-5430", bare: false },
    ];
    const distinct = inspectWorktrees(
      nonMatching,
      "/tmp/ghostty-scout-prb-543",
      "ghostty-scout/prb-543",
      "PRB-543",
    );
    expect(distinct.find((item) => item.id === "worktree-unit")?.status).toBe("pass");

    const unknownIdentity = inspectWorktrees(
      [
        { path: "/tmp/first", head: "a", branch: "feature/first", bare: false },
        { path: "/tmp/second", head: "b", branch: "feature/second", bare: false },
      ],
      "/tmp/first",
      "feature/first",
      "PRB-543",
    );
    expect(unknownIdentity.find((item) => item.id === "worktree-unit")?.status).toBe("fail");
    expect(unknownIdentity.find((item) => item.id === "worktree-unit")?.message).toContain(
      "reliable identity",
    );
  });
});

describe("PRB-543 resource preflight", () => {
  test("rejects an incomplete port reservation without deleting it", async () => {
    const fixture = createGitFixture();
    try {
      const lockPath = join(fixture.home, ".prime-board", "ports", "41003.lock");
      mkdirSync(lockPath, { recursive: true });
      const report = await runPreflight({
        repoPath: fixture.root,
        expectedBranch: "ghostty-scout/prb-543",
        unit: "PRB-543",
        homeDirectory: fixture.home,
        databasePath: fixture.db,
        port: 41003,
        portProbe: async () => true,
        processProbe: () => false,
      });
      expect(report.checks.find((item) => item.id === "resource-port")?.status).toBe("fail");
      expect(readActivePortReservations(fixture.home, () => false)).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  test("ignores resources inherited from another worktree", async () => {
    const fixture = createGitFixture();
    const previous = {
      repo: process.env.PRIME_BOARD_REPO,
      db: process.env.PRIME_BOARD_DB,
      port: process.env.PRIME_BOARD_PORT,
    };
    try {
      process.env.PRIME_BOARD_REPO = "/tmp/another-worktree";
      process.env.PRIME_BOARD_DB = "/tmp/another.db";
      process.env.PRIME_BOARD_PORT = "41006";
      const report = await runPreflight({
        repoPath: fixture.root,
        expectedBranch: "ghostty-scout/prb-543",
        unit: "PRB-543",
        homeDirectory: fixture.home,
        portProbe: async () => true,
        processProbe: () => false,
      });
      expect(report.checks.find((item) => item.id === "resource-inherited-env")?.status).toBe(
        "warn",
      );
      expect(report.databasePath).not.toBe("/tmp/another.db");
      expect(report.port).toBe(3333);
    } finally {
      if (previous.repo === undefined) delete process.env.PRIME_BOARD_REPO;
      else process.env.PRIME_BOARD_REPO = previous.repo;
      if (previous.db === undefined) delete process.env.PRIME_BOARD_DB;
      else process.env.PRIME_BOARD_DB = previous.db;
      if (previous.port === undefined) delete process.env.PRIME_BOARD_PORT;
      else process.env.PRIME_BOARD_PORT = previous.port;
      fixture.cleanup();
    }
  });

  test("rejects an atomic database reservation without an instance record", async () => {
    const fixture = createGitFixture();
    const identity = deriveProjectIdentity(fixture.root, fixture.home, fixture.db);
    try {
      mkdirSync(identity.databaseLockPath, { recursive: true });
      const report = await runPreflight({
        repoPath: fixture.root,
        expectedBranch: "ghostty-scout/prb-543",
        unit: "PRB-543",
        homeDirectory: fixture.home,
        databasePath: fixture.db,
        port: 41007,
        portProbe: async () => true,
        processProbe: () => false,
      });
      expect(report.checks.find((item) => item.id === "resource-database")?.status).toBe("fail");
      expect(existsSync(identity.databaseLockPath)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("does not inherit DB or port without PRIME_BOARD_REPO", async () => {
    const fixture = createGitFixture();
    const previous = {
      repo: process.env.PRIME_BOARD_REPO,
      db: process.env.PRIME_BOARD_DB,
      port: process.env.PRIME_BOARD_PORT,
    };
    try {
      delete process.env.PRIME_BOARD_REPO;
      process.env.PRIME_BOARD_DB = "/tmp/inherited-without-repo.db";
      process.env.PRIME_BOARD_PORT = "41008";
      const report = await runPreflight({
        repoPath: fixture.root,
        expectedBranch: "ghostty-scout/prb-543",
        unit: "PRB-543",
        homeDirectory: fixture.home,
        portProbe: async () => true,
        processProbe: () => false,
      });
      expect(report.checks.find((item) => item.id === "resource-inherited-env")?.status).toBe(
        "warn",
      );
      expect(report.databasePath).not.toBe("/tmp/inherited-without-repo.db");
      expect(report.port).toBe(3333);
    } finally {
      if (previous.repo === undefined) delete process.env.PRIME_BOARD_REPO;
      else process.env.PRIME_BOARD_REPO = previous.repo;
      if (previous.db === undefined) delete process.env.PRIME_BOARD_DB;
      else process.env.PRIME_BOARD_DB = previous.db;
      if (previous.port === undefined) delete process.env.PRIME_BOARD_PORT;
      else process.env.PRIME_BOARD_PORT = previous.port;
      fixture.cleanup();
    }
  });

  test("rejects a database claimed by an active instance", async () => {
    const fixture = createGitFixture();
    try {
      const lockPath = join(fixture.home, ".prime-board", "projects", "other.lock");
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(
        join(lockPath, "instance.json"),
        JSON.stringify({
          version: 1,
          projectRoot: "/tmp/other-project",
          databasePath: fixture.db,
          port: 41004,
          pid: 12345,
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const report = await runPreflight({
        repoPath: fixture.root,
        expectedBranch: "ghostty-scout/prb-543",
        unit: "PRB-543",
        homeDirectory: fixture.home,
        databasePath: fixture.db,
        port: 41005,
        portProbe: async () => true,
        processProbe: (pid) => pid === 12345,
      });
      expect(report.checks.find((item) => item.id === "resource-database")?.status).toBe("fail");
    } finally {
      fixture.cleanup();
    }
  });
});
