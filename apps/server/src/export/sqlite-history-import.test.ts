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

function legacySingletonDatabase(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT, url_key TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE actors (id TEXT PRIMARY KEY, name TEXT, type TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE teams (id TEXT PRIMARY KEY, key TEXT, name TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE workflow_states (id TEXT PRIMARY KEY, team_id TEXT, name TEXT, type TEXT, color TEXT, position REAL, created_at TEXT, updated_at TEXT);
    CREATE TABLE issues (id TEXT PRIMARY KEY, team_id TEXT, number INTEGER, title TEXT, state_id TEXT, creator_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE activity (id TEXT PRIMARY KEY, issue_id TEXT, actor_id TEXT, type TEXT, payload TEXT, created_at TEXT);
  `);
  const date = "2025-01-01T00:00:00.000Z";
  db.query("INSERT INTO workspace VALUES ('legacy-w1', 'Legacy', 'legacy', ?1, ?1)").run(date);
  db.query("INSERT INTO actors VALUES ('legacy-a1', 'Author', 'agent', ?1, ?1)").run(date);
  db.query("INSERT INTO teams VALUES ('legacy-t1', 'LEG', 'Legacy team', ?1, ?1)").run(date);
  db.query(
    "INSERT INTO workflow_states VALUES ('legacy-s1', 'legacy-t1', 'Todo', 'unstarted', '#fff', 1, ?1, ?1)",
  ).run(date);
  db.query(
    "INSERT INTO issues VALUES ('legacy-i1', 'legacy-t1', 1, 'Legacy issue', 'legacy-s1', 'legacy-a1', ?1, ?1)",
  ).run(date);
  db.query(
    "INSERT INTO activity VALUES ('legacy-ac1', 'legacy-i1', 'legacy-a1', 'created', '{\"title\":\"Legacy issue\"}', ?1)",
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
      expect(events.find((event) => event.eventId === "ac1")?.payload.issue_id).toBe("i1");
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

  it("rejects an Activity Actor that belongs only to another Workspace", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-cross-actor-"));
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
        "INSERT INTO activity(id, workspace_id, issue_id, actor_id, type, payload, created_at) VALUES ('cross-actor', 'w1', 'i1', 'a2', 'updated', '{}', '2025-01-01T00:00:00.000Z')",
      ).run();

      const result = importSqliteHistory({ db, rootDir: root, workspaceId: "w1" });
      expect(result.warnings).toContain("orphaned:activity:cross-actor");
      expect(readEventLog(root).some((event) => event.eventId === "cross-actor")).toBe(false);
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

  it("imports a pre-workspace_id singleton schema using its only Workspace", () => {
    const db = legacySingletonDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-legacy-"));
    try {
      const result = importSqliteHistory({ db, rootDir: root });
      expect(result).toMatchObject({
        status: "completed",
        multipleWorkspaces: false,
        workspaceId: "legacy-w1",
        orphaned: 0,
        rejected: 0,
      });
      const events = readEventLog(root);
      expect(events).toHaveLength(6);
      expect(events.find((event) => event.eventId === "legacy-ac1")).toMatchObject({
        aggregateKey: "LEG-1",
        workspaceId: "legacy-w1",
        payload: { issue_id: "legacy-i1" },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves deep parent scopes independently of row insertion order", () => {
    const db = new Database(":memory:");
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-deep-scope-"));
    try {
      db.exec(`
        CREATE TABLE workspace (id TEXT PRIMARY KEY, created_at TEXT);
        CREATE TABLE teams (id TEXT PRIMARY KEY, default_state_id TEXT, key TEXT, name TEXT, created_at TEXT);
        CREATE TABLE workflow_states (id TEXT PRIMARY KEY, workspace_id TEXT, team_id TEXT, name TEXT, type TEXT, created_at TEXT);
      `);
      db.query("INSERT INTO workspace VALUES ('w1', ?1)").run("2025-01-01T00:00:00.000Z");
      db.query(
        "INSERT INTO workflow_states VALUES ('state-0', 'w1', 'team-0', 'Root', 'unstarted', ?1)",
      ).run("2025-01-01T00:00:00.000Z");
      db.query("INSERT INTO teams VALUES ('team-0', 'state-0', 'D0', 'Deep 0', ?1)").run(
        "2025-01-01T00:00:00.000Z",
      );
      const depth = 6;
      for (let index = depth; index >= 1; index -= 1) {
        db.query("INSERT INTO teams VALUES (?1, ?2, ?3, ?4, ?5)").run(
          `team-${index}`,
          `state-${index - 1}`,
          `D${index}`,
          `Deep ${index}`,
          "2025-01-01T00:00:00.000Z",
        );
        db.query("INSERT INTO workflow_states VALUES (?1, NULL, ?2, ?3, 'unstarted', ?4)").run(
          `state-${index}`,
          `team-${index}`,
          `State ${index}`,
          "2025-01-01T00:00:00.000Z",
        );
      }

      const result = importSqliteHistory({ db, rootDir: root });
      expect(result).toMatchObject({ multipleWorkspaces: false, orphaned: 0, rejected: 0 });
      expect(result.tables.teams).toMatchObject({ scanned: depth + 1, emitted: depth + 1 });
      expect(result.tables.workflow_states).toMatchObject({
        scanned: depth + 1,
        emitted: depth + 1,
      });
      expect(
        readEventLog(root)
          .filter((event) => event.aggregate === "team" || event.aggregate === "workflow_state")
          .every((event) => event.workspaceId === "w1"),
      ).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing FK rows and tables as orphaned", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-orphans-"));
    try {
      db.query("DELETE FROM workflow_states WHERE id = 's1'").run();
      const result = importSqliteHistory({ db, rootDir: root, dryRun: true });
      expect(result.orphaned).toBeGreaterThan(0);
      expect(result.warnings.some((warning) => warning.includes("orphaned:issues:i1"))).toBe(true);

      const missingDb = sourceDatabase();
      try {
        missingDb.query("DROP TABLE workflow_states").run();
        const missingTable = importSqliteHistory({ db: missingDb, rootDir: root, dryRun: true });
        expect(missingTable.orphaned).toBeGreaterThan(0);
        expect(
          missingTable.warnings.some((warning) => warning.includes("orphaned:issues:i1")),
        ).toBe(true);
      } finally {
        missingDb.close();
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate source IDs instead of selecting one Workspace row", () => {
    const db = new Database(":memory:");
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-duplicate-"));
    try {
      db.exec(`
        CREATE TABLE workspace (id TEXT PRIMARY KEY);
        CREATE TABLE actors (id TEXT PRIMARY KEY, name TEXT, type TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE teams (workspace_id TEXT, id TEXT, key TEXT, name TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE workflow_states (workspace_id TEXT, id TEXT, team_id TEXT, name TEXT, type TEXT, color TEXT, position REAL, created_at TEXT, updated_at TEXT);
        CREATE TABLE issues (workspace_id TEXT, id TEXT, team_id TEXT, number INTEGER, title TEXT, state_id TEXT, creator_id TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE activity (workspace_id TEXT, id TEXT, issue_id TEXT, actor_id TEXT, type TEXT, payload TEXT, created_at TEXT);
      `);
      db.query("INSERT INTO workspace VALUES ('w1'), ('w2')").run();
      db.query("INSERT INTO actors VALUES ('a1', 'Author', 'agent', ?1, ?1)").run(
        "2025-01-01T00:00:00.000Z",
      );
      db.query("INSERT INTO teams VALUES ('w1', 't1', 'ONE', 'One', ?1, ?1)").run(
        "2025-01-01T00:00:00.000Z",
      );
      db.query("INSERT INTO teams VALUES ('w2', 't2', 'TWO', 'Two', ?1, ?1)").run(
        "2025-01-01T00:00:00.000Z",
      );
      db.query(
        "INSERT INTO workflow_states VALUES ('w1', 's1', 't1', 'Todo', 'unstarted', '#fff', 1, ?1, ?1), ('w2', 's2', 't2', 'Todo', 'unstarted', '#fff', 1, ?1, ?1)",
      ).run("2025-01-01T00:00:00.000Z");
      db.query(
        "INSERT INTO issues VALUES ('w1', 'duplicate', 't1', 1, 'One', 's1', 'a1', ?1, ?1), ('w2', 'duplicate', 't2', 1, 'Two', 's2', 'a1', ?1, ?1)",
      ).run("2025-01-01T00:00:00.000Z");
      const result = importSqliteHistory({ db, rootDir: root, workspaceId: "w1" });
      expect(result.ambiguous).toBeGreaterThan(0);
      expect(
        result.warnings.some((warning) => warning.includes("ambiguous:issues:duplicate")),
      ).toBe(true);
      expect(readEventLog(root).some((event) => event.eventId === "sqlite:issues:duplicate")).toBe(
        false,
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a missing actors.suspended_by row as orphaned", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-suspended-by-"));
    try {
      db.exec("ALTER TABLE actors ADD COLUMN suspended_by TEXT");
      db.query("UPDATE actors SET suspended_by = 'missing-actor' WHERE id = 'a1'").run();
      const result = importSqliteHistory({ db, rootDir: root, dryRun: true });
      expect(result.tables.actors).toMatchObject({ scanned: 1, orphaned: 1, emitted: 0 });
      expect(result.warnings).toContain("orphaned:actors:a1");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sensitive snapshot fields before writing their values", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-payload-"));
    try {
      db.exec("ALTER TABLE comments ADD COLUMN token_hash TEXT");
      db.query("UPDATE comments SET token_hash = 'fixture-value'").run();
      const result = importSqliteHistory({ db, rootDir: root });
      expect(result.tables.comments).toMatchObject({ rejected: 1, emitted: 0 });
      expect(result.warnings.some((warning) => warning.includes("fixture-value"))).toBe(false);
      const log = readFileSync(join(root, ".prime-board/log/events.jsonl"), "utf8");
      expect(log).not.toContain("fixture-value");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a multi-Workspace FK target has unknown scope", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-unknown-scope-"));
    try {
      db.query(
        "INSERT INTO workspace VALUES ('w2', 'Other', 'other', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query("UPDATE workflow_states SET workspace_id = NULL WHERE id = 's1'").run();
      const result = importSqliteHistory({ db, rootDir: root, workspaceId: "w1" });
      expect(result.orphaned).toBeGreaterThan(0);
      expect(result.warnings.some((warning) => warning.includes("orphaned:issues:i1"))).toBe(true);
      expect(readEventLog(root).some((event) => event.eventId === "sqlite:issues:i1")).toBe(false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves case variants and quotes physical sensitive table names", () => {
    const db = new Database(":memory:");
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-table-resolution-"));
    try {
      db.exec(`
        CREATE TABLE "WORKSPACE" ("ID" TEXT PRIMARY KEY, name TEXT, created_at TEXT);
        CREATE TABLE actors (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
        CREATE TABLE "GRANTS;not-a-query" (id TEXT, token TEXT);
      `);
      db.query("INSERT INTO WORKSPACE VALUES ('w1', 'Workspace', ?1)").run(
        "2025-01-01T00:00:00.000Z",
      );
      db.query("INSERT INTO actors VALUES ('a1', 'Actor', ?1)").run("2025-01-01T00:00:00.000Z");
      db.query("INSERT INTO \"GRANTS;not-a-query\" VALUES ('grant-unsafe', 'fixture-value')").run();

      const result = importSqliteHistory({ db, rootDir: root });
      expect(result.tables.workspace).toMatchObject({
        canonicalName: "workspace",
        physicalName: "WORKSPACE",
      });
      expect(result.tables["GRANTS;not-a-query"]).toMatchObject({
        canonicalName: "GRANTS;not-a-query",
        physicalName: "GRANTS;not-a-query",
        scanned: 1,
        excluded: 1,
      });
      expect(
        readEventLog(root).find((event) => event.eventId === "sqlite:workspace:w1")?.payload,
      ).toMatchObject({ sourceTable: "workspace" });
      expect(readFileSync(join(root, ".prime-board/log/events.jsonl"), "utf8")).not.toContain(
        "fixture-value",
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes case-insensitive scope columns before validating references", () => {
    const db = new Database(":memory:");
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-column-resolution-"));
    try {
      db.exec(`
        CREATE TABLE workspace (id TEXT PRIMARY KEY, created_at TEXT);
        CREATE TABLE actors (id TEXT PRIMARY KEY, created_at TEXT);
        CREATE TABLE workspace_memberships (id TEXT PRIMARY KEY, workspace_id TEXT, actor_id TEXT);
        CREATE TABLE teams (id TEXT, "WORKSPACE_ID" TEXT);
        CREATE TABLE issues (id TEXT, "WORKSPACE_ID" TEXT);
        CREATE TABLE activity (id TEXT, "WORKSPACE_ID" TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY, "WORKSPACE_ID" TEXT, lead_id TEXT, created_at TEXT);
      `);
      db.query("INSERT INTO workspace VALUES ('w1', ?1), ('w2', ?1)").run(
        "2025-01-01T00:00:00.000Z",
      );
      db.query("INSERT INTO actors VALUES ('a1', ?1)").run("2025-01-01T00:00:00.000Z");
      db.query("INSERT INTO workspace_memberships VALUES ('membership-1', 'w1', 'a1')").run();
      db.query("INSERT INTO projects VALUES ('p2', 'w2', 'a1', ?1)").run(
        "2025-01-01T00:00:00.000Z",
      );

      const result = importSqliteHistory({ db, rootDir: root, workspaceId: "w1" });
      expect(result.tables.projects).toMatchObject({ scanned: 1, orphaned: 1, emitted: 0 });
      expect(result.warnings).toContain("orphaned:projects:p2");
      expect(readEventLog(root).some((event) => event.eventId === "sqlite:projects:p2")).toBe(
        false,
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts a malformed case-fold collision in the global rejected total", () => {
    const db = new Database(":memory:");
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-malformed-global-"));
    try {
      db.exec(`
        CREATE TABLE "WORKSPACE" ("ID" TEXT PRIMARY KEY, created_at TEXT);
        CREATE TABLE actors ("İD" TEXT, "i̇d" TEXT, created_at TEXT);
      `);
      db.query('INSERT INTO "WORKSPACE" ("ID", created_at) VALUES (?1, ?2)').run(
        "w1",
        "2025-01-01T00:00:00.000Z",
      );
      db.query("INSERT INTO actors VALUES (?1, ?2, ?3)").run(
        "actor-a",
        "actor-b",
        "2025-01-01T00:00:00.000Z",
      );

      const result = importSqliteHistory({ db, rootDir: root, dryRun: true });
      expect(result).toMatchObject({ scanned: 2, emitted: 1, rejected: 1 });
      expect(result.tables.actors).toMatchObject({ scanned: 1, emitted: 0, rejected: 1 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts sensitive table variants without reading them into the Log", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-sensitive-"));
    try {
      db.exec('CREATE TABLE "GRANTS" (id TEXT PRIMARY KEY, token_hash TEXT, created_at TEXT)');
      db.query("INSERT INTO GRANTS VALUES ('grant-1', 'fixture-value', ?1)").run(
        "2025-01-01T00:00:00.000Z",
      );
      const result = importSqliteHistory({ db, rootDir: root, dryRun: true });
      expect(result.tables.grants).toMatchObject({
        canonicalName: "grants",
        physicalName: "GRANTS",
        scanned: 1,
        excluded: 1,
      });
      expect(result.warnings.some((warning) => warning.includes("fixture-value"))).toBe(false);
      expect(result.emitted).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when Membership metadata is Unicode-ambiguous in dry-run and apply", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-membership-ambiguous-"));
    try {
      db.query(
        "INSERT INTO workspace VALUES ('w2', 'Other', 'other', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query("UPDATE workspace_memberships SET workspace_id = 'w2' WHERE id = 'wm1'").run();
      db.exec(
        'ALTER TABLE workspace_memberships ADD COLUMN "İD" TEXT; ALTER TABLE workspace_memberships ADD COLUMN "i̇d" TEXT;',
      );

      const dry = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        dryRun: true,
        includeSnapshots: false,
      });
      expect(dry).toMatchObject({ emitted: 0, written: 0, rejected: 1 });
      expect(dry.ambiguous).toBeGreaterThan(0);
      expect(dry.tables.workspace_memberships).toMatchObject({ rejected: 1 });
      expect(dry.tables.activity).toMatchObject({ emitted: 0, ambiguous: 1 });
      expect(dry.warnings).toContain("ambiguous:activity:ac1");
      expect(existsSync(join(root, ".prime-board", "log", "events.jsonl"))).toBe(false);

      const applied = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        includeSnapshots: false,
      });
      expect(applied).toMatchObject({ emitted: 0, written: 0, rejected: 1 });
      expect(applied.ambiguous).toBeGreaterThan(0);
      expect(readEventLog(root).some((event) => event.eventId === "ac1")).toBe(false);
      expect(existsSync(join(root, ".prime-board", "log", "events.jsonl"))).toBe(false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts legitimate uppercase Membership columns", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-membership-uppercase-"));
    try {
      db.query(
        "INSERT INTO workspace VALUES ('w2', 'Other', 'other', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.exec(
        'ALTER TABLE workspace_memberships RENAME COLUMN id TO "ID"; ALTER TABLE workspace_memberships RENAME COLUMN workspace_id TO "WORKSPACE_ID"; ALTER TABLE workspace_memberships RENAME COLUMN actor_id TO "ACTOR_ID";',
      );
      const result = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        dryRun: true,
        includeSnapshots: false,
      });
      expect(result).toMatchObject({ emitted: 1, ambiguous: 0, rejected: 0 });
      expect(result.tables.activity).toMatchObject({ emitted: 1, ambiguous: 0 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps singleton Activity import when the Membership table is absent", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-membership-missing-"));
    try {
      db.exec("DROP TABLE workspace_memberships");
      const result = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        dryRun: true,
        includeSnapshots: false,
      });
      expect(result).toMatchObject({ emitted: 1, ambiguous: 0, rejected: 0 });
      expect(result.tables.activity).toMatchObject({ emitted: 1, ambiguous: 0 });
      expect(existsSync(join(root, ".prime-board", "log", "events.jsonl"))).toBe(false);

      const applied = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        includeSnapshots: false,
      });
      expect(applied).toMatchObject({ emitted: 1, written: 1 });
      expect(readEventLog(root).some((event) => event.eventId === "ac1")).toBe(true);

      const repeated = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        includeSnapshots: false,
      });
      expect(repeated).toMatchObject({ emitted: 0, written: 0, duplicates: 1 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects every Actor-dependent history family when the Actor has no Membership", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-membership-actor-absent-"));
    try {
      db.query(
        "INSERT INTO workspace VALUES ('w2', 'Other', 'other', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.query(
        "INSERT INTO actors VALUES ('a2', 'Unmapped', 'agent', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.exec("ALTER TABLE actors ADD COLUMN suspended_by TEXT");
      db.exec("ALTER TABLE actors ADD COLUMN workspace_id TEXT");
      db.exec("ALTER TABLE projects ADD COLUMN lead_id TEXT");
      db.exec("ALTER TABLE initiatives ADD COLUMN owner_id TEXT");
      db.query("UPDATE actors SET suspended_by = 'a1', workspace_id = 'w1' WHERE id = 'a2'").run();
      db.query("UPDATE projects SET lead_id = 'a2' WHERE id = 'p1'").run();
      db.query("UPDATE issues SET creator_id = 'a2' WHERE id = 'i1'").run();
      db.query("UPDATE comments SET actor_id = 'a2' WHERE id = 'cm1'").run();
      db.query("UPDATE activity SET actor_id = 'a2' WHERE id = 'ac1'").run();
      db.query("UPDATE team_memberships SET actor_id = 'a2' WHERE id = 'tm1'").run();
      db.query("UPDATE initiatives SET owner_id = 'a2' WHERE id = 'n1'").run();
      db.query("UPDATE project_updates SET author_id = 'a2' WHERE id = 'u1'").run();
      db.query("UPDATE reviews SET requester_id = 'a2', reviewer_id = 'a2' WHERE id = 'rv1'").run();
      db.query("UPDATE issue_subscribers SET actor_id = 'a2' WHERE issue_id = 'i1'").run();
      db.query("UPDATE saved_views SET owner_id = 'a2' WHERE id = 'v1'").run();

      const missingActorRows = [
        ["activity", "ac1"],
        ["actors", "a2"],
        ["projects", "p1"],
        ["issues", "i1"],
        ["comments", "cm1"],
        ["team_memberships", "tm1"],
        ["initiatives", "n1"],
        ["project_updates", "u1"],
        ["reviews", "rv1"],
        ["issue_subscribers", JSON.stringify(["i1", "a2"])],
        ["saved_views", "v1"],
      ] as const;

      const dry = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        dryRun: true,
        includeSnapshots: true,
      });
      expect(dry.multipleWorkspaces).toBe(true);
      expect(dry.emitted).toBeGreaterThan(0);
      for (const [table] of missingActorRows) {
        expect(dry.tables[table]?.orphaned).toBeGreaterThanOrEqual(1);
      }
      expect(dry.warnings).toContain("orphaned:activity:ac1");
      expect(existsSync(join(root, ".prime-board", "log", "events.jsonl"))).toBe(false);

      const applied = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        includeSnapshots: true,
      });
      expect(applied.written).toBeGreaterThan(0);
      for (const [table] of missingActorRows) {
        expect(applied.tables[table]?.orphaned).toBeGreaterThanOrEqual(1);
      }
      const eventIds = readEventLog(root).map((event) => event.eventId);
      for (const [table, id] of missingActorRows) {
        const eventId = table === "activity" ? id : `sqlite:${table}:${id}`;
        expect(eventIds).not.toContain(eventId);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Activity Actor when Membership metadata is missing in a multi-Workspace source", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-membership-multi-missing-"));
    try {
      db.query(
        "INSERT INTO workspace VALUES ('w2', 'Other', 'other', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.exec("DROP TABLE workspace_memberships");

      const dry = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        dryRun: true,
        includeSnapshots: false,
      });
      expect(dry).toMatchObject({ emitted: 0, written: 0 });
      expect(dry.tables.activity).toMatchObject({ emitted: 0, ambiguous: 1 });
      expect(dry.warnings).toContain("ambiguous:activity:ac1");
      expect(existsSync(join(root, ".prime-board", "log", "events.jsonl"))).toBe(false);

      const applied = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        includeSnapshots: false,
      });
      expect(applied).toMatchObject({ emitted: 0, written: 0 });
      expect(applied.tables.activity).toMatchObject({ emitted: 0, ambiguous: 1 });
      expect(applied.warnings).toContain("ambiguous:activity:ac1");
      expect(readEventLog(root).some((event) => event.eventId === "ac1")).toBe(false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Activity Actor when Membership columns are missing in a multi-Workspace source", () => {
    const db = sourceDatabase();
    const root = mkdtempSync(join(tmpdir(), "pb-sqlite-history-membership-columns-missing-"));
    try {
      db.query(
        "INSERT INTO workspace VALUES ('w2', 'Other', 'other', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')",
      ).run();
      db.exec("DROP TABLE workspace_memberships");
      db.exec("CREATE TABLE workspace_memberships (id TEXT PRIMARY KEY, role TEXT)");
      db.query("INSERT INTO workspace_memberships VALUES ('wm-missing-columns', 'admin')").run();

      const dry = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        dryRun: true,
        includeSnapshots: false,
      });
      expect(dry).toMatchObject({ emitted: 0, written: 0 });
      expect(dry.tables.activity).toMatchObject({ emitted: 0, ambiguous: 1 });
      expect(dry.warnings).toContain("ambiguous:activity:ac1");
      expect(existsSync(join(root, ".prime-board", "log", "events.jsonl"))).toBe(false);

      const applied = importSqliteHistory({
        db,
        rootDir: root,
        workspaceId: "w1",
        includeSnapshots: false,
      });
      expect(applied).toMatchObject({ emitted: 0, written: 0 });
      expect(applied.tables.activity).toMatchObject({ emitted: 0, ambiguous: 1 });
      expect(applied.warnings).toContain("ambiguous:activity:ac1");
      expect(readEventLog(root).some((event) => event.eventId === "ac1")).toBe(false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

expect(SQLITE_HISTORY_TABLES.length).toBeGreaterThan(0);
expect(SQLITE_HISTORY_EXCLUDED_TABLES).toContain("favorites");
