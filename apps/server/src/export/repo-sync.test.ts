// Tests de AT-158: cada escritura queda replicada en el repo al instante.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";
import { createRepoSync } from "./repo-sync.ts";
import { prepareRetiredDocuments } from "./exporter.ts";
import { archiveDocumentRows } from "./documents-archive.ts";
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
        preflight() {},
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
      // A sync failure must not leave the successful resolver write behind.
      expect(
        (failing.db.query("SELECT count(*) AS count FROM issues").get() as { count: number }).count,
      ).toBe(0);
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

  it("no omite una captura retirada al sincronizar un Issue", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-retired-documents-"));
    const isolated = createTestApp(isolatedRoot);
    try {
      const repo = createRepoSync(isolated.db, isolatedRoot);
      expect(repo).not.toBeNull();
      repo!.sync();
      const documentsPath = join(isolatedRoot, ".prime-board", "meta", "documents.json");
      writeFileSync(documentsPath, '[{"title":"retired","content":"must remain external"}]\n');
      expect(() => repo!.syncIssue("PB-1")).toThrow(/documents.json/);
      expect(existsSync(documentsPath)).toBe(true);
    } finally {
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("syncIssue() directo verifica Documents antes de anexar y conserva la captura", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-direct-documents-"));
    const archivePath = join(isolatedRoot, "backup", "documents.archive.json");
    const isolated = createTestApp(isolatedRoot);
    try {
      const repo = createRepoSync(isolated.db, isolatedRoot, {
        documentsArchivePath: archivePath,
      });
      expect(repo).not.toBeNull();
      repo!.sync();
      const documentsPath = join(isolatedRoot, ".prime-board", "meta", "documents.json");
      const current = [{ id: "current", title: "current" }];
      writeFileSync(documentsPath, `${JSON.stringify(current)}\n`);
      archiveDocumentRows([{ id: "different", title: "different" }], archivePath, "replica");
      const eventCountBefore = readEventLog({ rootDir: isolatedRoot }).length;

      expect(() => repo!.syncIssue("missing-issue")).toThrow(/does not match/);
      expect(() => repo!.sync()).toThrow(/does not match/);
      expect(readEventLog({ rootDir: isolatedRoot })).toHaveLength(eventCountBefore);
      expect(readFileSync(documentsPath, "utf8")).toBe(`${JSON.stringify(current)}\n`);
    } finally {
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("no archiva SQLite parcialmente si la captura replica diverge", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-documents-preflight-"));
    const isolated = createTestApp(isolatedRoot);
    try {
      const archivePath = join(isolatedRoot, "backup", "documents.archive.json");
      const documentsPath = join(isolatedRoot, ".prime-board", "meta", "documents.json");
      const repo = createRepoSync(isolated.db, isolatedRoot, {
        documentsArchivePath: archivePath,
      });
      expect(repo).not.toBeNull();
      repo!.sync();
      isolated.db.exec(`
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL
        );
        INSERT INTO documents (id, title, content)
        VALUES ('sqlite-document', 'SQLite', 'private');
      `);
      const current = [{ id: "replica-document", title: "replica" }];
      const different = [{ id: "different-document", title: "different" }];
      writeFileSync(
        documentsPath,
        `${JSON.stringify(current)}
`,
      );
      archiveDocumentRows(different, archivePath, "replica");
      const eventCountBefore = readEventLog({ rootDir: isolatedRoot }).length;

      expect(() => repo!.syncIssue("PB-1")).toThrow(/does not match/);
      const archive = JSON.parse(readFileSync(archivePath, "utf8")) as {
        sources: Record<string, unknown>;
      };
      expect(archive.sources.sqlite).toBeUndefined();
      expect(readEventLog({ rootDir: isolatedRoot })).toHaveLength(eventCountBefore);
      expect(readFileSync(documentsPath, "utf8")).toBe(`${JSON.stringify(current)}
`);
    } finally {
      isolated.db.exec("DROP TABLE IF EXISTS documents");
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("no retira una captura reemplazada entre preflight y complete", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-documents-toctou-"));
    const isolated = createTestApp(isolatedRoot);
    try {
      const documentsPath = join(isolatedRoot, ".prime-board", "meta", "documents.json");
      const archivePath = join(isolatedRoot, "backup", "documents.archive.json");
      const capture = [{ id: "retired", title: "keep me" }];
      const replacement = [{ id: "replacement", title: "writer owns this" }];
      mkdirSync(join(isolatedRoot, ".prime-board", "meta"), { recursive: true });
      writeFileSync(documentsPath, `${JSON.stringify(capture)}\n`);
      archiveDocumentRows(capture, archivePath, "replica");
      const reservation = prepareRetiredDocuments(isolated.db, isolatedRoot, archivePath, {
        beforeRetire: () => {
          renameSync(documentsPath, `${documentsPath}.original`);
          writeFileSync(documentsPath, `${JSON.stringify(replacement)}\n`);
        },
      });

      expect(() => reservation.retire()).toThrow(/changed before retirement/);
      expect(readFileSync(documentsPath, "utf8")).toBe(`${JSON.stringify(replacement)}\n`);
      expect(readFileSync(`${documentsPath}.original`, "utf8")).toBe(
        `${JSON.stringify(capture)}\n`,
      );
      reservation.release();
    } finally {
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("retira una captura consistente solo después de un sync exitoso", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-success-documents-"));
    const archivePath = join(isolatedRoot, "backup", "documents.archive.json");
    const previousArchive = process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
    process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE = archivePath;
    const isolated = createTestApp(isolatedRoot);
    try {
      const created = await gql(
        isolated,
        'mutation { issueCreate(input: { teamKey: "PB", title: "Retire after success" }) { success } }',
      );
      expect(created.errors).toBeUndefined();
      const documentsPath = join(isolatedRoot, ".prime-board", "meta", "documents.json");
      const capture = [{ id: "retired", title: "retire me" }];
      writeFileSync(documentsPath, `${JSON.stringify(capture)}\n`);
      archiveDocumentRows(capture, archivePath, "replica");

      const result = await gql(
        isolated,
        'mutation { issueUpdate(id: "PB-1", input: { title: "updated after capture" }) { success } }',
      );
      expect(result.errors).toBeUndefined();
      expect(existsSync(documentsPath)).toBe(false);
      expect(readEventLog({ rootDir: isolatedRoot }).length).toBeGreaterThan(1);
    } finally {
      if (previousArchive === undefined) delete process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
      else process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE = previousArchive;
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("conserva una captura consistente cuando el resolver devuelve NOT_FOUND o UNAUTHORIZED", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-resolver-documents-"));
    const archivePath = join(isolatedRoot, "backup", "documents.archive.json");
    const previousArchive = process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
    process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE = archivePath;
    const isolated = createTestApp(isolatedRoot);
    try {
      const created = await gql(
        isolated,
        'mutation { issueCreate(input: { teamKey: "PB", title: "Protected issue" }) { success } }',
      );
      expect(created.errors).toBeUndefined();
      const outsider = await gql(
        isolated,
        'mutation { actorCreate(input: { name: "documents-outsider", type: HUMAN }) { actor { id } } }',
      );
      expect(outsider.errors).toBeUndefined();
      const outsiderId = outsider.data!.actorCreate.actor.id as string;
      const key = await gql(
        isolated,
        `mutation($id: ID!) { apiKeyCreate(input: { actorId: $id, name: "documents-outsider-key" }) { key } }`,
        { id: outsiderId },
      );
      expect(key.errors).toBeUndefined();

      const documentsPath = join(isolatedRoot, ".prime-board", "meta", "documents.json");
      const capture = [{ id: "retired", title: "keep me" }];
      writeFileSync(documentsPath, `${JSON.stringify(capture)}\n`);
      archiveDocumentRows(capture, archivePath, "replica");
      const before = readFileSync(documentsPath, "utf8");
      const eventCountBefore = readEventLog({ rootDir: isolatedRoot }).length;

      const missing = await gql(
        isolated,
        'mutation { issueUpdate(id: "PB-404", input: { title: "must not persist" }) { success } }',
      );
      expect(missing.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
      expect(readFileSync(documentsPath, "utf8")).toBe(before);
      expect(readEventLog({ rootDir: isolatedRoot })).toHaveLength(eventCountBefore);

      const denied = await gql(
        isolated,
        'mutation { issueUpdate(id: "PB-1", input: { title: "must not persist" }) { success } }',
        {},
        key.data!.apiKeyCreate.key as string,
      );
      expect(denied.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
      expect(readFileSync(documentsPath, "utf8")).toBe(before);
      expect(readEventLog({ rootDir: isolatedRoot })).toHaveLength(eventCountBefore);
    } finally {
      if (previousArchive === undefined) delete process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
      else process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE = previousArchive;
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("mantiene el lock desde preflight hasta abort y rechaza otra reserva concurrente", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-lease-lock-"));
    const isolated = createTestApp(isolatedRoot);
    try {
      execFileSync("git", ["-C", isolatedRoot, "init", "-q"]);
      const repo = createRepoSync(isolated.db, isolatedRoot);
      expect(repo).not.toBeNull();
      const lease = repo!.preflight();
      expect(lease).toBeDefined();
      const indexPath = execFileSync(
        "git",
        ["-C", isolatedRoot, "rev-parse", "--git-path", "index"],
        {
          encoding: "utf8",
        },
      ).trim();
      const lockPath = join(isolatedRoot, indexPath) + ".prime-board-event-log.lock";
      expect(existsSync(lockPath)).toBe(true);
      expect(() => repo!.preflight()).toThrow(/already holds the lock/);
      lease!.abort();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("expone un preflight async que no bloquea el event loop mientras espera el lease", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-lease-async-"));
    const isolated = createTestApp(isolatedRoot);
    try {
      const repo = createRepoSync(isolated.db, isolatedRoot);
      expect(repo).not.toBeNull();
      const first = repo!.preflight();
      expect(first).toBeDefined();
      const asyncRepo = repo! as { preflightAsync(): Promise<{ abort(): void }> };
      expect(typeof asyncRepo.preflightAsync).toBe("function");
      let timerRan = false;
      const waiting = asyncRepo.preflightAsync();
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          timerRan = true;
          resolve();
        }, 0);
      });
      expect(timerRan).toBe(true);
      first!.abort();
      const second = await waiting;
      if (!second) throw new Error("expected second lease");
      second.abort();
    } finally {
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("no modifica el archivo externo cuando el preflight encuentra una divergencia", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-preflight-archive-"));
    const archivePath = join(isolatedRoot, "backup", "documents.archive.json");
    const isolated = createTestApp(isolatedRoot);
    try {
      const repo = createRepoSync(isolated.db, isolatedRoot, { documentsArchivePath: archivePath });
      expect(repo).not.toBeNull();
      repo!.sync();
      isolated.db.exec(`
        CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL);
        INSERT INTO documents (id, title, content) VALUES ('sqlite-row', 'SQLite', 'keep');
      `);
      const snapshotPath = join(isolatedRoot, ".prime-board", "meta", "documents.json");
      writeFileSync(snapshotPath, "[]\n");
      archiveDocumentRows(
        Array.from({ length: 5 }, (_, index) => ({ id: `archive-${index}` })),
        archivePath,
        "replica",
      );
      const beforeArchive = readFileSync(archivePath, "utf8");
      expect(() => repo!.preflight()).toThrow(/does not match/);
      expect(readFileSync(archivePath, "utf8")).toBe(beforeArchive);
    } finally {
      isolated.db.exec("DROP TABLE IF EXISTS documents");
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("actualiza Issues y agrega Comments con código 0 cuando Documents es consistente", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-consistent-documents-"));
    const archivePath = join(isolatedRoot, "backup", "documents.archive.json");
    const previousArchive = process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
    process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE = archivePath;
    const isolated = createTestApp(isolatedRoot);
    try {
      const created = await gql(
        isolated,
        'mutation { issueCreate(input: { teamKey: "PB", title: "Consistent Documents" }) { success } }',
      );
      expect(created.errors).toBeUndefined();
      const documentsPath = join(isolatedRoot, ".prime-board", "meta", "documents.json");
      writeFileSync(documentsPath, "[]\n");
      archiveDocumentRows([], archivePath, "replica");

      const updated = await gql(
        isolated,
        'mutation { issueUpdate(id: "PB-1", input: { title: "Updated safely" }) { success issue { title } } }',
      );
      expect(updated.errors).toBeUndefined();
      expect(updated.data?.issueUpdate.success).toBe(true);
      const commented = await gql(
        isolated,
        'mutation { commentCreate(input: { issueId: "PB-1", body: "Comment safely" }) { success } }',
      );
      expect(commented.errors).toBeUndefined();
      expect(commented.data?.commentCreate.success).toBe(true);
      expect(existsSync(documentsPath)).toBe(false);
      expect(
        (isolated.db.query("SELECT title FROM issues WHERE number = 1").get() as { title: string })
          .title,
      ).toBe("Updated safely");
    } finally {
      if (previousArchive === undefined) delete process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
      else process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE = previousArchive;
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("rechaza una mutación antes de persistir ante una captura vacía divergente", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "pb-reposync-divergent-documents-"));
    const archivePath = join(isolatedRoot, "backup", "documents.archive.json");
    const isolated = createTestApp(isolatedRoot);
    const previousArchive = process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
    process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE = archivePath;
    try {
      const created = await gql(
        isolated,
        'mutation { issueCreate(input: { teamKey: "PB", title: "Before divergence" }) { success } }',
      );
      expect(created.errors).toBeUndefined();
      const repo = createRepoSync(isolated.db, isolatedRoot);
      expect(repo).not.toBeNull();
      repo!.sync();
      const documentsPath = join(isolatedRoot, ".prime-board", "meta", "documents.json");
      writeFileSync(documentsPath, "[]\n");
      archiveDocumentRows(
        Array.from({ length: 5 }, (_, index) => ({ id: `document-${index}` })),
        archivePath,
        "replica",
      );
      const before = isolated.db
        .query("SELECT title, updated_at FROM issues WHERE number = 1")
        .get() as { title: string; updated_at: string };
      const commentsBefore = (
        isolated.db.query("SELECT count(*) AS count FROM comments").get() as { count: number }
      ).count;
      const lastUsedBefore = (
        isolated.db
          .query("SELECT last_used_at FROM api_keys ORDER BY created_at, id LIMIT 1")
          .get() as {
          last_used_at: string | null;
        }
      ).last_used_at;
      const eventCountBefore = readEventLog({ rootDir: isolatedRoot }).length;
      const commentResult = await gql(
        isolated,
        'mutation { commentCreate(input: { issueId: "PB-1", body: "Must not persist" }) { success } }',
      );
      expect(commentResult.errors?.[0]?.message).toMatch(/does not match/);
      expect(commentResult.data).toBeNull();
      expect(
        (isolated.db.query("SELECT count(*) AS count FROM comments").get() as { count: number })
          .count,
      ).toBe(commentsBefore);
      expect(readEventLog({ rootDir: isolatedRoot })).toHaveLength(eventCountBefore);
      expect(
        (
          isolated.db
            .query("SELECT last_used_at FROM api_keys ORDER BY created_at, id LIMIT 1")
            .get() as {
            last_used_at: string | null;
          }
        ).last_used_at,
      ).toBe(lastUsedBefore);
      const result = await gql(
        isolated,
        'mutation { issueUpdate(id: "PB-1", input: { title: "Must not persist" }) { success } }',
      );
      expect(result.errors?.[0]?.message).toMatch(/does not match/);
      expect(result.data).toBeNull();
      expect(
        isolated.db.query("SELECT title, updated_at FROM issues WHERE number = 1").get(),
      ).toEqual(before);
      expect(readEventLog({ rootDir: isolatedRoot })).toHaveLength(eventCountBefore);
      expect(existsSync(documentsPath)).toBe(true);
    } finally {
      if (previousArchive === undefined) delete process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE;
      else process.env.PRIME_BOARD_DOCUMENTS_ARCHIVE = previousArchive;
      isolated.stop();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
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
