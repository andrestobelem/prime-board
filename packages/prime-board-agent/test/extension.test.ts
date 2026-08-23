import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPrimeBoardExtension,
  discoverPrimeBoardProject,
  getPrimeBoardStatus,
} from "../extensions/index.ts";
import {
  createRuntimeController,
  type FetchLike,
  projectCredentialPath,
  projectLogPath,
  readProjectCredential,
  saveProjectCredential,
} from "../extensions/runtime.ts";

type FakeContext = {
  cwd: string;
  ui: { notify(message: string, level: string): void };
};

function gitProject(): { home: string; root: string; runtimeRoot: string } {
  const home = join(tmpdir(), `prime-board-agent-${crypto.randomUUID()}`);
  const rootPath = join(home, "project with spaces");
  const runtimeRoot = join(home, "prime-board");
  mkdirSync(rootPath, { recursive: true });
  const root = realpathSync(rootPath);
  mkdirSync(join(runtimeRoot, "scripts"), { recursive: true });
  writeFileSync(join(runtimeRoot, "scripts", "prime-board-project.ts"), "// test runtime\n");
  expect(spawnSync("git", ["-C", root, "init", "-q"]).status).toBe(0);
  return { home, root, runtimeRoot };
}

describe("Prime Board extension lifecycle", () => {
  it("resolves Git projects with spaces and starts one shared runtime for concurrent sessions", async () => {
    const project = gitProject();
    try {
      expect(discoverPrimeBoardProject(project.root)).toBe(project.root);
      let running = false;
      let launches = 0;
      const notifications: string[] = [];
      const events = new Map<string, (event: { reason?: string }, ctx: FakeContext) => unknown>();
      const commands = new Map<string, (args: string, ctx: FakeContext) => unknown>();
      const fakePi = {
        on(name: string, handler: (event: { reason?: string }, ctx: FakeContext) => unknown) {
          events.set(name, handler);
        },
        registerCommand(
          name: string,
          definition: { handler: (args: string, ctx: FakeContext) => unknown },
        ) {
          commands.set(name, definition.handler);
        },
        registerTool() {},
      };
      const okFetch: FetchLike = async () => new Response("ok", { status: 200 });
      const controller = createPrimeBoardExtension({
        home: project.home,
        env: { PRIME_BOARD_ROOT: project.runtimeRoot, PRIME_BOARD_API_KEY: "pb_test_secret" },
        runtimeDependencies: {
          runStatus(args) {
            return {
              status: running ? 0 : 1,
              stdout: running
                ? `running project=${project.root} port=3401 pid=1234 db=/tmp/a.db`
                : `not-running project=${project.root} db=/tmp/a.db`,
              stderr: "",
            };
          },
          launch() {
            launches += 1;
            running = true;
            return { pid: 1234, unref() {} };
          },
          fetch: okFetch,
          sleep: async () => undefined,
        },
      });
      controller(fakePi);
      const context = {
        cwd: project.root,
        ui: { notify: (message: string) => notifications.push(message) },
      };
      const sessionStart = events.get("session_start")!;
      await Promise.all([
        sessionStart({ reason: "startup" }, context),
        sessionStart({ reason: "startup" }, context),
      ]);
      expect(launches).toBe(1);
      expect(notifications.filter((value) => value.includes("Runtime is running"))).toHaveLength(2);
      expect(readProjectCredential(project.root, project.home)).toMatchObject({
        apiKey: "pb_test_secret",
        url: "http://127.0.0.1:3401",
      });
      expect(commands.has("prime-board")).toBe(true);
      await commands.get("prime-board")!("status", context);
      expect(notifications.at(-1)).toContain("Runtime is running");
      await events.get("session_shutdown")!({ reason: "shutdown" }, context);
      expect(launches).toBe(1);
    } finally {
      rmSync(project.home, { recursive: true, force: true });
    }
  });

  it("provides open, logs, stop, and auth contracts without writing secrets to the project", async () => {
    const project = gitProject();
    try {
      let running = true;
      let killed = 0;
      const opened: string[] = [];
      const okFetch: FetchLike = async () => new Response("ok");
      const runtime = createRuntimeController(
        {
          runStatus: () => ({
            status: running ? 0 : 1,
            stdout: running
              ? `running project=${project.root} port=3402 pid=4321 db=/tmp/b.db`
              : `not-running project=${project.root} db=/tmp/b.db`,
            stderr: "",
          }),
          kill: () => {
            killed += 1;
            running = false;
          },
          sleep: async () => undefined,
          fetch: okFetch,
          openUrl: (_command, args) => opened.push(args[0]!),
          platform: "darwin",
        },
        { PRIME_BOARD_ROOT: project.runtimeRoot },
        project.home,
      );
      const logPath = projectLogPath(project.root, project.home);
      mkdirSync(join(project.home, ".prime-board", "logs"), { recursive: true });
      writeFileSync(logPath, "Admin API key (save it now): pb_secret\nhealthy\n");
      chmodSync(logPath, 0o600);
      expect(runtime.logs(project.root)).toContain("[redacted-api-key]");
      expect(runtime.logs(project.root)).not.toContain("pb_secret");
      expect(runtime.open(project.root).url).toBe("http://127.0.0.1:3402");
      expect(opened).toEqual(["http://127.0.0.1:3402"]);
      expect((await runtime.stop(project.root)).state).toBe("stopped");
      expect(killed).toBe(1);

      const credential = saveProjectCredential(project.root, { apiKey: "pb_secret" }, project.home);
      expect(credential).toBe(projectCredentialPath(project.root, project.home));
      expect(readProjectCredential(project.root, project.home)?.apiKey).toBe("pb_secret");
      expect(() => {
        chmodSync(credential, 0o644);
        readProjectCredential(project.root, project.home);
      }).toThrow("0600");
    } finally {
      rmSync(project.home, { recursive: true, force: true });
    }
  });

  it("reports a non-Git directory as unavailable even when the URL is healthy", async () => {
    const path = join(tmpdir(), `not-a-git-${crypto.randomUUID()}`);
    mkdirSync(path, { recursive: true });
    try {
      const status = await getPrimeBoardStatus(path, "http://127.0.0.1:3333");
      expect(status).toMatchObject({ projectRoot: null, state: "unavailable" });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
