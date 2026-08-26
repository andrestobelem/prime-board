import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteBackup,
  createSqliteBackupIfPresent,
  readSqliteBackup,
  recoverSqliteRestore,
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

  test("rejects symlink parents and replica database paths", () => {
    const { root, project, database, output } = fixture();
    const linkedState = join(root, "state-link");
    const linkedBackups = join(root, "backups-link");
    symlinkSync(join(root, "state"), linkedState);
    symlinkSync(join(root, "backups"), linkedBackups);
    const databaseInLinkedParent = join(linkedState, "linked.sqlite");
    const outputInLinkedParent = join(linkedBackups, "linked.sqlite");
    const writer = createDatabase(database, "symlink-test");
    writer.close();

    expect(() =>
      createSqliteBackup({
        databasePath: databaseInLinkedParent,
        projectRoot: project,
        destination: output,
      }),
    ).toThrow("symbolic-link parent");
    expect(() =>
      createSqliteBackup({
        databasePath: database,
        projectRoot: project,
        destination: outputInLinkedParent,
      }),
    ).toThrow("symbolic-link parent");

    const otherProject = join(root, "other-project");
    const otherReplica = join(otherProject, ".prime-board");
    const replicaDatabase = join(otherReplica, "state.sqlite");
    mkdirSync(join(otherReplica, "meta"), { recursive: true });
    writeFileSync(replicaDatabase, "not sqlite");
    expect(() =>
      createSqliteBackup({
        databasePath: replicaDatabase,
        projectRoot: project,
        destination: output,
      }),
    ).toThrow("project replica");
  });

  test("recovers a restore left after database quarantine", () => {
    const { root, project, database, output } = fixture();
    const writer = createDatabase(database, "before-recovery");
    writer.close();
    createSqliteBackup({ databasePath: database, projectRoot: project, destination: output });

    const originalPath = `${database}.restore-original-test`;
    const stagedPath = `${database}.restore-staged-test`;
    const journalPath = `${database}.restore.json`;
    renameSync(database, originalPath);
    for (const suffix of ["-wal", "-shm"]) {
      const liveSidecar = `${database}${suffix}`;
      if (existsSync(liveSidecar)) renameSync(liveSidecar, `${originalPath}${suffix}`);
    }
    copyFileSync(output, stagedPath);
    chmodSync(stagedPath, 0o600);
    writeFileSync(
      journalPath,
      `${JSON.stringify(
        {
          version: 1,
          phase: "database-quarantined",
          databasePath: database,
          directory: join(root, "state"),
          stagedPath,
          originalPath,
          originalSidecars: {
            "-wal": `${originalPath}-wal`,
            "-shm": `${originalPath}-shm`,
          },
          backupPath: output,
          expectedSha256: readSqliteBackup(output).manifest.databaseSha256,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    recoverSqliteRestore(database);
    expect(rows(database)).toEqual([{ value: "before-recovery" }]);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(stagedPath)).toBe(false);
  });

  test("uses the package version and rejects a forged runtime version", () => {
    const { project, database, output } = fixture();
    const writer = createDatabase(database, "version-test");
    writer.close();
    expect(() =>
      createSqliteBackup({
        databasePath: database,
        projectRoot: project,
        destination: output,
        runtimeVersion: "9.9.9",
      }),
    ).toThrow("must match the package version");
  });

  test("rejects non-file WAL and SHM sidecars before backup", () => {
    const { project, database, output } = fixture();
    const writer = createDatabase(database, "sidecar-test");
    writer.close();
    rmSync(`${database}-wal`, { force: true });
    mkdirSync(`${database}-wal`);
    expect(() =>
      createSqliteBackup({ databasePath: database, projectRoot: project, destination: output }),
    ).toThrow("sidecar must be a regular file");
  });
});
