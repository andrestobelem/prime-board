import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { migrate, openDatabase } from "./database.ts";
import { bootstrap } from "./seed.ts";

function databaseWithMigrationsThrough(versionLimit: number): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    "CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );

  const migrationDirectory = join(import.meta.dir, "migrations");
  for (const filename of readdirSync(migrationDirectory).sort()) {
    const version = Number(filename.slice(0, 4));
    if (!Number.isInteger(version) || version > versionLimit) continue;
    if (version === 25) db.exec("PRAGMA foreign_keys = OFF");
    db.exec(readFileSync(join(migrationDirectory, filename), "utf8"));
    if (version === 25) db.exec("PRAGMA foreign_keys = ON");
    const name = version === 32 ? "notification_preferences" : filename.slice(5, -4);
    db.query("INSERT INTO _migrations (version, name, applied_at) VALUES (?1, ?2, ?3)").run(
      version,
      name,
      "2026-01-01T00:00:00.000Z",
    );
  }
  return db;
}

function seedLegacyNotificationAndViewData(db: Database): void {
  bootstrap(db);
  const workspace = db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
  const actor = db.query("SELECT id FROM actors LIMIT 1").get() as { id: string };
  const team = db.query("SELECT id FROM teams LIMIT 1").get() as { id: string };
  const timestamp = "2026-01-01T00:00:00.000Z";

  db.query(
    `INSERT INTO saved_views
      (id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
       created_at, updated_at, archived_at, columns_json, workspace_id)
     VALUES ('view-legacy', 'Legacy View', 'team', ?1, ?2, '{}', 'CREATED_DESC', 'state',
       ?3, ?3, NULL, '[]', ?4)`,
  ).run(team.id, actor.id, timestamp, workspace.id);
  db.query(
    `INSERT INTO favorites
      (id, actor_id, project_id, saved_view_id, position, created_at, workspace_id)
     VALUES ('favorite-legacy', ?1, NULL, 'view-legacy', 0, ?2, ?3)`,
  ).run(actor.id, timestamp, workspace.id);
  db.query(
    `INSERT INTO notification_preferences
      (workspace_id, actor_id, category, channel, enabled, email_delivery, created_at, updated_at)
     VALUES (?1, ?2, 'mentions', 'email', 1, 'immediate', ?3, ?3)`,
  ).run(workspace.id, actor.id, timestamp);
}

describe("colisión de migraciones SQLite", () => {
  it("aplica Notifications y Views con versiones, tablas e índices únicos", () => {
    const db = openDatabase(":memory:");
    try {
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual({ count: 32 });
      expect(
        db
          .query("SELECT version, name FROM _migrations WHERE version >= 32 ORDER BY version")
          .all(),
      ).toEqual([
        { version: 32, name: "notification_preferences" },
        { version: 33, name: "views_preferences" },
      ]);
      const versions = (
        db.query("SELECT version FROM _migrations ORDER BY version").values() as Array<[number]>
      ).map(([version]) => version);
      expect(new Set(versions).size).toBe(versions.length);
      expect(versions).toEqual([...versions].sort((left, right) => left - right));

      for (const table of ["notification_preferences", "view_preferences", "view_subscriptions"]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table),
        ).toEqual({ name: table });
      }
      for (const index of [
        "idx_notification_preferences_actor_workspace",
        "idx_view_preferences_key",
        "idx_view_preferences_view",
        "idx_view_preferences_actor",
        "idx_view_subscriptions_view",
        "idx_view_subscriptions_actor",
      ]) {
        expect(
          db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1").get(index),
        ).toEqual({ name: index });
      }
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("actualiza una base con Notifications 0032 sin perder Views, favoritos ni preferencias", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      const beforeView = db
        .query(
          `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                  created_at, updated_at, archived_at, columns_json, workspace_id
           FROM saved_views WHERE id = 'view-legacy'`,
        )
        .get();
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get();
      const beforeNotification = db
        .query("SELECT * FROM notification_preferences WHERE category = 'mentions'")
        .get();

      migrate(db);

      expect(db.query("SELECT name FROM _migrations WHERE version = 32").get()).toEqual({
        name: "notification_preferences",
      });
      expect(db.query("SELECT name FROM _migrations WHERE version = 33").get()).toEqual({
        name: "views_preferences",
      });
      expect(
        db
          .query(
            `SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by,
                    created_at, updated_at, archived_at, columns_json, workspace_id
             FROM saved_views WHERE id = 'view-legacy'`,
          )
          .get(),
      ).toEqual(beforeView);
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM notification_preferences WHERE category = 'mentions'").get(),
      ).toEqual(beforeNotification);
      expect(
        db
          .query("SELECT project_id, initiative_id FROM saved_views WHERE id = 'view-legacy'")
          .get(),
      ).toEqual({ project_id: null, initiative_id: null });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      const migrationCount = db.query("SELECT count(*) AS count FROM _migrations").get();
      migrate(db);
      expect(db.query("SELECT count(*) AS count FROM _migrations").get()).toEqual(migrationCount);
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
    } finally {
      db.close();
    }
  });

  it("revierte el rebuild de Views si falla y permite reintentar sin pérdida", () => {
    const db = databaseWithMigrationsThrough(32);
    try {
      seedLegacyNotificationAndViewData(db);
      const beforeView = db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get();
      const beforeFavorite = db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get();
      const beforeNotification = db
        .query("SELECT * FROM notification_preferences WHERE category = 'mentions'")
        .get();
      db.exec("CREATE INDEX idx_saved_views_project ON actors(name)");

      expect(() => migrate(db)).toThrow(/idx_saved_views_project/);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toBeNull();
      expect(
        db.query("SELECT name FROM sqlite_master WHERE name = '_prb390_saved_views'").get(),
      ).toBeNull();
      expect(db.query("SELECT * FROM saved_views WHERE id = 'view-legacy'").get()).toEqual(
        beforeView,
      );
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM notification_preferences WHERE category = 'mentions'").get(),
      ).toEqual(beforeNotification);
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

      db.exec("DROP INDEX idx_saved_views_project");
      migrate(db);
      expect(db.query("SELECT version FROM _migrations WHERE version = 33").get()).toEqual({
        version: 33,
      });
      expect(db.query("SELECT * FROM favorites WHERE id = 'favorite-legacy'").get()).toEqual(
        beforeFavorite,
      );
      expect(
        db.query("SELECT * FROM notification_preferences WHERE category = 'mentions'").get(),
      ).toEqual(beforeNotification);
    } finally {
      db.close();
    }
  });
});
