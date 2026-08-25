import { describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventLogWriter, type DomainEvent } from "./event-log.ts";
import {
  createGitCommitter,
  IssueEventPipeline,
  withCanonicalEventLogLock,
  type CanonicalEventLog,
  type IssueEventCheckpointStore,
} from "./issue-event-pipeline.ts";
import type { ProjectorCheckpoint } from "./projector.ts";

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
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
}

const event = (eventId = "event-1"): DomainEvent => ({
  schemaVersion: 1,
  eventId,
  aggregate: "issue",
  aggregateKey: "PB-1",
  type: "created",
  actor: "admin",
  occurredAt: "2026-08-24T00:00:00.000Z",
  payload: { title: "Canonical issue" },
});

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "prb-issue-events-"));
  const writer = new EventLogWriter({ rootDir });
  const calls: string[] = [];
  const checkpoint: { value: ProjectorCheckpoint | undefined; fail: boolean } = {
    value: undefined,
    fail: false,
  };
  const store: IssueEventCheckpointStore = {
    load: () => checkpoint.value,
    save: (next) => {
      calls.push(`checkpoint:${next.eventId}`);
      if (checkpoint.fail) throw new Error("checkpoint unavailable");
      checkpoint.value = next;
    },
  };
  const eventLog: CanonicalEventLog = {
    appendMany: (events) => {
      calls.push("append");
      return writer.appendMany(events);
    },
    read: () => writer.read(),
  };
  return { rootDir, calls, checkpoint, eventLog, store };
}

describe("SQLite issue event pipeline", () => {
  it("retries an append failure without running later stages", () => {
    const fixtureData = fixture();
    let failAppend = true;
    const calls = fixtureData.calls;
    const eventLog: CanonicalEventLog = {
      appendMany: (events) => {
        calls.push("append");
        if (failAppend) throw new Error("log unavailable");
        return fixtureData.eventLog.appendMany(events);
      },
      read: () => fixtureData.eventLog.read(),
    };
    const pipeline = new IssueEventPipeline({
      rootDir: fixtureData.rootDir,
      eventLog,
      commitGit: () => calls.push("commit"),
      projector: { apply: () => calls.push("project") },
      checkpointStore: fixtureData.store,
    });

    expect(() => pipeline.append([event()])).toThrow("log unavailable");
    expect(calls).toEqual(["append"]);
    expect(pipeline.getCheckpoint()).toBeUndefined();

    failAppend = false;
    pipeline.append([event()]);
    pipeline.commit();
    pipeline.project();
    expect(calls).toEqual([
      "append",
      "append",
      "append",
      "commit",
      "project",
      "checkpoint:event-1",
    ]);
  });

  it("recovers a torn JSONL tail before retrying an append", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-torn-event-log-"));
    const writer = new EventLogWriter({ rootDir });
    try {
      writer.append(event("base"));
      appendFileSync(writer.filePath, '{"schemaVersion":1,"eventId":"torn"');
      const pipeline = new IssueEventPipeline({ rootDir, eventLog: writer });
      expect(pipeline.append([event("torn")])).toEqual([{ eventId: "torn", appended: true }]);
      expect(writer.read().map((current) => current.eventId)).toEqual(["base", "torn"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("commits prior valid appends before the next mutation", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-prior-append-"));
    const writer = new EventLogWriter({ rootDir });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    try {
      git("init", "-q");
      git("config", "user.email", "test@example.test");
      git("config", "user.name", "PRB test");
      writer.append(event("base"));
      git("add", "--", ".prime-board/log/events.jsonl");
      git("commit", "-qm", "base");

      const firstMutation = new IssueEventPipeline({
        rootDir,
        eventLog: writer,
        commitGit: createGitCommitter(rootDir),
      });
      firstMutation.append([event("prior")]);

      const nextMutation = new IssueEventPipeline({
        rootDir,
        eventLog: writer,
        commitGit: createGitCommitter(rootDir),
      });
      nextMutation.append([event("next")]);
      nextMutation.recordPendingEventIds(["prior"]);
      expect(() => nextMutation.commit()).not.toThrow();
      expect(git("show", "HEAD:.prime-board/log/events.jsonl").toString()).toContain(
        '"eventId":"prior"',
      );
      expect(git("show", "HEAD:.prime-board/log/events.jsonl").toString()).toContain(
        '"eventId":"next"',
      );
      expect(git("status", "--porcelain").toString()).toBe("");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent append and commit operations across processes", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-concurrent-writers-"));
    const barrierDir = join(rootDir, "barrier");
    const workerPath = join(rootDir, "writer.ts");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    const workerSource = [
      `import { EventLogWriter } from ${JSON.stringify(join(import.meta.dir, "event-log.ts"))};`,
      `import { IssueEventPipeline, createGitCommitter, withCanonicalEventLogLock } from ${JSON.stringify(join(import.meta.dir, "issue-event-pipeline.ts"))};`,
      `import { existsSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      "const [rootDir, eventId, barrierDir] = process.argv.slice(2);",
      "const event = { schemaVersion: 1, eventId, aggregate: 'issue', aggregateKey: 'PB-1', type: 'created', actor: 'admin', occurredAt: new Date().toISOString(), payload: { title: eventId } };",
      "writeFileSync(join(barrierDir, eventId + '.ready'), 'ready');",
      "while (!existsSync(join(barrierDir, 'start'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);",
      "try {",
      "  withCanonicalEventLogLock(rootDir, () => {",
      "    const writer = new EventLogWriter({ rootDir });",
      "    const pipeline = new IssueEventPipeline({ rootDir, eventLog: writer, commitGit: createGitCommitter(rootDir) });",
      "    pipeline.append([event]);",
      "    pipeline.commit();",
      "  });",
      "  console.log('ok');",
      "} catch (error) {",
      "  console.error(error instanceof Error ? error.message : String(error));",
      "  process.exitCode = 1;",
      "}",
    ].join("\n");
    const runWorker = (eventId: string) =>
      new Promise<{ code: number | null; output: string }>((resolveWorker) => {
        const child = spawn(process.execPath, [workerPath, rootDir, eventId, barrierDir], {
          cwd: rootDir,
          env: isolatedGitEnvironment(),
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
      new EventLogWriter({ rootDir }).append(event("base"));
      git("add", "--", ".prime-board/log/events.jsonl");
      git("commit", "-qm", "base");
      mkdirSync(barrierDir, { recursive: true });
      writeFileSync(workerPath, workerSource);

      const workers = [runWorker("concurrent-a"), runWorker("concurrent-b")];
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        ready = ["concurrent-a", "concurrent-b"].every((eventId) =>
          existsSync(join(barrierDir, eventId + ".ready")),
        );
        if (ready) break;
        await new Promise((resolveReady) => setTimeout(resolveReady, 5));
      }
      expect(ready).toBe(true);
      writeFileSync(join(barrierDir, "start"), "go");
      const results = await Promise.all(workers);
      expect(results).toEqual([
        { code: 0, output: "ok\n" },
        { code: 0, output: "ok\n" },
      ]);
      rmSync(barrierDir, { recursive: true, force: true });
      rmSync(workerPath, { force: true });
      expect(git("status", "--porcelain").toString()).toBe("");
      expect(git("show", "HEAD:.prime-board/log/events.jsonl").toString()).toContain(
        '"eventId":"concurrent-a"',
      );
      expect(git("show", "HEAD:.prime-board/log/events.jsonl").toString()).toContain(
        '"eventId":"concurrent-b"',
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes contenders while recovering an orphaned event-log lock", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-stale-lock-race-"));
    const barrierDir = join(rootDir, "barrier");
    const workerPath = join(rootDir, "stale-lock-worker.ts");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    const workerSource = [
      `import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `import { withCanonicalEventLogLock } from ${JSON.stringify(join(import.meta.dir, "issue-event-pipeline.ts"))};`,
      "const [rootDir, barrierDir, eventId] = process.argv.slice(2);",
      "writeFileSync(join(barrierDir, eventId + '.ready'), 'ready');",
      "while (!existsSync(join(barrierDir, 'start'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);",
      "try {",
      "  withCanonicalEventLogLock(rootDir, () => {",
      "    const criticalPath = join(rootDir, 'critical');",
      "    try { mkdirSync(criticalPath); } catch { writeFileSync(join(rootDir, 'overlap'), eventId); }",
      "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);",
      "    rmSync(criticalPath, { recursive: true, force: true });",
      "  });",
      "  console.log('ok');",
      "} catch (error) {",
      "  console.error(error instanceof Error ? error.message : String(error));",
      "  process.exitCode = 1;",
      "}",
    ].join("\n");
    const runWorker = (eventId: string) =>
      new Promise<{ code: number | null; output: string }>((resolveWorker) => {
        const child = spawn(process.execPath, [workerPath, rootDir, barrierDir, eventId], {
          cwd: rootDir,
          env: isolatedGitEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += String(chunk)));
        child.stderr.on("data", (chunk) => (output += String(chunk)));
        child.on("close", (code) => resolveWorker({ code, output }));
      });

    try {
      git("init", "-q");
      mkdirSync(barrierDir, { recursive: true });
      writeFileSync(workerPath, workerSource);
      const indexPath = resolve(rootDir, git("rev-parse", "--git-path", "index").toString().trim());
      const lockPath = `${indexPath}.prime-board-event-log.lock`;
      writeFileSync(lockPath, "pid=999999999\n");

      const workers = [runWorker("stale-a"), runWorker("stale-b")];
      let ready = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        ready = ["stale-a", "stale-b"].every((eventId) =>
          existsSync(join(barrierDir, eventId + ".ready")),
        );
        if (ready) break;
        await new Promise((resolveReady) => setTimeout(resolveReady, 5));
      }
      expect(ready).toBe(true);
      writeFileSync(join(barrierDir, "start"), "go");
      const results = await Promise.all(workers);
      expect(results).toEqual([
        { code: 0, output: "ok\n" },
        { code: 0, output: "ok\n" },
      ]);
      expect(existsSync(join(rootDir, "overlap"))).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("commits uncommitted idempotent events after pipeline recreation", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-retry-"));
    const writer = new EventLogWriter({ rootDir });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    try {
      git("init", "-q");
      git("config", "user.email", "test@example.test");
      git("config", "user.name", "PRB test");
      writer.append(event("base"));
      git("add", "--", ".prime-board/log/events.jsonl");
      git("commit", "-qm", "base");

      const partial = event("partial");
      const next = event("next");
      writer.append(partial);
      const recreated = new IssueEventPipeline({
        rootDir,
        eventLog: writer,
        commitGit: createGitCommitter(rootDir),
      });
      expect(recreated.append([partial, next])).toEqual([
        { eventId: "partial", appended: false },
        { eventId: "next", appended: true },
      ]);
      recreated.commit();

      expect(git("log", "-1", "--format=%s").toString().trim()).toBe(
        "chore(events): append canonical issue events",
      );
      expect(git("status", "--porcelain").toString()).toBe("");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("commits an event log whose base exceeds the child-process buffer", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-large-event-log-"));
    const logPath = join(rootDir, ".prime-board", "log", "events.jsonl");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    const base = `${Array.from({ length: 5_400 }, (_, index) =>
      JSON.stringify(event(`base-${index}`)),
    ).join("\n")}\n`;
    try {
      expect(Buffer.byteLength(base)).toBeGreaterThan(1024 * 1024);
      mkdirSync(join(rootDir, ".prime-board", "log"), { recursive: true });
      git("init", "-q");
      git("config", "user.email", "test@example.test");
      git("config", "user.name", "PRB test");
      writeFileSync(logPath, base);
      git("add", "--", ".prime-board/log/events.jsonl");
      git("commit", "-qm", "base");
      writeFileSync(logPath, `${base}${JSON.stringify(event("generated"))}\n`);

      expect(() => createGitCommitter(rootDir)({ rootDir, eventIds: ["generated"] })).not.toThrow();
      expect(git("log", "-1", "--format=%s").toString().trim()).toBe(
        "chore(events): append canonical issue events",
      );
      expect(git("status", "--porcelain").toString()).toBe("");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps append → Git commit → projector → checkpoint order and deduplicates retry", () => {
    const fixtureData = fixture();
    const applied: string[] = [];
    let failCommit = true;
    const pipeline = new IssueEventPipeline({
      rootDir: fixtureData.rootDir,
      eventLog: fixtureData.eventLog,
      commitGit: () => {
        fixtureData.calls.push("commit");
        if (failCommit) throw new Error("git unavailable");
      },
      projector: {
        apply: (current) => {
          fixtureData.calls.push(`project:${current.eventId}`);
          applied.push(current.eventId);
        },
      },
      checkpointStore: fixtureData.store,
    });

    pipeline.append([event()]);
    expect(() => pipeline.commit()).toThrow("git unavailable");
    expect(pipeline.getCheckpoint()).toBeUndefined();
    expect(fixtureData.calls).toEqual(["append", "commit"]);

    failCommit = false;
    pipeline.commit();
    pipeline.project();
    expect(fixtureData.calls).toEqual([
      "append",
      "commit",
      "commit",
      "project:event-1",
      "checkpoint:event-1",
    ]);
    expect(applied).toEqual(["event-1"]);
    expect(pipeline.getCheckpoint()).toEqual({
      stream: "issues",
      eventId: "event-1",
      occurredAt: event().occurredAt,
    });

    // The next mutation/retry sees the same event but does not reapply it.
    pipeline.append([event()]);
    pipeline.commit();
    const result = pipeline.project();
    expect(result).toMatchObject({ applied: 0, skipped: 1 });
    expect(applied).toEqual(["event-1"]);
    expect(writerEvents(fixtureData.eventLog)).toHaveLength(1);
  });

  it("projects only issue aggregates from the shared canonical log", () => {
    const fixtureData = fixture();
    const applied: string[] = [];
    const metadataEvent: DomainEvent = {
      ...event("team-event"),
      aggregate: "team",
      aggregateKey: "PB",
      type: "updated",
      payload: { name: "Agents" },
    };
    const pipeline = new IssueEventPipeline({
      rootDir: fixtureData.rootDir,
      eventLog: fixtureData.eventLog,
      projector: { apply: (current) => applied.push(current.eventId) },
      checkpointStore: fixtureData.store,
    });

    pipeline.append([event(), metadataEvent]);
    pipeline.commit();

    expect(pipeline.project()).toMatchObject({ applied: 1, skipped: 0 });
    expect(applied).toEqual(["event-1"]);
    expect(pipeline.getCheckpoint()).toMatchObject({ stream: "issues", eventId: "event-1" });
  });

  it("fails closed when another process holds the Git index lock", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-committer-lock-"));
    const logPath = join(rootDir, ".prime-board", "log", "events.jsonl");
    const line = (eventId: string) => `${JSON.stringify(event(eventId))}\n`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    try {
      mkdirSync(join(rootDir, ".prime-board", "log"), { recursive: true });
      git("init", "-q");
      git("config", "user.email", "test@example.test");
      git("config", "user.name", "PRB test");
      writeFileSync(logPath, line("base"));
      git("add", "--", ".prime-board/log/events.jsonl");
      git("commit", "-qm", "base");
      writeFileSync(logPath, `${line("base")}${line("generated")}`);

      const indexPath = resolve(rootDir, git("rev-parse", "--git-path", "index").toString().trim());
      const lockPath = `${indexPath}.lock`;
      writeFileSync(lockPath, "");
      try {
        expect(() => createGitCommitter(rootDir)({ rootDir, eventIds: ["generated"] })).toThrow(
          "Cannot lock Git index",
        );
        expect(git("log", "-1", "--format=%s").toString().trim()).toBe("base");
        expect(git("show", ":.prime-board/log/events.jsonl").toString()).toBe(line("base"));
        expect(readFileSync(logPath, "utf8")).toBe(`${line("base")}${line("generated")}`);
        expect(existsSync(`${indexPath}.prime-board-event-log.lock`)).toBe(false);
      } finally {
        rmSync(lockPath, { force: true });
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("fails deterministically while another event-log writer commits", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-committer-event-lock-"));
    const logPath = join(rootDir, ".prime-board", "log", "events.jsonl");
    const line = (eventId: string) => `${JSON.stringify(event(eventId))}\n`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    try {
      mkdirSync(join(rootDir, ".prime-board", "log"), { recursive: true });
      git("init", "-q");
      git("config", "user.email", "test@example.test");
      git("config", "user.name", "PRB test");
      writeFileSync(logPath, line("base"));
      git("add", "--", ".prime-board/log/events.jsonl");
      git("commit", "-qm", "base");
      writeFileSync(logPath, `${line("base")}${line("generated")}`);

      const indexPath = resolve(rootDir, git("rev-parse", "--git-path", "index").toString().trim());
      const lockPath = `${indexPath}.prime-board-event-log.lock`;
      writeFileSync(lockPath, "");
      try {
        expect(() => createGitCommitter(rootDir)({ rootDir, eventIds: ["generated"] })).toThrow(
          "Cannot lock canonical event log",
        );
        expect(git("log", "-1", "--format=%s").toString().trim()).toBe("base");
        expect(readFileSync(logPath, "utf8")).toBe(`${line("base")}${line("generated")}`);
      } finally {
        rmSync(lockPath, { force: true });
      }

      createGitCommitter(rootDir)({ rootDir, eventIds: ["generated"] });
      expect(git("status", "--porcelain").toString()).toBe("");
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects pre-staged event-log changes without replacing the index", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-committer-staged-"));
    const logPath = join(rootDir, ".prime-board", "log", "events.jsonl");
    const line = (eventId: string) => `${JSON.stringify(event(eventId))}\n`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    try {
      mkdirSync(join(rootDir, ".prime-board", "log"), { recursive: true });
      git("init", "-q");
      git("config", "user.email", "test@example.test");
      git("config", "user.name", "PRB test");
      writeFileSync(logPath, line("base"));
      git("add", "--", ".prime-board/log/events.jsonl");
      git("commit", "-qm", "base");

      writeFileSync(logPath, `${line("base")}${line("foreign")}`);
      git("add", "--", ".prime-board/log/events.jsonl");
      writeFileSync(logPath, `${line("base")}${line("generated")}`);
      const committer = createGitCommitter(rootDir);
      expect(() => committer({ rootDir, eventIds: ["generated"] })).toThrow(
        "already has staged changes",
      );
      expect(git("show", ":.prime-board/log/events.jsonl").toString()).toBe(
        `${line("base")}${line("foreign")}`,
      );
      expect(readFileSync(logPath, "utf8")).toBe(`${line("base")}${line("generated")}`);
      expect(git("status", "--porcelain").toString()).toContain("MM");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("preserves unrelated staged files while committing the event log", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-committer-unrelated-staged-"));
    const logPath = join(rootDir, ".prime-board", "log", "events.jsonl");
    const line = (eventId: string) => `${JSON.stringify(event(eventId))}\n`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    try {
      mkdirSync(join(rootDir, ".prime-board", "log"), { recursive: true });
      git("init", "-q");
      git("config", "user.email", "test@example.test");
      git("config", "user.name", "PRB test");
      writeFileSync(logPath, line("base"));
      git("add", "--", ".prime-board/log/events.jsonl");
      git("commit", "-qm", "base");

      writeFileSync(join(rootDir, "unrelated.txt"), "keep staged\n");
      git("add", "--", "unrelated.txt");
      writeFileSync(logPath, `${line("base")}${line("generated")}`);

      createGitCommitter(rootDir)({ rootDir, eventIds: ["generated"] });

      expect(git("ls-tree", "-r", "--name-only", "HEAD").toString()).not.toContain("unrelated.txt");
      expect(git("show", ":unrelated.txt").toString()).toBe("keep staged\n");
      expect(git("diff", "--cached", "--name-only").toString()).toBe("unrelated.txt\n");
      expect(git("status", "--porcelain").toString()).toBe("A  unrelated.txt\n");
      expect(existsSync(`${resolve(rootDir, ".git/index")}.prime-board-event-log.lock`)).toBe(
        false,
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unrelated event-log changes before Git add and keeps them for retry", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-git-committer-"));
    const logPath = join(rootDir, ".prime-board", "log", "events.jsonl");
    const line = (eventId: string) => `${JSON.stringify(event(eventId))}\n`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", rootDir, ...args], { env: isolatedGitEnvironment() });
    try {
      mkdirSync(join(rootDir, ".prime-board", "log"), { recursive: true });
      git("init", "-q");
      git("config", "user.email", "test@example.test");
      git("config", "user.name", "PRB test");
      writeFileSync(logPath, line("base"));
      git("add", "--", ".prime-board/log/events.jsonl");
      git("commit", "-qm", "base");

      writeFileSync(logPath, `${line("base")}${line("preexisting")}${line("generated")}`);
      const committer = createGitCommitter(rootDir);
      expect(() => committer({ rootDir, eventIds: ["generated"] })).toThrow(
        "unexpected event: preexisting",
      );
      expect(readFileSync(logPath, "utf8")).toContain('"eventId":"preexisting"');
      expect(git("status", "--porcelain").toString()).toContain("events.jsonl");

      writeFileSync(logPath, `${line("base")}${line("generated")}`);
      committer({ rootDir, eventIds: ["generated"] });
      expect(git("log", "-1", "--format=%s").toString().trim()).toBe(
        "chore(events): append canonical issue events",
      );
      expect(git("status", "--porcelain").toString()).toBe("");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does not advance the checkpoint when projector or checkpoint fails", () => {
    const fixtureData = fixture();
    let failProjector = true;
    const applied: string[] = [];
    const pipeline = new IssueEventPipeline({
      rootDir: fixtureData.rootDir,
      eventLog: fixtureData.eventLog,
      projector: {
        apply: (current) => {
          applied.push(current.eventId);
          if (failProjector) throw new Error("projector unavailable");
        },
      },
      checkpointStore: fixtureData.store,
    });
    pipeline.append([event()]);
    pipeline.commit();

    expect(() => pipeline.project()).toThrow("projector unavailable");
    expect(pipeline.getCheckpoint()).toBeUndefined();
    expect(fixtureData.checkpoint.value).toBeUndefined();

    failProjector = false;
    fixtureData.checkpoint.fail = true;
    expect(() => pipeline.project()).toThrow("checkpoint unavailable");
    expect(pipeline.getCheckpoint()).toBeUndefined();
    expect(fixtureData.checkpoint.value).toBeUndefined();

    fixtureData.checkpoint.fail = false;
    expect(pipeline.project()).toMatchObject({ applied: 1, skipped: 0 });
    expect(applied).toEqual(["event-1", "event-1", "event-1"]);
  });
});

function writerEvents(eventLog: CanonicalEventLog): DomainEvent[] {
  return eventLog.read();
}
