import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteBackup,
  createSqliteBackupIfPresent,
  readSqliteBackup,
  restoreSqliteBackup,
} from "../src/backup.ts";

function fixture(): { root: string; project: string; database: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), "prime-board-backup-"));
  const project = join(root, "project");
  const database = join(root, "state", "board.sqlite");
  const output = join(root, "backups", "board.sqlite");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "backups"), { recursive: true });
  return { root, project, database, output };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function createDatabase(path: string, projectValue: string): Database {
  const database = new Database(path);
  database.exec(
    `PRAGMA journal_mode = WAL;
     PRAGMA wal_autocheckpoint = 0;
     CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
     INSERT INTO records (value) VALUES ('${projectValue}');`,
  );
  return database;
}

function rows(path: string): unknown[] {
  const database = new Database(path, { readonly: true });
  try {
    return database.query("SELECT value FROM records ORDER BY id").all();
  } finally {
    database.close();
  }
}

function checksum(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("SQLite runtime backups", () => {
  test("creates a consistent image without copying WAL sidecars", () => {
    const { project, database, output } = fixture();
    const writer = createDatabase(database, "committed");
    writer.exec("BEGIN; INSERT INTO records (value) VALUES ('uncommitted');");
    chmodSync(database, 0o644);

    try {
      const backup = createSqliteBackup({
        databasePath: database,
        projectRoot: project,
        destination: output,
      });

      expect(backup.manifest.consistency).toBe("sqlite-vacuum-into");
      expect(backup.manifest.databasePath).toBe(database);
      expect(backup.manifest.schemaVersion).toBe(0);
      expect(backup.manifest.sourceWalPresent).toBe(true);
      expect(backup.manifest.sourceShmPresent).toBe(true);
      expect(mode(database)).toBe(0o600);
      expect(mode(output)).toBe(0o600);
      expect(mode(`${output}.json`)).toBe(0o600);
      expect(existsSync(`${output}-wal`)).toBe(false);
      expect(existsSync(`${output}-shm`)).toBe(false);
      expect(rows(output)).toEqual([{ value: "committed" }]);
      expect(readSqliteBackup(output).manifest.databaseSha256).toBe(checksum(output));
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  test("restores a verified backup and keeps the target on checksum failure", () => {
    const { project, database, output } = fixture();
    const writer = createDatabase(database, "before-update");
    writer.close();
    createSqliteBackup({ databasePath: database, projectRoot: project, destination: output });

    const changed = new Database(database);
    changed.exec("INSERT INTO records (value) VALUES ('after-update');");
    changed.close();
    expect(rows(database)).toEqual([{ value: "before-update" }, { value: "after-update" }]);

    const restored = restoreSqliteBackup({
      backupPath: output,
      databasePath: database,
      projectRoot: project,
      expectedDatabasePath: database,
    });
    expect(restored.databaseSha256).toBe(checksum(output));
    expect(rows(database)).toEqual([{ value: "before-update" }]);
    expect(mode(database)).toBe(0o600);
    expect(existsSync(`${database}-wal`)).toBe(false);
    expect(existsSync(`${database}-shm`)).toBe(false);

    const metadataPath = `${output}.json`;
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.databaseSha256 = "0".repeat(64);
    writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
    chmodSync(metadataPath, 0o600);
    expect(() =>
      restoreSqliteBackup({
        backupPath: output,
        databasePath: database,
        projectRoot: project,
        expectedDatabasePath: database,
      }),
    ).toThrow("checksum mismatch");
    expect(rows(database)).toEqual([{ value: "before-update" }]);
  });

  test("isolates project backups and rejects a backup from another project", () => {
    const root = mkdtempSync(join(tmpdir(), "prime-board-backup-projects-"));
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    const databaseA = join(root, "state", "a.sqlite");
    const databaseB = join(root, "state", "b.sqlite");
    const outputA = join(root, "backups", "a.sqlite");
    const outputB = join(root, "backups", "b.sqlite");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "backups"), { recursive: true });
    const writerA = createDatabase(databaseA, "project-a");
    writerA.close();
    const writerB = createDatabase(databaseB, "project-b");
    writerB.close();

    const backupA = createSqliteBackup({
      databasePath: databaseA,
      projectRoot: projectA,
      destination: outputA,
    });
    const backupB = createSqliteBackup({
      databasePath: databaseB,
      projectRoot: projectB,
      destination: outputB,
    });

    expect(backupA.manifest.projectHash).not.toBe(backupB.manifest.projectHash);
    expect(() =>
      restoreSqliteBackup({
        backupPath: outputB,
        databasePath: databaseA,
        projectRoot: projectA,
        expectedDatabasePath: databaseA,
      }),
    ).toThrow("another project");
    expect(rows(databaseA)).toEqual([{ value: "project-a" }]);
    expect(rows(databaseB)).toEqual([{ value: "project-b" }]);
    expect(() =>
      createSqliteBackup({
        databasePath: databaseA,
        projectRoot: projectA,
        destination: join(projectA, ".prime-board", "backup.sqlite"),
      }),
    ).toThrow("project replica");
  });

  test("returns no artifact for a new project database", () => {
    const { project, database } = fixture();
    expect(
      createSqliteBackupIfPresent({ databasePath: database, projectRoot: project }),
    ).toBeNull();
  });
});
