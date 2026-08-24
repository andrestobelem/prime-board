import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventLog } from "./event-log.ts";
import { importSqliteActivity } from "./sqlite-event-import.ts";

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

  it("reports orphans, malformed payloads and excluded projections without writing them", () => {
    const db = database();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-import-"));
    try {
      addActivity(db, "valid-1", JSON.stringify({ title: "valid" }));
      addActivity(db, "orphan-1", "{}", "missing-issue");
      addActivity(db, "bad-1", "not-json");
      addActivity(db, "secret-1", JSON.stringify({ apiKeyHash: "never" }));
      addActivity(db, "favorite-1", "{}", "issue-1", "actor-1", "favorite_created");
      const result = importSqliteActivity({ db, rootDir: root });
      expect(result.scanned).toBe(5);
      expect(result.emitted).toBe(1);
      expect(result.orphaned).toBe(1);
      expect(result.rejected).toBe(3);
      expect(readEventLog(root).map((event) => event.eventId)).toEqual(["valid-1"]);
      expect(readFileSync(join(root, ".prime-board/log/events.jsonl"), "utf8")).not.toContain(
        "never",
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
