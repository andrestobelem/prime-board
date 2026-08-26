import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPrimeBoardExtension,
  discoverPrimeBoardProject,
  getPrimeBoardStatus,
} from "../extensions/index.ts";
import {
  clearGitEnvironment,
  createRuntimeController,
  type FetchLike,
  projectCredentialPath,
  projectLogPath,
  readProjectCredential,
  saveProjectCredential,
} from "../extensions/runtime.ts";

type FakeContext = {
  cwd: string;
  sessionManager?: { getEntries(): readonly unknown[] };
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
  expect(spawnSync("git", ["-C", root, "init", "-q"], { env: clearGitEnvironment() }).status).toBe(
    0,
  );
  return { home, root, runtimeRoot };
}

describe("Prime Board extension lifecycle", () => {
  it("resolves the project with process Git variables cleared", () => {
    const project = gitProject();
    const previousGitDir = process.env.GIT_DIR;
    const previousGitIndex = process.env.GIT_INDEX_FILE;
    try {
      process.env.GIT_DIR = join(project.home, "foreign.git");
      process.env.GIT_INDEX_FILE = join(project.home, "foreign.index");
      expect(discoverPrimeBoardProject(join(project.root, "missing"))).toBeNull();
      expect(discoverPrimeBoardProject(project.root)).toBe(project.root);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousGitIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousGitIndex;
      rmSync(project.home, { recursive: true, force: true });
    }
  });

  it("passes a Git-clean environment to status and launcher processes", async () => {
    const project = gitProject();
    const seen: NodeJS.ProcessEnv[] = [];
    try {
      let running = false;
      const runtime = createRuntimeController(
        {
          runStatus: (_args, _cwd, environment) => {
            seen.push(environment);
            return {
              status: running ? 0 : 1,
              stdout: running
                ? `running project=${project.root} port=3404 pid=3404 db=/tmp/d.db`
                : `not-running project=${project.root} db=/tmp/d.db`,
              stderr: "",
            };
          },
          launch: (_args, _cwd, environment) => {
            seen.push(environment);
            running = true;
            return { pid: 3404, unref() {} };
          },
          fetch: async () => new Response("ok"),
          sleep: async () => undefined,
        },
        {
          PRIME_BOARD_ROOT: project.runtimeRoot,
          GIT_DIR: join(project.home, "foreign.git"),
          GIT_INDEX_FILE: join(project.home, "foreign.index"),
        },
        project.home,
      );
      expect((await runtime.ensure(project.root)).state).toBe("running");
      expect(seen.length).toBeGreaterThan(0);
      for (const environment of seen) {
        expect(Object.keys(environment).some((key) => key.startsWith("GIT_"))).toBe(false);
      }
    } finally {
      rmSync(project.home, { recursive: true, force: true });
    }
  });

  it("returns an actionable error when the runtime process cannot start", async () => {
    const project = gitProject();
    try {
      const runtime = createRuntimeController(
        {
          runStatus: () => ({
            status: 1,
            stdout: `not-running project=${project.root} db=/tmp/e.db`,
            stderr: "",
          }),
          launch: () => {
            throw new Error("ENOENT: bun");
          },
        },
        { PRIME_BOARD_ROOT: project.runtimeRoot },
        project.home,
      );
      const status = await runtime.ensure(project.root);
      expect(status.state).toBe("unavailable");
      expect(status.detail).toContain("Install Bun or set PRIME_BOARD_BUN");
      expect(status.detail).toContain(status.logPath);
    } finally {
      rmSync(project.home, { recursive: true, force: true });
    }
  });

  it("resolves Git projects with spaces and starts one shared runtime for concurrent sessions", async () => {
    const project = gitProject();
    try {
      expect(discoverPrimeBoardProject(project.root)).toBe(project.root);
      let running = false;
      let launches = 0;
      const notifications: string[] = [];
      const events = new Map<string, (event: { reason?: string }, ctx: FakeContext) => unknown>();
      const commands = new Map<string, (args: string, ctx: FakeContext) => unknown>();
      const sessionEntries: unknown[] = [];
      const namedSessions: string[] = [];
      const fakePi = {
        on(name: string, handler: (event: { reason?: string }, ctx: FakeContext) => unknown) {
          events.set(name, handler);
        },
        setSessionName(name: string) {
          namedSessions.push(name);
        },
        appendEntry(_customType: string, data: unknown) {
          sessionEntries.push({ customType: "prime-board-actor-binding", data });
        },
        registerCommand(
          name: string,
          definition: { handler: (args: string, ctx: FakeContext) => unknown },
        ) {
          commands.set(name, definition.handler);
        },
        registerTool() {},
      };
      const okFetch: FetchLike = async (input, init) => {
        if (String(input).endsWith("/health")) return new Response("ok", { status: 200 });
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        if (body.query?.includes("viewer")) {
          return new Response(
            JSON.stringify({ data: { viewer: { id: "agent-1", name: "Scout", type: "AGENT" } } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
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
        sessionManager: {
          getEntries: () => [
            ...sessionEntries,
            { type: "message", message: { role: "assistant" } },
          ],
        },
        ui: { notify: (message: string) => notifications.push(message) },
      };
      const sessionStart = events.get("session_start")!;
      await Promise.all([
        sessionStart({ reason: "startup" }, context),
        sessionStart({ reason: "startup" }, context),
      ]);
      expect(launches).toBe(1);
      expect(namedSessions).toEqual(["Scout", "Scout"]);
      expect(sessionEntries).toHaveLength(2);
      expect(notifications.filter((value) => value.includes("Runtime is running"))).toHaveLength(2);
      expect(readProjectCredential(project.root, project.home)).toMatchObject({
        apiKey: "pb_test_secret",
        url: "http://127.0.0.1:3401",
      });
      expect(commands.has("prime-board")).toBe(true);
      await commands.get("prime-board")!("status", context);
      expect(notifications.at(-1)).toContain("Runtime is running");
      await events.get("session_shutdown")!({ reason: "shutdown" }, context);
      await events.get("session_start")!({ reason: "reload" }, context);
      expect(launches).toBe(1);
    } finally {
      rmSync(project.home, { recursive: true, force: true });
    }
  });

  it("binds four concurrent isolated sessions to distinct authenticated Actor names", async () => {
    const sessions = ["Scout", "Builder", "Micaela", "Carorila"].map((actor) => ({
      actor,
      project: gitProject(),
    }));
    const results: Array<{ actor: string; names: string[]; entries: unknown[] }> = [];
    try {
      await Promise.all(
        sessions.map(async ({ actor, project }, index) => {
          let running = false;
          const events = new Map<
            string,
            (event: { reason?: string }, ctx: FakeContext) => unknown
          >();
          const names: string[] = [];
          const entries: unknown[] = [];
          const port = 3420 + index;
          const controller = createPrimeBoardExtension({
            home: project.home,
            env: {
              PRIME_BOARD_ROOT: project.runtimeRoot,
              PRIME_BOARD_API_KEY: `pb_${actor.toLowerCase()}`,
            },
            runtimeDependencies: {
              runStatus: () => ({
                status: running ? 0 : 1,
                stdout: running
                  ? `running project=${project.root} port=${port} pid=${port} db=/tmp/${port}.db`
                  : `not-running project=${project.root} db=/tmp/${port}.db`,
                stderr: "",
              }),
              launch: () => {
                running = true;
                return { pid: port, unref() {} };
              },
              fetch: async (input, init) => {
                if (String(input).endsWith("/health")) return new Response("ok");
                const body = String(init?.body ?? "");
                return body.includes("viewer")
                  ? new Response(
                      JSON.stringify({
                        data: {
                          viewer: {
                            id: `actor-${actor.toLowerCase()}`,
                            name: actor,
                            type: "AGENT",
                          },
                        },
                      }),
                      { status: 200, headers: { "content-type": "application/json" } },
                    )
                  : new Response(JSON.stringify({ data: {} }), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    });
              },
              sleep: async () => undefined,
            },
          });
          const fakePi = {
            on(name: string, handler: (event: { reason?: string }, ctx: FakeContext) => unknown) {
              events.set(name, handler);
            },
            setSessionName(name: string) {
              names.push(name);
            },
            appendEntry(customType: string, data: unknown) {
              entries.push({ customType, data });
            },
            registerCommand() {},
            registerTool() {},
          };
          controller(fakePi);
          const context = {
            cwd: project.root,
            sessionManager: {
              getEntries: () => [...entries, { type: "message", message: { role: "assistant" } }],
            },
            ui: { notify: () => undefined },
          };
          await events.get("session_start")!({ reason: "startup" }, context);
          results.push({ actor, names, entries });
        }),
      );

      expect(results).toHaveLength(4);
      expect(new Set(results.map((result) => result.names[0]))).toEqual(
        new Set(["Scout", "Builder", "Micaela", "Carorila"]),
      );
      for (const result of results) {
        expect(result.names).toEqual([result.actor]);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({
          customType: "prime-board-actor-binding",
          data: { actorId: `actor-${result.actor.toLowerCase()}`, actorName: result.actor },
        });
      }
    } finally {
      for (const { project } of sessions) rmSync(project.home, { recursive: true, force: true });
    }
  });

  it("rejects a persisted session when its Actor binding differs from authentication", async () => {
    const project = gitProject();
    const notifications: string[] = [];
    const names: string[] = [];
    const events = new Map<string, (event: { reason?: string }, ctx: FakeContext) => unknown>();
    const entries = [
      {
        customType: "prime-board-actor-binding",
        data: { actorId: "actor-scout", actorName: "Scout" },
      },
    ];
    try {
      let running = true;
      const controller = createPrimeBoardExtension({
        home: project.home,
        env: {
          PRIME_BOARD_ROOT: project.runtimeRoot,
          PRIME_BOARD_API_KEY: "pb_builder",
        },
        runtimeDependencies: {
          runStatus: () => ({
            status: running ? 0 : 1,
            stdout: `running project=${project.root} port=3428 pid=3428 db=/tmp/3428.db`,
            stderr: "",
          }),
          fetch: async (input, init) =>
            String(input).endsWith("/health")
              ? new Response("ok")
              : new Response(
                  JSON.stringify({
                    data: { viewer: { id: "actor-builder", name: "Builder", type: "AGENT" } },
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
          sleep: async () => undefined,
        },
      });
      const fakePi = {
        on(name: string, handler: (event: { reason?: string }, ctx: FakeContext) => unknown) {
          events.set(name, handler);
        },
        setSessionName(name: string) {
          names.push(name);
        },
        appendEntry() {},
        registerCommand() {},
        registerTool() {},
      };
      controller(fakePi);
      await events.get("session_start")!(
        { reason: "resume" },
        {
          cwd: project.root,
          sessionManager: { getEntries: () => entries },
          ui: { notify: (message: string) => notifications.push(message) },
        },
      );
      expect(names).toEqual([]);
      expect(notifications.some((message) => message.includes("bound to Actor actor-scout"))).toBe(
        true,
      );
    } finally {
      rmSync(project.home, { recursive: true, force: true });
    }
  });

  it("creates a project Actor AGENT without persisting the bootstrap human key", async () => {
    const project = gitProject();
    try {
      let running = false;
      const events = new Map<string, (event: { reason?: string }, ctx: FakeContext) => unknown>();
      const requests: string[] = [];
      const fetch: FetchLike = async (input, init) => {
        const inputUrl = String(input);
        if (inputUrl.endsWith("/health")) return new Response("ok", { status: 200 });
        const key = new Headers(init?.headers).get("authorization") ?? "";
        requests.push(key);
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        if (body.query?.includes("viewer")) {
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  id: key.includes("pb_agent") ? "agent-1" : "human-1",
                  name: key.includes("pb_agent") ? "Builder" : "admin",
                  type: key.includes("pb_agent") ? "AGENT" : "HUMAN",
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (body.query?.includes("actors(type: AGENT)")) {
          return new Response(
            JSON.stringify({ data: { actors: [], teams: [{ id: "team-1", memberships: [] }] } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (body.query?.includes("actorCreate")) {
          return new Response(
            JSON.stringify({ data: { actorCreate: { actor: { id: "agent-1", type: "AGENT" } } } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (body.query?.includes("teamMembershipCreate")) {
          return new Response(
            JSON.stringify({ data: { teamMembershipCreate: { success: true } } }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (body.query?.includes("apiKeyCreate")) {
          return new Response(JSON.stringify({ data: { apiKeyCreate: { key: "pb_agent" } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      saveProjectCredential(project.root, { apiKey: "pb_admin" }, project.home);
      const extension = createPrimeBoardExtension({
        home: project.home,
        env: { PRIME_BOARD_ROOT: project.runtimeRoot },
        runtimeDependencies: {
          runStatus: () => ({
            status: running ? 0 : 1,
            stdout: running
              ? `running project=${project.root} port=3403 pid=3403 db=/tmp/c.db`
              : `not-running project=${project.root} db=/tmp/c.db`,
            stderr: "",
          }),
          launch: () => {
            running = true;
            return { pid: 3403, unref() {} };
          },
          fetch,
          sleep: async () => undefined,
        },
      });
      const fakePi = {
        on(name: string, handler: (event: { reason?: string }, ctx: FakeContext) => unknown) {
          events.set(name, handler);
        },
        setSessionName() {},
        appendEntry() {},
        registerCommand() {},
        registerTool() {},
      };
      extension(fakePi);
      const context = {
        cwd: project.root,
        sessionManager: { getEntries: () => [] },
        ui: { notify: () => undefined },
      };
      await events.get("session_start")!({ reason: "startup" }, context);
      expect(readProjectCredential(project.root, project.home)).toMatchObject({
        apiKey: "pb_agent",
      });
      expect(readProjectCredential(project.root, project.home)?.apiKey).not.toBe("pb_admin");
      expect(requests).toContain("Bearer pb_admin");
      expect(requests).toContain("Bearer pb_agent");
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
      writeFileSync(
        logPath,
        "Admin API key (save it now): pb_secret\nAPI_KEY=supersecret\nAuthorization: Bearer realtoken\nhealthy\n",
      );
      chmodSync(logPath, 0o600);
      expect(runtime.logs(project.root)).toContain("[redacted-api-key]");
      expect(runtime.logs(project.root)).not.toContain("pb_secret");
      expect(runtime.logs(project.root)).not.toContain("supersecret");
      expect(runtime.logs(project.root)).not.toContain("realtoken");
      expect(runtime.logs(project.root)).toContain("[redacted-bearer]");
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

  it("rejects credential directory symlinks when saving or reading", () => {
    const home = join(tmpdir(), `prime-board-agent-symlink-${crypto.randomUUID()}`);
    const projectRoot = join(home, "project");
    const redirectedDirectory = join(projectRoot, ".prime-board");
    mkdirSync(projectRoot, { recursive: true });
    symlinkSync(redirectedDirectory, join(home, ".prime-board"));
    try {
      expect(() => saveProjectCredential(projectRoot, { apiKey: "pb_secret" }, home)).toThrow(
        "cannot contain a symlink",
      );
      expect(() => readProjectCredential(projectRoot, home)).toThrow("cannot contain a symlink");
      expect(existsSync(join(redirectedDirectory, "credentials"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked credential file when saving or reading", () => {
    const home = join(tmpdir(), `prime-board-agent-file-symlink-${crypto.randomUUID()}`);
    const projectRoot = join(home, "project");
    const credentialsDirectory = join(home, ".prime-board", "credentials");
    const target = join(projectRoot, "redirected-credential.json");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(credentialsDirectory, { recursive: true });
    writeFileSync(target, '{"apiKey":"redirected"}\n');
    const credentialPath = projectCredentialPath(projectRoot, home);
    symlinkSync(target, credentialPath);
    try {
      expect(() => saveProjectCredential(projectRoot, { apiKey: "pb_secret" }, home)).toThrow(
        "cannot contain a symlink",
      );
      expect(() => readProjectCredential(projectRoot, home)).toThrow("cannot contain a symlink");
      expect(() => readProjectCredential(projectRoot, home)).toThrow(credentialPath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps runtime identities, ports, logs, and credentials isolated across two projects", async () => {
    const alpha = gitProject();
    const beta = gitProject();
    try {
      const running = new Set<string>();
      const launches: string[] = [];
      const runtime = createRuntimeController(
        {
          runStatus: (args) => {
            const root = args[args.indexOf("--project") + 1]!;
            const port = root === alpha.root ? 3411 : 3412;
            return {
              status: running.has(root) ? 0 : 1,
              stdout: running.has(root)
                ? `running project=${root} port=${port} pid=${port} db=/tmp/${port}.db`
                : `not-running project=${root} db=/tmp/${port}.db`,
              stderr: "",
            };
          },
          launch: (args) => {
            const root = args[args.indexOf("--project") + 1]!;
            launches.push(root);
            running.add(root);
            return { pid: root === alpha.root ? 3411 : 3412, unref() {} };
          },
          fetch: async (input) => new Response(String(input).includes("3411") ? "ok" : "ok"),
          sleep: async () => undefined,
        },
        { PRIME_BOARD_ROOT: alpha.runtimeRoot },
        alpha.home,
      );
      const [alphaStatus, betaStatus] = await Promise.all([
        runtime.ensure(alpha.root),
        runtime.ensure(beta.root),
      ]);
      expect(launches).toEqual([alpha.root, beta.root]);
      expect(alphaStatus.url).toBe("http://127.0.0.1:3411");
      expect(betaStatus.url).toBe("http://127.0.0.1:3412");
      expect(projectCredentialPath(alpha.root, alpha.home)).not.toBe(
        projectCredentialPath(beta.root, beta.home),
      );
      expect(projectLogPath(alpha.root, alpha.home)).not.toBe(projectLogPath(beta.root, beta.home));
      saveProjectCredential(alpha.root, { apiKey: "pb_alpha" }, alpha.home);
      saveProjectCredential(beta.root, { apiKey: "pb_beta" }, beta.home);
      expect(readProjectCredential(alpha.root, alpha.home)?.apiKey).toBe("pb_alpha");
      expect(readProjectCredential(beta.root, beta.home)?.apiKey).toBe("pb_beta");
    } finally {
      rmSync(alpha.home, { recursive: true, force: true });
      rmSync(beta.home, { recursive: true, force: true });
    }
  });

  it("reports a non-Git directory as unavailable even when the URL is healthy", async () => {
    const path = join(tmpdir(), `not-a-git-${crypto.randomUUID()}`);
    mkdirSync(path, { recursive: true });
    try {
      const status = await getPrimeBoardStatus(path, "http://127.0.0.1:3999");
      expect(status).toMatchObject({ projectRoot: null, state: "unavailable" });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
