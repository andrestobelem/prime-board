// Tests de AT-158: cada escritura queda replicada en el repo al instante.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";
import { createRepoSync } from "./repo-sync.ts";
import { readEventLog } from "./event-log.ts";

let app: TestApp;
let repoDir: string;

const logFor = (identifier: string) =>
  readFileSync(join(repoDir, ".prime-board", "log", `${identifier}.jsonl`), "utf8")
    .trim()
    .split("\n");

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "pb-reposync-"));
  app = createTestApp(repoDir);
});
afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  app.stop();
});

describe("repo sync en cada escritura", () => {
  it("serializa mutaciones GraphQL concurrentes a través de RepoSync", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pb-reposync-concurrent-"));
    const barrierDir = join(rootDir, "barrier");
    const workerPath = join(rootDir, "graphql-worker.ts");
    const cleanGitEnvironment = () => {
      const environment = { ...process.env };
      for (const key of [
        "GIT_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_WORK_TREE",
      ]) {
        delete environment[key];
      }
      return environment;
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: cleanGitEnvironment() });
    const workerSource = `import { createTestApp, gql } from ${JSON.stringify(join(import.meta.dir, "../test-helpers.ts"))};
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [rootDir, barrierDir, eventId] = process.argv.slice(2);
const app = createTestApp(rootDir);
const query = 'mutation($title: String!) { issueCreate(input: { teamKey: "PB", title: $title }) { success } }';
writeFileSync(join(barrierDir, eventId + ".ready"), "ready");
while (!existsSync(join(barrierDir, "start"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
try {
  const result = await gql(app, query, { title: eventId });
  if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
  console.log("ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  app.stop();
}`;
    const runWorker = (eventId: string) =>
      new Promise<{ code: number | null; output: string }>((resolveWorker) => {
        const child = spawn(process.execPath, [workerPath, rootDir, barrierDir, eventId], {
          cwd: rootDir,
          env: cleanGitEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += String(chunk)));
        child.stderr.on("data", (chunk) => (output += String(chunk)));
        child.on("close", (code) => resolveWorker({ code, output }));
      });

    try {
      git("init", "-q");
      git("config", "user.email", "test@example.test");
      git("config", "user.name", "PRB test");
      mkdirSync(barrierDir, { recursive: true });
      writeFileSync(workerPath, workerSource);

      const eventIds = Array.from({ length: 8 }, (_, index) => `graphql-${index}`);
      const workers = eventIds.map(runWorker);
      let ready = false;
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        ready = eventIds.every((eventId) => existsSync(join(barrierDir, eventId + ".ready")));
        if (ready) break;
        await new Promise((resolveReady) => setTimeout(resolveReady, 5));
      }
      expect(ready).toBe(true);
      writeFileSync(join(barrierDir, "start"), "go");
      const results = await Promise.all(workers);
      expect(results).toEqual(eventIds.map(() => ({ code: 0, output: "ok\n" })));
      const events = readEventLog({ rootDir });
      expect(events).toHaveLength(eventIds.length);
      expect(events.every((event) => event.type === "created")).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("configura el merge driver union para los logs", () => {
    const attributes = readFileSync(join(repoDir, ".gitattributes"), "utf8");
    expect(attributes).toContain(".prime-board/log/*.jsonl merge=union");
  });

  it("crear un issue lo deja en el repo sin exportar a mano", async () => {
    const result = await gql(
      app,
      `
      mutation { issueCreate(input: { teamKey: "PB", title: "Va al repo" }) { issue { identifier } } }
    `,
    );
    expect(result.errors).toBeUndefined();
    expect(existsSync(join(repoDir, ".prime-board", "issues", "PB-1.md"))).toBe(true);
    // El primer sync inicializa una réplica reconstruible con identidad y scope.
    const workspace = app.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
    expect(
      JSON.parse(readFileSync(join(repoDir, ".prime-board", "meta", "export.json"), "utf8")),
    ).toMatchObject({ version: 1, workspaceId: workspace.id, scope: "workspace" });
    const events = logFor("PB-1").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "created", issue: "PB-1" });
    expect(events[0].payload.title).toBe("Va al repo");
  });

  it("cada mutación agrega su evento al log", async () => {
    const team = await gql(app, `{ team(key: "PB") { states { id type } } }`);
    const started = team.data!.team.states.find((s: any) => s.type === "STARTED").id;
    await gql(
      app,
      `mutation($s: ID!) { issueUpdate(id: "PB-1", input: { stateId: $s, priority: 1 }) { success } }`,
      { s: started },
    );
    await gql(
      app,
      `mutation { commentCreate(input: { issueId: "PB-1", body: "listo" }) { success } }`,
    );

    const types = logFor("PB-1").map((line) => JSON.parse(line).type);
    expect(types).toEqual(["created", "state_changed", "priority_changed", "commented"]);

    const snapshot = readFileSync(join(repoDir, ".prime-board", "issues", "PB-1.md"), "utf8");
    expect(snapshot).toContain("state: In Progress");
    // El comentario vive en el log, no duplicado en el snapshot.
    expect(logFor("PB-1").at(-1)).toContain('"body":"listo"');
  });

  it("conecta create/update/archive/unarchive/comment/relation/subscribe al log canónico", async () => {
    const target = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Canonical target" }) { issue { id } } }`,
    );
    const targetId = target.data!.issueCreate.issue.id as string;
    const state = await gql(app, `{ team(key: "PB") { states { id type } } }`);
    const started = state.data!.team.states.find(
      (item: { type: string }) => item.type === "STARTED",
    ).id;
    await gql(
      app,
      `mutation($id: ID!, $state: ID!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`,
      { id: targetId, state: started },
    );
    await gql(
      app,
      `mutation($id: ID!) { commentCreate(input: { issueId: $id, body: "canonical comment" }) { success } }`,
      { id: targetId },
    );
    await gql(app, `mutation($id: ID!) { issueSubscribe(id: $id) { success } }`, { id: targetId });
    await gql(app, `mutation($id: ID!) { issueUnsubscribe(id: $id) { success } }`, {
      id: targetId,
    });
    const relation = await gql(
      app,
      `mutation($issue: ID!, $related: ID!) {
        issueRelationCreate(input: { issueId: $issue, relatedIssueId: $related, type: RELATED }) {
          relation { id }
        }
      }`,
      { issue: targetId, related: "PB-1" },
    );
    expect(relation.errors).toBeUndefined();
    await gql(app, `mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`, {
      id: relation.data!.issueRelationCreate.relation.id,
    });
    await gql(app, `mutation($id: ID!) { issueArchive(id: $id) { success } }`, { id: targetId });
    await gql(app, `mutation($id: ID!) { issueUnarchive(id: $id) { success } }`, { id: targetId });

    const events = readEventLog({ rootDir: repoDir }).filter(
      (current) => current.aggregateKey === "PB-2",
    );
    expect(events.map((current) => current.type)).toEqual([
      "created",
      "state_changed",
      "commented",
      "subscribed",
      "unsubscribed",
      "relation_added",
      "relation_removed",
      "archived",
      "unarchived",
    ]);
    const adminActor = app.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as {
      id: string;
    };
    for (const current of events) {
      expect(current.schemaVersion).toBe(1);
      expect(current.eventId).toBeTruthy();
      expect(current.actor).toBe(adminActor.id);
      expect(current.payload).toBeTruthy();
    }
  });

  it("propaga un fallo del pipeline en vez de reportar éxito", () => {
    const failingRoot = mkdtempSync(join(tmpdir(), "pb-reposync-failure-"));
    try {
      const repo = createRepoSync(app.db, failingRoot, {
        commitGit: () => {
          throw new Error("git unavailable");
        },
      });
      expect(repo).not.toBeNull();
      expect(() => repo!.sync()).toThrow("git unavailable");
    } finally {
      rmSync(failingRoot, { recursive: true, force: true });
    }
  });

  it("propaga el fallo de sync hasta GraphQL sin informar éxito", async () => {
    const failing = createTestApp(
      undefined,
      "api-key",
      {},
      {
        root: "injected-repo",
        sync() {
          throw new Error("git unavailable");
        },
        syncIssue() {
          throw new Error("git unavailable");
        },
      },
    );
    try {
      const result = await gql(
        failing,
        `mutation { issueCreate(input: { teamKey: "PB", title: "must fail" }) { success } }`,
      );
      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.data).toBeNull();
    } finally {
      failing.stop();
    }
  });

  it("reescanea Activity de forma idempotente tras renombrar el Actor", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-actor-"));
    const isolated = createTestApp(isolatedRoot);
    try {
      const created = await gql(
        isolated,
        `mutation { issueCreate(input: { teamKey: "PB", title: "Stable author" }) { success } }`,
      );
      expect(created.errors).toBeUndefined();
      const actor = isolated.db.query("SELECT id FROM actors WHERE name = 'admin'").get() as {
        id: string;
      };
      const renamed = await gql(
        isolated,
        `mutation($id: ID!) { actorUpdate(id: $id, input: { name: "renamed-admin" }) { success } }`,
        { id: actor.id },
      );
      expect(renamed.errors).toBeUndefined();
      expect(readEventLog({ rootDir: isolatedRoot })).toHaveLength(1);
      expect(readEventLog({ rootDir: isolatedRoot })[0]?.actor).toBe(actor.id);

      const comment = await gql(
        isolated,
        `mutation { commentCreate(input: { issueId: "PB-1", body: "still works" }) { success } }`,
      );
      expect(comment.errors).toBeUndefined();
    } finally {
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("mantiene operativas las mutaciones tras leer un evento histórico sin scope", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-legacy-scope-"));
    const isolated = createTestApp(isolatedRoot);
    try {
      const created = await gql(
        isolated,
        `mutation { issueCreate(input: { teamKey: "PB", title: "Legacy scope" }) { success } }`,
      );
      expect(created.errors).toBeUndefined();

      const logPath = join(isolatedRoot, ".prime-board", "log", "events.jsonl");
      const legacyLines = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const event = JSON.parse(line) as Record<string, unknown>;
          delete event.workspaceId;
          return JSON.stringify(event);
        });
      writeFileSync(logPath, `${legacyLines.join("\n")}\n`);

      const comment = await gql(
        isolated,
        `mutation { commentCreate(input: { issueId: "PB-1", body: "scope migration works" }) { success } }`,
      );
      expect(comment.errors).toBeUndefined();
      const events = readEventLog({ rootDir: isolatedRoot });
      expect(events).toHaveLength(2);
      expect(events[0]?.workspaceId).toBeUndefined();
      expect(events[1]?.workspaceId).toBe(
        (isolated.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string }).id,
      );
    } finally {
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("los cambios de metadata también se replican", async () => {
    await gql(app, `mutation { teamCreate(input: { name: "Otro", key: "OT" }) { success } }`);
    const teams = JSON.parse(
      readFileSync(join(repoDir, ".prime-board", "meta", "teams.json"), "utf8"),
    );
    expect(teams.map((t: any) => t.key).sort()).toEqual(["OT", "PB"]);
  });

  it("sin PRIME_BOARD_REPO no escribe nada (comportamiento por defecto)", async () => {
    const plain = createTestApp();
    try {
      const result = await gql(
        plain,
        `mutation { issueCreate(input: { teamKey: "PB", title: "x" }) { success } }`,
      );
      expect(result.errors).toBeUndefined();
    } finally {
      plain.stop();
    }
  });

  it("una mutación toca solo los archivos de su issue (AT-166)", async () => {
    // Segundo issue para tener con qué comparar.
    await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Otro issue" }) { success } }`,
    );
    const base = join(repoDir, ".prime-board");
    const mtimes = () =>
      Object.fromEntries(
        readdirSync(join(base, "issues")).map((f) => [
          f,
          statSync(join(base, "issues", f)).mtimeMs,
        ]),
      );
    const logMtime = () => statSync(join(base, "log", "PB-1.jsonl")).mtimeMs;
    const before = mtimes();
    const beforeLog = logMtime();
    await new Promise((resolve) => setTimeout(resolve, 12));

    await gql(
      app,
      `mutation { commentCreate(input: { issueId: "PB-1", body: "solo PB-1" }) { success } }`,
    );

    // El evento va al log de PB-1...
    expect(logMtime()).not.toBe(beforeLog);
    // El comentario vive en el log, pero también mueve updatedAt del snapshot
    // para que el sync incremental pueda detectar el issue modificado.
    const after = mtimes();
    expect(after["PB-1.md"]).not.toBe(before["PB-1.md"]);
    expect(after["PB-2.md"]).toBe(before["PB-2.md"]);
  });

  it("no reescribe archivos cuyo contenido no cambió", async () => {
    const base = join(repoDir, ".prime-board");
    const teamsFile = join(base, "meta", "teams.json");
    const before = statSync(teamsFile).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 12));
    // Un sync completo con metadata idéntica no debe tocar el archivo.
    await gql(app, `mutation { projectCreate(input: { name: "Proyecto nuevo" }) { success } }`);
    expect(statSync(teamsFile).mtimeMs).toBe(before);
  });
});
