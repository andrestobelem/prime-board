import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventLog } from "./event-log.ts";
import {
  importSqliteHistory,
  SQLITE_HISTORY_EXCLUDED_TABLES,
  SQLITE_HISTORY_TABLES,
} from "./sqlite-history-import.ts";

function sourceDatabase(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT, url_key TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE actors (id TEXT PRIMARY KEY, name TEXT, type TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE workspace_memberships (id TEXT PRIMARY KEY, workspace_id TEXT, actor_id TEXT, role TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE teams (id TEXT PRIMARY KEY, workspace_id TEXT, key TEXT, name TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE workflow_states (id TEXT PRIMARY KEY, workspace_id TEXT, team_id TEXT, name TEXT, type TEXT, color TEXT, position REAL, created_at TEXT, updated_at TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, state TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE project_teams (project_id TEXT, team_id TEXT, workspace_id TEXT);
    CREATE TABLE milestones (id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT, name TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE cycles (id TEXT PRIMARY KEY, workspace_id TEXT, team_id TEXT, number INTEGER, name TEXT, starts_at TEXT, ends_at TEXT, state TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE issues (id TEXT PRIMARY KEY, workspace_id TEXT, team_id TEXT, number INTEGER, title TEXT, state_id TEXT, creator_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE labels (id TEXT PRIMARY KEY, workspace_id TEXT, team_id TEXT, name TEXT, color TEXT, created_at TEXT);
    CREATE TABLE issue_labels (issue_id TEXT, label_id TEXT, workspace_id TEXT);
    CREATE TABLE issue_relations (id TEXT PRIMARY KEY, workspace_id TEXT, issue_id TEXT, related_id TEXT, type TEXT, created_at TEXT);
    CREATE TABLE comments (id TEXT PRIMARY KEY, workspace_id TEXT, issue_id TEXT, actor_id TEXT, body TEXT, created_at TEXT);
    CREATE TABLE activity (id TEXT PRIMARY KEY, workspace_id TEXT, issue_id TEXT, actor_id TEXT, type TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE team_memberships (id TEXT PRIMARY KEY, workspace_id TEXT, team_id TEXT, actor_id TEXT, role TEXT, created_at TEXT);
    CREATE TABLE initiatives (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, state TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE initiative_projects (initiative_id TEXT, project_id TEXT, workspace_id TEXT);
    CREATE TABLE initiative_teams (initiative_id TEXT, team_id TEXT, workspace_id TEXT);
    CREATE TABLE project_updates (id TEXT PRIMARY KEY, workspace_id TEXT, project_id TEXT, author_id TEXT, health TEXT, body TEXT, risks TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE reviews (id TEXT PRIMARY KEY, workspace_id TEXT, issue_id TEXT, requester_id TEXT, reviewer_id TEXT, status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE issue_subscribers (issue_id TEXT, actor_id TEXT, workspace_id TEXT, created_at TEXT);
    CREATE TABLE saved_views (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, scope TEXT, team_id TEXT, owner_id TEXT, filter_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE favorites (id TEXT PRIMARY KEY, actor_id TEXT, project_id TEXT, saved_view_id TEXT, position INTEGER, created_at TEXT);
    CREATE TABLE inbox_receipts (activity_id TEXT, actor_id TEXT, read_at TEXT, archived_at TEXT);
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, actor_id TEXT, name TEXT, hash TEXT, created_at TEXT);
    CREATE TABLE api_key_scopes (api_key_id TEXT, scope TEXT);
    CREATE TABLE api_key_team_limits (api_key_id TEXT, team_id TEXT);
    CREATE TABLE api_key_workspaces (api_key_id TEXT, workspace_id TEXT, is_default INTEGER, created_at TEXT);
    CREATE TABLE actor_invitations (id TEXT PRIMARY KEY, email TEXT, token_hash TEXT, created_at TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, content TEXT, created_at TEXT);
    CREATE TABLE webhooks (id TEXT PRIMARY KEY, url TEXT, secret TEXT, created_at TEXT);
  `);
  const date = "2025-01-01T00:00:00.000Z";
  db.query("INSERT INTO workspace VALUES ('w1', 'Workspace', 'workspace', ?1, ?1)").run(date);
  db.query("INSERT INTO actors VALUES ('a1', 'Author', 'agent', ?1, ?1)").run(date);
  db.query(
    "INSERT INTO workspace_memberships VALUES ('wm1', 'w1', 'a1', 'admin', 'active', ?1, ?1)",
  ).run(date);
  db.query("INSERT INTO teams VALUES ('t1', 'w1', 'PB', 'Board', ?1, ?1)").run(date);
  db.query(
    "INSERT INTO workflow_states VALUES ('s1', 'w1', 't1', 'Todo', 'unstarted', '#fff', 1, ?1, ?1)",
  ).run(date);
  db.query("INSERT INTO projects VALUES ('p1', 'w1', 'Project', 'started', ?1, ?1)").run(date);
  db.query("INSERT INTO project_teams VALUES ('p1', 't1', 'w1')").run();
  db.query("INSERT INTO milestones VALUES ('m1', 'w1', 'p1', 'M1', ?1, ?1)").run(date);
  db.query("INSERT INTO cycles VALUES ('c1', 'w1', 't1', 1, 'C1', ?1, ?1, 'active', ?1, ?1)").run(
    date,
  );
  db.query("INSERT INTO issues VALUES ('i1', 'w1', 't1', 1, 'Issue', 's1', 'a1', ?1, ?1)").run(
    date,
  );
  db.query(
    "INSERT INTO issues VALUES ('i1-other', 'w1', 't1', 2, 'Related issue', 's1', 'a1', ?1, ?1)",
  ).run(date);
  db.query("INSERT INTO labels VALUES ('l1', 'w1', 't1', 'bug', '#f00', ?1)").run(date);
  db.query("INSERT INTO issue_labels VALUES ('i1', 'l1', 'w1')").run();
  db.query("INSERT INTO issue_relations VALUES ('r1', 'w1', 'i1', 'i1-other', 'related', ?1)").run(
    date,
  );
  db.query("INSERT INTO comments VALUES ('cm1', 'w1', 'i1', 'a1', 'Comment', ?1)").run(date);
  db.query(
    "INSERT INTO activity VALUES ('ac1', 'w1', 'i1', 'a1', 'created', '{\"title\":\"Issue\"}', ?1)",
  ).run(date);
  db.query("INSERT INTO team_memberships VALUES ('tm1', 'w1', 't1', 'a1', 'owner', ?1)").run(date);
  db.query("INSERT INTO initiatives VALUES ('n1', 'w1', 'Initiative', 'active', ?1, ?1)").run(date);
  db.query("INSERT INTO initiative_projects VALUES ('n1', 'p1', 'w1')").run();
  db.query("INSERT INTO initiative_teams VALUES ('n1', 't1', 'w1')").run();
  db.query(
    "INSERT INTO project_updates VALUES ('u1', 'w1', 'p1', 'a1', 'on_track', 'Update', NULL, ?1, ?1)",
  ).run(date);
  db.query("INSERT INTO reviews VALUES ('rv1', 'w1', 'i1', 'a1', 'a1', 'requested', ?1, ?1)").run(
    date,
  );
  db.query("INSERT INTO issue_subscribers VALUES ('i1', 'a1', 'w1', ?1)").run(date);
  db.query(
    "INSERT INTO saved_views VALUES ('v1', 'w1', 'Mine', 'personal', NULL, 'a1', '{}', ?1, ?1)",
  ).run(date);
  db.query("INSERT INTO favorites VALUES ('f1', 'a1', 'p1', NULL, 0, ?1)").run(date);
  db.query("INSERT INTO inbox_receipts VALUES ('ac1', 'a1', NULL, NULL)").run();
  db.query("INSERT INTO api_keys VALUES ('key1', 'a1', 'Key', 'hash-must-not-leak', ?1)").run(date);
  db.query("INSERT INTO api_key_scopes VALUES ('key1', 'admin')").run();
  db.query("INSERT INTO api_key_team_limits VALUES ('key1', 't1')").run();
  db.query("INSERT INTO api_key_workspaces VALUES ('key1', 'w1', 1, ?1)").run(date);
  db.query(
    "INSERT INTO actor_invitations VALUES ('inv1', 'x@example.test', 'token-hash-must-not-leak', ?1)",
  ).run(date);
  db.query("INSERT INTO documents VALUES ('doc1', 'w1', 'Doc', 'content-must-not-leak', ?1)").run(
    date,
  );
  db.query(
    "INSERT INTO webhooks VALUES ('hook1', 'https://example.test', 'secret-must-not-leak', ?1)",
  ).run(date);
  return db;
}

describe("complete SQLite history import", () => {
  it("imports shared entities with stable IDs and excludes secrets/personal projections", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-"));
    try {
      const dry = importSqliteHistory({ db, rootDir: root, dryRun: true });
      expect(dry).toMatchObject({
        status: "completed",
        dryRun: true,
        scanned: 33,
        emitted: 24,
        excluded: 9,
        rejected: 0,
        orphaned: 0,
      });
      expect(existsSync(join(root, ".prime-board", "log", "events.jsonl"))).toBe(false);

      const first = importSqliteHistory({ db, rootDir: root });
      expect(first.written).toBe(24);
      const events = readEventLog(root);
      expect(events).toHaveLength(24);
      expect(events.some((event) => event.eventId === "ac1")).toBe(true);
      expect(events.some((event) => event.eventId === "sqlite:issues:i1")).toBe(true);
      expect(events.some((event) => event.eventId === "sqlite:issue_relations:r1")).toBe(true);
      const issue = events.find((event) => event.eventId === "sqlite:issues:i1");
      expect(issue?.payload.id).toBe("i1");
      expect(issue?.payload.creator_id).toBe("a1");
      expect(issue?.payload.identifier).toBe("PB-1");
      expect(issue?.aggregate).toBe("issue");
      expect(issue?.workspaceId).toBe("w1");
      expect(issue?.type).toBe("snapshot_imported");
      const relation = events.find((event) => event.eventId === "sqlite:issue_relations:r1");
      expect(relation?.payload.issue_id).toBe("i1");
      expect(relation?.payload.related_id).toBe("i1-other");
      const update = events.find((event) => event.eventId === "sqlite:project_updates:u1");
      expect(update?.payload.body).toBe("Update");
      expect(update?.actor).toBe("a1");
      const log = readFileSync(join(root, ".prime-board", "log", "events.jsonl"), "utf8");
      expect(log).not.toContain("hash-must-not-leak");
      expect(log).not.toContain("secret-must-not-leak");
      expect(log).not.toContain("token-hash-must-not-leak");
      expect(log).not.toContain("content-must-not-leak");

      const repeatRoot = mkdtempSync(join(tmpdir(), "pb-sqlite-history-repeat-"));
      try {
        importSqliteHistory({ db, rootDir: repeatRoot });
        expect(readEventLog(repeatRoot)).toEqual(events);
      } finally {
        rmSync(repeatRoot, { recursive: true, force: true });
      }

      const second = importSqliteHistory({ db, rootDir: root, batchSize: 3 });
      expect(second).toMatchObject({ emitted: 0, written: 0, duplicates: 24 });
      expect(readEventLog(root)).toHaveLength(24);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects cross-workspace rows and reports NULL scope as orphaned", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-scope-"));
    try {
      db.query(
        "INSERT INTO workspace VALUES ('w2', 'Other', 'other', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query(
        "INSERT INTO actors VALUES ('a2', 'Other', 'agent', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query(
        "INSERT INTO workspace_memberships VALUES ('wm2', 'w2', 'a2', 'member', 'active', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query(
        "INSERT INTO workspace_memberships VALUES ('wm1-other', 'w2', 'a1', 'member', 'active', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query(
        "INSERT INTO teams VALUES ('t2', 'w2', 'OT', 'Other', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query(
        "INSERT INTO workflow_states VALUES ('s2', 'w2', 't2', 'Todo', 'unstarted', '#fff', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query(
        "INSERT INTO issues VALUES ('i2', 'w2', 't2', 1, 'Other', 's2', 'a2', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query(
        "INSERT INTO activity VALUES ('ac2', 'w2', 'i2', 'a2', 'created', '{}', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query(
        "INSERT INTO activity VALUES ('ac-null', NULL, 'i1', 'a1', 'updated', '{}', '2025-01-01T00:00:00.000Z')",
      ).run();
      const result = importSqliteHistory({ db, rootDir: root, workspaceId: "w1" });
      expect(result.outOfScope).toBeGreaterThan(0);
      expect(result.orphaned).toBeGreaterThan(0);
      expect(result.warnings.some((warning) => warning.includes("orphaned:activity:ac-null"))).toBe(
        true,
      );
      expect(readEventLog(root).some((event) => event.eventId === "ac2")).toBe(false);
      expect(readEventLog(root).every((event) => event.workspaceId === "w1")).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous event conflicts without rewriting the first record", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-conflict-"));
    try {
      importSqliteHistory({ db, rootDir: root });
      db.query("UPDATE issues SET title = 'changed' WHERE id = 'i1'").run();
      const result = importSqliteHistory({ db, rootDir: root, dryRun: true });
      expect(result.ambiguous).toBeGreaterThan(0);
      expect(result.emitted).toBe(0);
      expect(
        readEventLog(root).find((event) => event.eventId === "sqlite:issues:i1")?.payload.title,
      ).toBe("Issue");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

expect(SQLITE_HISTORY_TABLES.length).toBeGreaterThan(0);
expect(SQLITE_HISTORY_EXCLUDED_TABLES).toContain("favorites");
