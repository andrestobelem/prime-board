import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendActivityEvents, activityToDomainEvent } from "./activity-stream.ts";

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
  return db;
}

describe("canonical Activity stream bridge", () => {
  it("appends stable issue events idempotently without reading historical logs", () => {
    const db = database();
    const root = mkdtempSync(join(tmpdir(), "prb-repo-stream-"));
    try {
      db.query("INSERT INTO actors (id, name) VALUES (?1, ?2)").run("actor-1", "agent");
      db.query("INSERT INTO teams (id, key) VALUES (?1, ?2)").run("team-1", "PB");
      db.query("INSERT INTO issues (id, team_id, number) VALUES (?1, ?2, ?3)").run(
        "issue-1",
        "team-1",
        7,
      );
      db.query(
        "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run(
        "activity-1",
        "issue-1",
        "actor-1",
        "created",
        JSON.stringify({ title: "Shared issue" }),
        "2025-01-01T00:00:00.000Z",
      );

      expect(appendActivityEvents(db, root)).toBe(1);
      expect(appendActivityEvents(db, root)).toBe(1);
      const path = join(root, ".prime-board", "log", "events.jsonl");
      expect(existsSync(path)).toBe(true);
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        eventId: "activity-1",
        aggregate: "issue",
        aggregateKey: "PB-7",
        type: "created",
        actor: "agent",
        occurredAt: "2025-01-01T00:00:00.000Z",
        payload: { title: "Shared issue" },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create events for sensitive or personal activity names", () => {
    expect(
      activityToDomainEvent({
        id: "favorite-1",
        issue_identifier: "PB-1",
        actor: "agent",
        type: "favorite_created",
        payload: "{}",
        occurred_at: "2025-01-01T00:00:00.000Z",
      }),
    ).toBeUndefined();
    expect(
      activityToDomainEvent({
        id: "inbox-1",
        issue_identifier: "PB-1",
        actor: "agent",
        type: "inbox_receipt_created",
        payload: "{}",
        occurred_at: "2025-01-01T00:00:00.000Z",
      }),
    ).toBeUndefined();
    expect(
      activityToDomainEvent({
        id: "secret-1",
        issue_identifier: "PB-1",
        actor: "agent",
        type: "updated",
        payload: JSON.stringify({ apiKey: "secret" }),
        occurred_at: "2025-01-01T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});
