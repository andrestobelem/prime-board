import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventLog } from "./event-log.ts";
import { importSqliteActivity } from "./sqlite-event-import.ts";
import { isSharedActivityType } from "./activity-stream.ts";

function database(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE actors (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE teams (id TEXT PRIMARY KEY, key TEXT NOT NULL);
    CREATE TABLE issues (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, number INTEGER NOT NULL);
    CREATE TABLE activity (
      id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  db.query("INSERT INTO actors VALUES (?1, ?2)").run("actor-1", "agent");
  db.query("INSERT INTO teams VALUES (?1, ?2)").run("team-1", "PB");
  db.query("INSERT INTO issues VALUES (?1, ?2, ?3)").run("issue-1", "team-1", 7);
  return db;
}

function workspaceDatabase(workspaceCount = 2): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workspace (id TEXT PRIMARY KEY);
    CREATE TABLE actors (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE teams (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      key TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE issues (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE activity (
      workspace_id TEXT,
      id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
  `);
  db.query("INSERT INTO actors VALUES (?1, ?2)").run("actor-1", "agent");
  db.query("INSERT INTO workspace VALUES (?1)").run("workspace-1");
  db.query("INSERT INTO teams VALUES (?1, ?2, ?3)").run("workspace-1", "team-1", "PB");
  db.query("INSERT INTO issues VALUES (?1, ?2, ?3, ?4)").run("workspace-1", "issue-1", "team-1", 7);
  if (workspaceCount > 1) {
    db.query("INSERT INTO workspace VALUES (?1)").run("workspace-2");
    db.query("INSERT INTO teams VALUES (?1, ?2, ?3)").run("workspace-2", "team-2", "PB");
    db.query("INSERT INTO issues VALUES (?1, ?2, ?3, ?4)").run(
      "workspace-2",
      "issue-2",
      "team-2",
      7,
    );
  }
  return db;
}

function addWorkspaceActivity(
  db: Database,
  workspaceId: string | null,
  id: string,
  issueId: string,
): void {
  db.query(
    "INSERT INTO activity(workspace_id, id, issue_id, actor_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  ).run(
    workspaceId,
    id,
    issueId,
    "actor-1",
    "created",
    JSON.stringify({ title: id }),
    "2025-01-01T00:00:00.000Z",
  );
}

function addActivity(
  db: Database,
  id: string,
  payload: string,
  issueId = "issue-1",
  actorId = "actor-1",
  type = "updated",
) {
  db.query("INSERT INTO activity VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
    id,
    issueId,
    actorId,
    type,
    payload,
    `2025-01-01T00:00:0${id.replace(/\D/g, "") || "0"}.000Z`,
  );
}

describe("SQLite history import", () => {
  it("supports dry-run and imports idempotently", () => {
    const db = database();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-import-"));
    try {
      addActivity(
        db,
        "activity-1",
        JSON.stringify({ title: "History" }),
        "issue-1",
        "actor-1",
        "created",
      );
      const dry = importSqliteActivity({ db, rootDir: root, dryRun: true });
      expect(dry).toMatchObject({ status: "completed", scanned: 1, emitted: 1, duplicates: 0 });
      expect(existsSync(join(root, ".prime-board/log/events.jsonl"))).toBe(false);
      const first = importSqliteActivity({ db, rootDir: root });
      const second = importSqliteActivity({ db, rootDir: root });
      expect(first.emitted).toBe(1);
      expect(second.duplicates).toBe(1);
      const dryExisting = importSqliteActivity({ db, rootDir: root, dryRun: true });
      expect(dryExisting).toMatchObject({ emitted: 0, duplicates: 1, ambiguous: 0 });
      db.query("UPDATE actors SET name = ?1 WHERE id = ?2").run("renamed-agent", "actor-1");
      const dryAfterActorRename = importSqliteActivity({ db, rootDir: root, dryRun: true });
      expect(dryAfterActorRename).toMatchObject({ emitted: 0, duplicates: 1, ambiguous: 0 });
      expect(readEventLog(root)[0]?.actor).toBe("actor-1");
      db.query("UPDATE activity SET payload = ?1 WHERE id = ?2").run(
        JSON.stringify({ title: "changed after import" }),
        "activity-1",
      );
      const conflict = importSqliteActivity({ db, rootDir: root, dryRun: true });
      expect(conflict).toMatchObject({ emitted: 0, duplicates: 0, ambiguous: 1 });
      expect(conflict.warnings).toContain("ambiguous:activity-1");
      expect(readEventLog(root).map((event) => event.eventId)).toEqual(["activity-1"]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes and excludes every sensitive activity type", () => {
    expect(isSharedActivityType("FaVoRiTe-SeNt")).toBe(false);
    expect(isSharedActivityType("inbox_receipt_created")).toBe(false);
    expect(isSharedActivityType("API key rotated")).toBe(false);
    expect(isSharedActivityType("webhook_secret_changed")).toBe(false);
    expect(isSharedActivityType("issue_updated")).toBe(true);
  });

  it("reports orphans, malformed payloads and excluded projections without writing them", () => {
    const db = database();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-import-"));
    try {
      addActivity(db, "valid-1", JSON.stringify({ title: "valid" }));
      addActivity(db, "orphan-1", "{}", "missing-issue");
      addActivity(db, "bad-1", "not-json");
      addActivity(db, "secret-1", JSON.stringify({ apiKeyHash: "never" }));
      addActivity(db, "favorite-1", "{}", "issue-1", "actor-1", "favorite_created");
      addActivity(db, "favorite-sent-1", "{}", "issue-1", "actor-1", "FaVoRiTe-SeNt");
      addActivity(db, "inbox-1", "{}", "issue-1", "actor-1", "inbox_receipt_created");
      addActivity(db, "apikey-1", "{}", "issue-1", "actor-1", "API key rotated");
      addActivity(db, "webhook-secret-1", "{}", "issue-1", "actor-1", "webhook_secret_changed");
      const result = importSqliteActivity({ db, rootDir: root });
      expect(result.scanned).toBe(9);
      expect(result.emitted).toBe(1);
      expect(result.orphaned).toBe(1);
      expect(result.rejected).toBe(7);
      const eventIds = readEventLog(root).map((event) => event.eventId);
      expect(eventIds).toEqual(["valid-1"]);
      for (const id of ["favorite-1", "favorite-sent-1", "inbox-1", "apikey-1", "webhook-secret-1"])
        expect(eventIds).not.toContain(id);
      expect(readFileSync(join(root, ".prime-board/log/events.jsonl"), "utf8")).not.toContain(
        "never",
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit Workspace and imports only the selected scope", () => {
    const db = workspaceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-import-"));
    try {
      addWorkspaceActivity(db, "workspace-1", "workspace-1-event", "issue-1");
      addWorkspaceActivity(db, "workspace-2", "workspace-2-event", "issue-2");

      expect(() => importSqliteActivity({ db, rootDir: root })).toThrow("requires workspaceId");
      const dry = importSqliteActivity({
        db,
        rootDir: root,
        dryRun: true,
        workspaceId: "workspace-1",
      });
      expect(dry).toMatchObject({
        scanned: 2,
        emitted: 1,
        outOfScope: 1,
        orphaned: 0,
      });
      expect(existsSync(join(root, ".prime-board/log/events.jsonl"))).toBe(false);

      const imported = importSqliteActivity({ db, rootDir: root, workspaceId: "workspace-1" });
      expect(imported.emitted).toBe(1);
      expect(readEventLog(root).map((event) => event.eventId)).toEqual(["workspace-1-event"]);
      expect(() =>
        importSqliteActivity({ db, rootDir: root, workspaceId: "missing-workspace" }),
      ).toThrow("does not exist");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for NULL activity scope in a multi-Workspace source", () => {
    const db = workspaceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-import-"));
    try {
      addWorkspaceActivity(db, null, "legacy-event", "issue-1");
      addWorkspaceActivity(db, "workspace-1", "scoped-event", "issue-1");
      const result = importSqliteActivity({ db, rootDir: root, workspaceId: "workspace-1" });
      expect(result).toMatchObject({ scanned: 2, emitted: 1, orphaned: 1, outOfScope: 0 });
      expect(result.warnings).toContain("orphaned:legacy-event");
      expect(readEventLog(root).map((event) => event.eventId)).toEqual(["scoped-event"]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a selector when the source has no Workspace identity", () => {
    const db = workspaceDatabase(0);
    db.query("DELETE FROM workspace").run();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-import-"));
    try {
      addWorkspaceActivity(db, null, "legacy-event", "issue-1");
      expect(() =>
        importSqliteActivity({ db, rootDir: root, workspaceId: "missing-workspace" }),
      ).toThrow("does not exist");
      expect(existsSync(join(root, ".prime-board/log/events.jsonl"))).toBe(false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a NULL legacy scope while the source has one Workspace", () => {
    const db = workspaceDatabase(1);
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-import-"));
    try {
      addWorkspaceActivity(db, null, "legacy-singleton-event", "issue-1");
      const result = importSqliteActivity({ db, rootDir: root });
      expect(result).toMatchObject({ scanned: 1, emitted: 1, orphaned: 0, outOfScope: 0 });
      expect(readEventLog(root).map((event) => event.eventId)).toEqual(["legacy-singleton-event"]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
