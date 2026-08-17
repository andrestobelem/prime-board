// Tests de AT-131: migraciones, bootstrap idempotente y persistencia entre aperturas.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashApiKey } from "../auth/keys.ts";
import { openDatabase } from "./database.ts";
import { bootstrap } from "./seed.ts";
import migration0016 from "./migrations/0016_webhook_ownership.sql" with { type: "text" };

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "prime-board-test-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  it("crea el esquema completo con WAL activado", () => {
    const db = openDatabase(tempDbPath());
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .values()
      .map((row) => row[0] as string);
    for (const table of [
      "workspace",
      "actors",
      "api_keys",
      "teams",
      "workflow_states",
      "projects",
      "issues",
      "labels",
      "issue_labels",
      "comments",
      "activity",
      "webhooks",
      "issues_fts",
      "saved_views",
      "cycles",
      "reviews",
      "initiatives",
      "initiative_projects",
      "project_updates",
      "inbox_receipts",
    ]) {
      expect(tables).toContain(table);
    }
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    db.close();
  });

  it("es idempotente: reabrir no re-aplica migraciones", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    const initial = first.query("SELECT count(*) AS n FROM _migrations").get() as { n: number };
    first.close();
    const db = openDatabase(path);
    const after = db.query("SELECT count(*) AS n FROM _migrations").get() as { n: number };
    expect(after.n).toBe(initial.n);
    expect(after.n).toBeGreaterThanOrEqual(2);
    db.close();
  });
});

describe("bootstrap", () => {
  it("siembra workspace, team default con workflow, admin y su API key", () => {
    const db = openDatabase(tempDbPath());
    const result = bootstrap(db);
    expect(result.created).toBe(true);
    expect(result.adminApiKey).toStartWith("pb_");

    const team = db.query("SELECT key FROM teams").get() as { key: string };
    expect(team.key).toBe("PB");
    const states = db.query("SELECT type FROM workflow_states ORDER BY position").values();
    expect(states.map((row) => row[0])).toEqual([
      "backlog",
      "unstarted",
      "started",
      "completed",
      "canceled",
    ]);
    const storedKey = db.query("SELECT hash FROM api_keys").get() as { hash: string };
    expect(storedKey.hash).toBe(hashApiKey(result.adminApiKey!));
    db.close();
  });

  it("no duplica datos y persiste entre reinicios", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    bootstrap(first);
    first.close();

    const second = openDatabase(path);
    const result = bootstrap(second);
    expect(result.created).toBe(false);
    const actors = second.query("SELECT count(*) AS n FROM actors").get() as { n: number };
    expect(actors.n).toBe(1);
    second.close();
  });

  it("la búsqueda full-text queda operativa (FTS5 disponible)", () => {
    const db = openDatabase(tempDbPath());
    bootstrap(db);
    const team = db.query("SELECT id FROM teams").get() as { id: string };
    const state = db.query("SELECT id FROM workflow_states LIMIT 1").get() as { id: string };
    const admin = db.query("SELECT id FROM actors").get() as { id: string };
    db.query(
      "INSERT INTO issues (id, team_id, number, title, description, state_id, creator_id, sort_order, created_at, updated_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, 0, ?7, ?7)",
    ).run(
      "issue-1",
      team.id,
      "Implement webhooks dispatcher",
      "Deliver signed events",
      state.id,
      admin.id,
      new Date().toISOString(),
    );

    const hits = db
      .query("SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?1")
      .values("webhooks");
    expect(hits.length).toBe(1);
    db.close();
  });
});

describe("webhook ownership migration", () => {
  it("atribuye los webhooks existentes al admin sin leer el secret", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE actors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.query(
      "INSERT INTO actors (id, name, workspace_role, created_at) VALUES ('admin-id', 'admin', 'admin', '2026-01-01'), ('other-id', 'other', 'member', '2026-01-02')",
    ).run();
    db.query(
      "INSERT INTO webhooks (id, url, secret, events, enabled, created_at) VALUES ('hook-id', 'https://example.com', 'secret', '[\"*\"]', 1, '2026-01-01')",
    ).run();

    db.exec(migration0016);

    const owner = db.query("SELECT owner_id FROM webhooks WHERE id = 'hook-id'").get() as {
      owner_id: string;
    };
    expect(owner.owner_id).toBe("admin-id");
    db.close();
  });
});
