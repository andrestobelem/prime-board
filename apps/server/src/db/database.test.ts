// Tests de AT-131: migraciones, bootstrap idempotente y persistencia entre aperturas.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashApiKey } from "../auth/keys.ts";
import { migrate, openDatabase } from "./database.ts";
import { bootstrap, seedWorkspace } from "./seed.ts";
import migration0016 from "./migrations/0016_webhook_ownership.sql" with { type: "text" };

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "prime-board-test-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

/** Crea una copia mínima con el esquema legacy (migraciones 1–23). */
function sortedIdChecksum(db: Database, table: string): string {
  const ids = (db.query(`SELECT id FROM ${table} ORDER BY id`).values() as Array<[string]>)
    .map(([id]) => id)
    .join("\n");
  return createHash("sha256").update(ids).digest("hex");
}

function legacyDatabase(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(
    "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const filename of readdirSync(join(import.meta.dir, "migrations")).sort()) {
    const version = Number(filename.slice(0, 4));
    if (!Number.isInteger(version) || version > 23) continue;
    db.exec(readFileSync(join(import.meta.dir, "migrations", filename), "utf8"));
    db.query("INSERT INTO _migrations (version, name, applied_at) VALUES (?1, ?2, ?3)").run(
      version,
      filename,
      "2026-01-01T00:00:00.000Z",
    );
  }
  return db;
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
      "favorites",
      "actor_invitations",
      "workspace_memberships",
      "api_key_workspaces",
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

    const workspace = db.query("SELECT name, url_key FROM workspace").get() as {
      name: string;
      url_key: string;
    };
    expect(workspace).toEqual({ name: "workspace", url_key: "prime-board" });

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
    expect(db.query("SELECT is_default FROM api_key_workspaces").get()).toEqual({ is_default: 1 });
    db.close();
  });

  it("aplica la identidad configurada una sola vez", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    const created = bootstrap(first, {
      workspaceName: "Configured Workspace",
      workspaceUrlKey: "configured-workspace",
      teamName: "Configured Team",
      teamKey: "CFG",
    });
    expect(created.created).toBe(true);
    expect(first.query("SELECT name, url_key FROM workspace").get()).toEqual({
      name: "Configured Workspace",
      url_key: "configured-workspace",
    });
    expect(first.query("SELECT name, key FROM teams").get()).toEqual({
      name: "Configured Team",
      key: "CFG",
    });
    first.close();

    const second = openDatabase(path);
    expect(
      bootstrap(second, {
        workspaceName: "Changed Workspace",
        workspaceUrlKey: "changed-workspace",
        teamName: "Changed Team",
        teamKey: "CHG",
      }).created,
    ).toBe(false);
    expect(second.query("SELECT name, url_key FROM workspace").get()).toEqual({
      name: "Configured Workspace",
      url_key: "configured-workspace",
    });
    expect(second.query("SELECT name, key FROM teams").get()).toEqual({
      name: "Configured Team",
      key: "CFG",
    });
    second.close();
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

describe("multi-workspace root migration", () => {
  it("crea Workspace Memberships y backfillea el alcance de las tablas raíz", () => {
    const db = openDatabase(tempDbPath());
    bootstrap(db);

    const workspace = db.query("SELECT id FROM workspace").get() as { id: string };
    const actor = db.query("SELECT id FROM actors WHERE name = 'admin'").get() as { id: string };
    const tables = [
      "teams",
      "projects",
      "issues",
      "labels",
      "webhooks",
      "saved_views",
      "cycles",
      "reviews",
      "initiatives",
      "project_updates",
      "actor_invitations",
    ];

    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_memberships'",
        )
        .get(),
    ).toEqual({ name: "workspace_memberships" });
    expect(
      db
        .query(
          "SELECT role, status, workspace_id, actor_id, suspended_at, left_at FROM workspace_memberships",
        )
        .get(),
    ).toMatchObject({
      role: "admin",
      status: "active",
      workspace_id: workspace.id,
      actor_id: actor.id,
      suspended_at: null,
      left_at: null,
    });

    for (const table of tables) {
      const column = (
        db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).find((row) => row.name === "workspace_id");
      expect(column, table).toBeDefined();
      expect(
        (db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>).some(
          (row) => row.table === "workspace",
        ),
        table,
      ).toBe(true);
      const nullCount = db
        .query(`SELECT count(*) AS count FROM ${table} WHERE workspace_id IS NULL`)
        .get() as { count: number };
      expect(nullCount.count, table).toBe(0);
    }

    expect(
      db
        .query("SELECT count(*) AS count FROM workspace_memberships WHERE workspace_id = ?1")
        .get(workspace.id),
    ).toEqual({ count: 1 });
    db.close();
  });

  it("preserva IDs, fechas, relaciones y estados al migrar una base legacy", () => {
    const db = legacyDatabase();
    const timestamp = "2026-01-02T03:04:05.000Z";
    db.query(
      "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES ('workspace-legacy', 'Legacy', 'legacy', ?1, ?1)",
    ).run(timestamp);
    db.query(
      `INSERT INTO actors
       (id, name, type, workspace_role, status, suspended_at, suspended_by, created_at, updated_at)
       VALUES ('actor-legacy', 'legacy-admin', 'agent', 'admin', 'suspended', ?1, NULL, ?2, ?2)`,
    ).run(timestamp, timestamp);
    db.query(
      "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ('key-legacy', 'actor-legacy', 'Legacy key', 'legacy-key-hash', ?1)",
    ).run(timestamp);
    db.query(
      `INSERT INTO teams
       (id, name, key, description, next_issue_number, created_at, updated_at, default_state_id, archived_at, visibility, access_policy)
       VALUES ('team-legacy', 'Legacy Team', 'LEG', 'legacy', 2, ?1, ?1, NULL, NULL, 'public', 'team_members')`,
    ).run(timestamp);
    db.query(
      `INSERT INTO workflow_states
       (id, team_id, name, type, color, position, created_at, updated_at)
       VALUES ('state-legacy', 'team-legacy', 'Backlog', 'backlog', '#95a2b3', 0, ?1, ?1)`,
    ).run(timestamp);
    db.query("UPDATE teams SET default_state_id = 'state-legacy' WHERE id = 'team-legacy'").run();
    db.query(
      `INSERT INTO projects
       (id, name, description, state, lead_id, target_date, created_at, updated_at, archived_at)
       VALUES ('project-legacy', 'Legacy Project', 'description', 'started', 'actor-legacy', NULL, ?1, ?1, NULL)`,
    ).run(timestamp);
    db.query(
      "INSERT INTO project_teams (project_id, team_id) VALUES ('project-legacy', 'team-legacy')",
    ).run();
    db.query(
      `INSERT INTO cycles
       (id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at, archived_at)
       VALUES ('cycle-legacy', 'team-legacy', 1, 'Legacy Cycle', '2026-01-01', '2026-01-07', 'active', ?1, ?1, NULL)`,
    ).run(timestamp);
    db.query(
      `INSERT INTO issues
       (id, team_id, number, title, description, state_id, priority, assignee_id, parent_id, project_id,
        creator_id, sort_order, created_at, updated_at, archived_at, milestone_id, cycle_id)
       VALUES ('gap-legacy', 'team-legacy', 99, 'Gap Issue', 'deleted before migration', 'state-legacy', 2,
        'actor-legacy', NULL, 'project-legacy', 'actor-legacy', 0, ?1, ?1, NULL, NULL, 'cycle-legacy')`,
    ).run(timestamp);
    db.query(
      `INSERT INTO issues
       (id, team_id, number, title, description, state_id, priority, assignee_id, parent_id, project_id,
        creator_id, sort_order, created_at, updated_at, archived_at, milestone_id, cycle_id)
       VALUES ('issue-legacy', 'team-legacy', 1, 'Legacy Issue', 'description', 'state-legacy', 2,
        'actor-legacy', NULL, 'project-legacy', 'actor-legacy', 0, ?1, ?1, NULL, NULL, 'cycle-legacy')`,
    ).run(timestamp);
    db.query("DELETE FROM issues WHERE id = 'gap-legacy'").run();
    db.query(
      "INSERT INTO labels (id, name, color, team_id, created_at) VALUES ('label-legacy', 'legacy', '#000000', 'team-legacy', ?1)",
    ).run(timestamp);
    db.query(
      "INSERT INTO webhooks (id, url, secret, events, enabled, created_at, owner_id, team_id) VALUES ('webhook-legacy', 'https://example.test', 'secret', '[\"issue.created\"]', 1, ?1, 'actor-legacy', 'team-legacy')",
    ).run(timestamp);
    db.query(
      `INSERT INTO saved_views
       (id, name, scope, team_id, owner_id, filter_json, order_by, group_by, created_at, updated_at, archived_at, columns_json)
       VALUES ('view-legacy', 'Legacy View', 'team', 'team-legacy', 'actor-legacy', '{}', 'CREATED_DESC', 'state', ?1, ?1, NULL, '[]')`,
    ).run(timestamp);
    db.query(
      `INSERT INTO reviews
       (id, issue_id, requester_id, reviewer_id, status, created_at, updated_at)
       VALUES ('review-legacy', 'issue-legacy', 'actor-legacy', 'actor-legacy', 'requested', ?1, ?1)`,
    ).run(timestamp);
    db.query(
      `INSERT INTO initiatives
       (id, name, description, state, target_date, created_at, updated_at, archived_at, owner_id)
       VALUES ('initiative-legacy', 'Legacy Initiative', NULL, 'planned', NULL, ?1, ?1, NULL, 'actor-legacy')`,
    ).run(timestamp);
    db.query(
      `INSERT INTO project_updates
       (id, project_id, author_id, health, body, risks, created_at, updated_at)
       VALUES ('update-legacy', 'project-legacy', 'actor-legacy', 'on_track', 'body', NULL, ?1, ?1)`,
    ).run(timestamp);
    db.query(
      `INSERT INTO actor_invitations
       (id, email, name, type, token_hash, status, invited_by, actor_id, metadata_json, created_at, expires_at)
       VALUES ('invitation-legacy', 'legacy@example.test', 'Legacy', 'agent', 'hash-legacy', 'pending',
        'actor-legacy', NULL, '{}', ?1, '2026-02-01T00:00:00.000Z')`,
    ).run(timestamp);

    const rootTables = [
      "teams",
      "projects",
      "issues",
      "labels",
      "webhooks",
      "saved_views",
      "cycles",
      "reviews",
      "initiatives",
      "project_updates",
      "actor_invitations",
    ];
    const idChecksums = new Map(rootTables.map((table) => [table, sortedIdChecksum(db, table)]));
    const keyHash = (
      db.query("SELECT hash FROM api_keys WHERE id = 'key-legacy'").get() as {
        hash: string;
      }
    ).hash;

    migrate(db);

    for (const table of [
      "teams",
      "projects",
      "issues",
      "labels",
      "webhooks",
      "saved_views",
      "cycles",
      "reviews",
      "initiatives",
      "project_updates",
      "actor_invitations",
    ]) {
      expect(db.query(`SELECT workspace_id FROM ${table}`).get(), table).toEqual({
        workspace_id: "workspace-legacy",
      });
    }
    for (const table of rootTables) {
      expect(sortedIdChecksum(db, table), table).toBe(idChecksums.get(table)!);
    }
    expect(
      db
        .query(
          "SELECT issues.id FROM issues_fts JOIN issues ON issues.rowid = issues_fts.rowid WHERE issues_fts MATCH ?1",
        )
        .get("Legacy"),
    ).toEqual({ id: "issue-legacy" });
    expect(
      (db.query("SELECT hash FROM api_keys WHERE id = 'key-legacy'").get() as { hash: string })
        .hash,
    ).toBe(keyHash);

    const membership = db
      .query("SELECT id, role, status, suspended_at FROM workspace_memberships")
      .get() as { id: string; role: string; status: string; suspended_at: string };
    expect(membership).toMatchObject({
      role: "admin",
      status: "suspended",
      suspended_at: timestamp,
    });
    expect(membership.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual({ count: 26 });

    migrate(db);
    expect(db.query("SELECT count(*) AS count FROM workspace_memberships").get()).toEqual({
      count: 1,
    });
    db.close();
  });

  it("falla de forma atómica si una base legacy tiene varios Workspaces", () => {
    const db = legacyDatabase();
    db.query(
      "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES ('workspace-a', 'A', 'a', 'x', 'x'), ('workspace-b', 'B', 'b', 'x', 'x')",
    ).run();

    expect(() => migrate(db)).toThrow(/more than one Workspace/);
    expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual({ count: 23 });
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_memberships'",
        )
        .get(),
    ).toBeNull();
    expect(
      (db.query("PRAGMA table_info(teams)").all() as Array<{ name: string }>).some(
        (row) => row.name === "workspace_id",
      ),
    ).toBe(false);
    db.close();
  });
});

describe("API key Workspace grants and Workspace seed", () => {
  it("backfillea grants, límites e invitaciones sin cambiar hashes", () => {
    const db = legacyDatabase();
    const timestamp = "2026-01-02T03:04:05.000Z";
    db.query(
      "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES ('workspace-legacy', 'Legacy', 'legacy', ?1, ?1)",
    ).run(timestamp);
    db.query(
      `INSERT INTO actors
       (id, name, type, workspace_role, status, created_at, updated_at)
       VALUES ('actor-legacy', 'legacy-admin', 'agent', 'admin', 'active', ?1, ?1)`,
    ).run(timestamp);
    db.query(
      "INSERT INTO api_keys (id, actor_id, name, hash, created_at) VALUES ('key-legacy', 'actor-legacy', 'Legacy key', 'legacy-hash', ?1)",
    ).run(timestamp);
    db.query(
      "INSERT INTO teams (id, name, key, description, created_at, updated_at) VALUES ('team-legacy', 'Legacy', 'LEG', NULL, ?1, ?1)",
    ).run(timestamp);
    db.query(
      "INSERT INTO api_key_team_limits (api_key_id, team_id) VALUES ('key-legacy', 'team-legacy')",
    ).run();
    db.query(
      `INSERT INTO actor_invitations
       (id, email, name, type, token_hash, status, invited_by, metadata_json, created_at, expires_at)
       VALUES ('invitation-legacy', 'legacy@example.test', 'Legacy', 'agent', 'invitation-hash', 'pending', 'actor-legacy', '{}', ?1, '2027-01-01')`,
    ).run(timestamp);

    migrate(db);
    expect(db.query("SELECT workspace_id FROM api_key_workspaces").get()).toEqual({
      workspace_id: "workspace-legacy",
    });
    expect(db.query("SELECT is_default FROM api_key_workspaces").get()).toEqual({ is_default: 1 });
    expect(db.query("SELECT workspace_id FROM api_key_team_limits").get()).toEqual({
      workspace_id: "workspace-legacy",
    });
    expect(db.query("SELECT workspace_id FROM actor_invitations").get()).toEqual({
      workspace_id: "workspace-legacy",
    });
    expect(db.query("SELECT hash FROM api_keys").get()).toEqual({ hash: "legacy-hash" });
    migrate(db);
    expect(db.query("SELECT count(*) AS count FROM api_key_workspaces").get()).toEqual({
      count: 1,
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("siembra un Workspace adicional sin duplicar recursos del primero", () => {
    const db = openDatabase(tempDbPath());
    const first = bootstrap(db);
    const firstWorkspace = db.query("SELECT id FROM workspace").get() as { id: string };
    const firstTeam = db.query("SELECT id FROM teams").get() as { id: string };
    const firstActor = db.query("SELECT id FROM actors").get() as { id: string };
    const firstKeyCount = (
      db.query("SELECT count(*) AS count FROM api_keys").get() as { count: number }
    ).count;
    const firstKey = db.query("SELECT id FROM api_keys ORDER BY created_at, id LIMIT 1").get() as {
      id: string;
    };

    const second = seedWorkspace(db, {
      name: "Second Workspace",
      urlKey: "second-workspace",
      adminActorId: firstActor.id,
      apiKeyId: firstKey.id,
      teamKey: "PB",
    });
    expect(second.created).toBe(true);
    expect(second.workspaceId).not.toBe(firstWorkspace.id);
    expect(db.query("SELECT count(*) AS count FROM workspace").get()).toEqual({ count: 2 });
    expect(
      db
        .query("SELECT count(*) AS count FROM teams WHERE workspace_id = ?1")
        .get(firstWorkspace.id),
    ).toEqual({ count: 1 });
    expect(
      db
        .query("SELECT count(*) AS count FROM teams WHERE workspace_id = ?1")
        .get(second.workspaceId),
    ).toEqual({ count: 1 });
    expect(
      db
        .query("SELECT count(*) AS count FROM workflow_states WHERE team_id = ?1")
        .get(firstTeam.id),
    ).toEqual({ count: 5 });
    expect(
      db
        .query("SELECT count(*) AS count FROM workflow_states WHERE team_id = ?1")
        .get(second.teamId),
    ).toEqual({ count: 5 });
    expect(db.query("SELECT key FROM teams WHERE id = ?1").get(second.teamId)).toEqual({
      key: "PB",
    });
    expect(
      db
        .query(
          "SELECT count(*) AS count FROM workflow_states WHERE team_id = ?1 AND workspace_id = ?2",
        )
        .get(second.teamId, second.workspaceId),
    ).toEqual({ count: 5 });
    expect(
      db
        .query("SELECT workspace_id FROM team_memberships WHERE team_id = ?1 AND actor_id = ?2")
        .get(second.teamId, firstActor.id),
    ).toEqual({ workspace_id: second.workspaceId });
    expect(db.query("SELECT count(*) AS count FROM api_keys").get()).toEqual({
      count: firstKeyCount,
    });
    expect(
      db
        .query("SELECT count(*) AS count FROM api_key_workspaces WHERE workspace_id = ?1")
        .get(second.workspaceId),
    ).toEqual({ count: 1 });

    const repeat = seedWorkspace(db, {
      name: "Changed name is ignored",
      urlKey: "second-workspace",
      adminActorId: firstActor.id,
      teamKey: "PB",
    });
    expect(repeat.created).toBe(false);
    expect(db.query("SELECT count(*) AS count FROM workspace").get()).toEqual({ count: 2 });
    expect(db.query("SELECT count(*) AS count FROM teams").get()).toEqual({ count: 2 });
    expect(first.created).toBe(true);
    db.close();
  });
});

describe("Workspace-scoped Team Membership normalization", () => {
  it("backfills only Actor and Team pairs from the same Workspace", () => {
    const db = openDatabase(tempDbPath());
    bootstrap(db);
    const firstWorkspace = db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
    const actor = db.query("SELECT id FROM actors LIMIT 1").get() as { id: string };
    const second = seedWorkspace(db, {
      name: "Second Workspace",
      urlKey: "second-memberships",
      adminActorId: actor.id,
      teamKey: "PB",
    });

    db.query("DELETE FROM team_memberships").run();
    migrate(db);

    const memberships = db
      .query(
        "SELECT team_memberships.team_id, team_memberships.actor_id, team_memberships.workspace_id FROM team_memberships ORDER BY team_memberships.workspace_id",
      )
      .all();
    expect(memberships).toHaveLength(2);
    expect(
      db
        .query(
          "SELECT count(*) AS count FROM team_memberships WHERE workspace_id = ?1 AND team_id IN (SELECT id FROM teams WHERE workspace_id = ?1)",
        )
        .get(second.workspaceId),
    ).toEqual({ count: 1 });
    expect(
      db
        .query(
          "SELECT count(*) AS count FROM team_memberships WHERE workspace_id = ?1 AND team_id IN (SELECT id FROM teams WHERE workspace_id = ?1)",
        )
        .get(firstWorkspace.id),
    ).toEqual({ count: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
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

describe("Workspace constraint migration", () => {
  function scopedDatabase(): Database {
    const db = openDatabase(":memory:");
    const timestamp = "2026-01-01T00:00:00.000Z";
    db.query(
      "INSERT INTO workspace (id, name, url_key, created_at, updated_at) VALUES ('workspace-a', 'A', 'a', ?1, ?1), ('workspace-b', 'B', 'b', ?1, ?1)",
    ).run(timestamp);
    db.query(
      "INSERT INTO actors (id, name, type, created_at, updated_at) VALUES ('actor-a', 'A', 'agent', ?1, ?1), ('actor-b', 'B', 'agent', ?1, ?1)",
    ).run(timestamp);
    db.query(
      "INSERT INTO teams (id, name, key, workspace_id, created_at, updated_at) VALUES ('team-a', 'A', 'SAME', 'workspace-a', ?1, ?1), ('team-b', 'B', 'SAME', 'workspace-b', ?1, ?1)",
    ).run(timestamp);
    db.query(
      "INSERT INTO workflow_states (id, team_id, name, type, color, position, created_at, updated_at, workspace_id) VALUES ('state-a', 'team-a', 'Todo', 'unstarted', '#000', 0, ?1, ?1, 'workspace-a'), ('state-b', 'team-b', 'Todo', 'unstarted', '#000', 0, ?1, ?1, 'workspace-b')",
    ).run(timestamp);
    db.query(
      "INSERT INTO projects (id, name, state, workspace_id, created_at, updated_at) VALUES ('project-a', 'A', 'backlog', 'workspace-a', ?1, ?1), ('project-b', 'B', 'backlog', 'workspace-b', ?1, ?1)",
    ).run(timestamp);
    db.query(
      "INSERT INTO issues (id, team_id, number, title, state_id, creator_id, workspace_id, created_at, updated_at) VALUES ('issue-a', 'team-a', 1, 'A', 'state-a', 'actor-a', 'workspace-a', ?1, ?1), ('issue-b', 'team-b', 1, 'B', 'state-b', 'actor-b', 'workspace-b', ?1, ?1)",
    ).run(timestamp);
    return db;
  }

  it("permite keys/nombres iguales entre Workspaces y rechaza duplicados locales", () => {
    const db = scopedDatabase();
    const timestamp = "2026-01-01T00:00:00.000Z";
    expect(() =>
      db
        .query(
          "INSERT INTO teams (id, name, key, workspace_id, created_at, updated_at) VALUES ('team-a2', 'A2', 'SAME', 'workspace-a', ?1, ?1)",
        )
        .run(timestamp),
    ).toThrow();

    db.query(
      "INSERT INTO labels (id, name, color, workspace_id, created_at) VALUES ('label-a', 'same', '#000', 'workspace-a', ?1), ('label-b', 'same', '#000', 'workspace-b', ?1)",
    ).run(timestamp);
    expect(() =>
      db
        .query(
          "INSERT INTO labels (id, name, color, workspace_id, created_at) VALUES ('label-a2', 'same', '#000', 'workspace-a', ?1)",
        )
        .run(timestamp),
    ).toThrow();
    db.query(
      "INSERT INTO labels (id, name, color, team_id, workspace_id, created_at) VALUES ('team-label-a', 'same', '#000', 'team-a', 'workspace-a', ?1), ('team-label-b', 'same', '#000', 'team-b', 'workspace-b', ?1)",
    ).run(timestamp);
    expect(() =>
      db
        .query(
          "INSERT INTO labels (id, name, color, team_id, workspace_id, created_at) VALUES ('team-label-a2', 'same', '#000', 'team-a', 'workspace-a', ?1)",
        )
        .run(timestamp),
    ).toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("rechaza referencias cross-Workspace en links, Parents y relaciones", () => {
    const db = scopedDatabase();
    const timestamp = "2026-01-01T00:00:00.000Z";
    expect(() =>
      db
        .query(
          "INSERT INTO project_teams (project_id, team_id, workspace_id) VALUES ('project-a', 'team-b', 'workspace-a')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .query(
          "INSERT INTO issues (id, team_id, number, title, state_id, creator_id, parent_id, workspace_id, created_at, updated_at) VALUES ('issue-cross', 'team-a', 2, 'cross', 'state-a', 'actor-a', 'issue-b', 'workspace-a', ?1, ?1)",
        )
        .run(timestamp),
    ).toThrow();
    expect(() =>
      db
        .query(
          "INSERT INTO issue_relations (id, issue_id, related_id, type, workspace_id, created_at) VALUES ('relation-cross', 'issue-a', 'issue-b', 'related', 'workspace-a', ?1)",
        )
        .run(timestamp),
    ).toThrow();
    expect(() =>
      db
        .query(
          "INSERT INTO initiatives (id, name, state, workspace_id, created_at, updated_at) VALUES ('initiative-a', 'A', 'planned', 'workspace-a', ?1, ?1)",
        )
        .run(timestamp),
    ).not.toThrow();
    expect(() =>
      db
        .query(
          "INSERT INTO initiative_teams (initiative_id, team_id, workspace_id) VALUES ('initiative-a', 'team-b', 'workspace-a')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .query(
          "INSERT INTO project_updates (id, project_id, author_id, health, body, workspace_id, created_at, updated_at) VALUES ('update-cross', 'project-b', 'actor-a', 'on_track', 'cross', 'workspace-a', ?1, ?1)",
        )
        .run(timestamp),
    ).toThrow();
    db.query(
      "INSERT INTO labels (id, name, color, workspace_id, created_at) VALUES ('label-a', 'label', '#000', 'workspace-a', ?1), ('label-b', 'label', '#000', 'workspace-b', ?1)",
    ).run(timestamp);
    expect(() =>
      db
        .query(
          "INSERT INTO issue_labels (issue_id, label_id, workspace_id) VALUES ('issue-a', 'label-b', 'workspace-a')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .query(
          "INSERT INTO webhooks (id, url, secret, workspace_id, team_id, created_at) VALUES ('webhook-cross', 'https://example.test', 'secret', 'workspace-a', 'team-b', ?1)",
        )
        .run(timestamp),
    ).toThrow();
    expect(() =>
      db
        .query(
          "INSERT INTO teams (id, name, key, created_at, updated_at) VALUES ('team-unscoped', 'X', 'X', ?1, ?1)",
        )
        .run(timestamp),
    ).toThrow(/Workspace context is required/);
    db.close();
  });
});
