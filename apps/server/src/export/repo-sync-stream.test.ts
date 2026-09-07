import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendActivityEvents, activityToDomainEvent } from "./activity-stream.ts";
import type { DomainEvent } from "./event-log.ts";

function database(withActivityWorkspace = false): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE actors (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      workspace_id TEXT
    );
    CREATE TABLE issues (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      workspace_id TEXT
    );
    CREATE TABLE activity (
      id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      ${withActivityWorkspace ? ", workspace_id TEXT" : ""}
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
      db.query("INSERT INTO teams (id, key, workspace_id) VALUES (?1, ?2, ?3)").run(
        "team-1",
        "PB",
        "workspace-a",
      );
      db.query(
        "INSERT INTO issues (id, team_id, number, workspace_id) VALUES (?1, ?2, ?3, ?4)",
      ).run("issue-1", "team-1", 7, "workspace-a");
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
        actor: "actor-1",
        workspaceId: "workspace-a",
        occurredAt: "2025-01-01T00:00:00.000Z",
        payload: { title: "Shared issue" },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not emit a legacy Activity whose Issue is missing", () => {
    const db = database();
    const root = mkdtempSync(join(tmpdir(), "prb-repo-stream-orphan-"));
    try {
      db.query("INSERT INTO actors (id, name) VALUES (?1, ?2)").run("actor-1", "agent");
      db.query("INSERT INTO teams (id, key, workspace_id) VALUES (?1, ?2, ?3)").run(
        "team-1",
        "PB",
        "workspace-a",
      );
      db.query(
        "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).run(
        "activity-orphan",
        "missing-issue",
        "actor-1",
        "created",
        "{}",
        "2025-01-01T00:00:00.000Z",
      );

      expect(appendActivityEvents(db, root)).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an Activity whose scope conflicts with its Issue", () => {
    const db = database(true);
    const root = mkdtempSync(join(tmpdir(), "prb-repo-stream-cross-workspace-"));
    try {
      db.query("INSERT INTO actors (id, name) VALUES (?1, ?2)").run("actor-1", "agent");
      db.query("INSERT INTO teams (id, key, workspace_id) VALUES (?1, ?2, ?3)").run(
        "team-1",
        "PB",
        "workspace-b",
      );
      db.query(
        "INSERT INTO issues (id, team_id, number, workspace_id) VALUES (?1, ?2, ?3, ?4)",
      ).run("issue-1", "team-1", 7, "workspace-b");
      db.query(
        "INSERT INTO activity (id, issue_id, actor_id, type, payload, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).run(
        "activity-cross-workspace",
        "issue-1",
        "actor-1",
        "created",
        "{}",
        "2025-01-01T00:00:00.000Z",
        "workspace-a",
      );

      expect(appendActivityEvents(db, root)).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports partial and idempotent IDs so a later retry can commit them", () => {
    const db = database();
    const root = mkdtempSync(join(tmpdir(), "prb-repo-stream-partial-"));
    const stored: DomainEvent[] = [];
    const callbacks: string[][] = [];
    let firstAttempt = true;
    try {
      db.query("INSERT INTO actors (id, name) VALUES (?1, ?2)").run("actor-1", "agent");
      db.query("INSERT INTO teams (id, key, workspace_id) VALUES (?1, ?2, ?3)").run(
        "team-1",
        "PB",
        "workspace-a",
      );
      db.query(
        "INSERT INTO issues (id, team_id, number, workspace_id) VALUES (?1, ?2, ?3, ?4)",
      ).run("issue-1", "team-1", 7, "workspace-a");
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
      const eventLog = {
        appendMany: (inputs: readonly unknown[]) => {
          const event = inputs[0] as DomainEvent;
          if (firstAttempt) {
            firstAttempt = false;
            stored.push(event);
            throw new Error("partial append");
          }
          return [{ eventId: event.eventId, appended: false }];
        },
        read: () => stored,
      };

      expect(() =>
        appendActivityEvents(db, root, eventLog, (ids) => callbacks.push([...ids])),
      ).toThrow("partial append");
      expect(callbacks).toEqual([["activity-1"]]);
      callbacks.length = 0;
      expect(appendActivityEvents(db, root, eventLog, (ids) => callbacks.push([...ids]))).toBe(1);
      expect(callbacks).toEqual([["activity-1"]]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes the effective Workspace in canonical Activity events", () => {
    const event = activityToDomainEvent({
      id: "activity-workspace-a",
      issue_identifier: "PB-1",
      actor_id: "actor-1",
      actor: "agent",
      type: "updated",
      payload: JSON.stringify({ title: "Scoped issue" }),
      workspace_id: "workspace-a",
      occurred_at: "2025-01-01T00:00:00.000Z",
    });
    expect(event?.workspaceId).toBe("workspace-a");
    expect(event?.payload).toEqual({ title: "Scoped issue" });
  });

  it("uses the immutable Actor ID when a display name changes", () => {
    const current = activityToDomainEvent({
      id: "activity-1",
      issue_identifier: "PB-1",
      actor_id: "actor-1",
      actor: "renamed-agent",
      type: "updated",
      payload: "{}",
      occurred_at: "2025-01-01T00:00:00.000Z",
    });
    expect(current?.actor).toBe("actor-1");
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
