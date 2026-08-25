import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  chmodSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export const BACKUP_FORMAT = 1;
export const RUNTIME_VERSION = "0.1.0";

const DATABASE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

type BackupSidecar = (typeof SIDECAR_SUFFIXES)[number];

export interface BackupOptions {
  databasePath: string;
  projectRoot: string;
  /** Destination for the SQLite image. The metadata is written next to it. */
  destination?: string;
  runtimeVersion?: string;
  homeDirectory?: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  runtimeVersion: string;
  bunVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  projectRoot: string;
  projectHash: string;
  databasePath: string;
  backupPath: string;
  databaseSha256: string;
  databaseBytes: number;
  schemaVersion: number;
  journalMode: string;
  consistency: "sqlite-vacuum-into";
  sourceWalPresent: boolean;
  sourceShmPresent: boolean;
}

export interface BackupResult {
  backupPath: string;
  metadataPath: string;
  manifest: BackupManifest;
}

export interface RestoreOptions {
  backupPath: string;
  databasePath: string;
  projectRoot: string;
  /** Reject a backup produced for another database alias by default. */
  expectedDatabasePath?: string;
}

export interface RestoreResult {
  backupPath: string;
  databasePath: string;
  databaseSha256: string;
  previousDatabasePath: string | null;
}

interface DatabaseSnapshot {
  bytes: Buffer;
  schemaVersion: number;
  journalMode: string;
}

interface FileRecord {
  path: string;
  mode: number;
  isSymbolicLink: boolean;
  isFile: boolean;
  isDirectory: boolean;
}

function recordFile(path: string): FileRecord | null {
  try {
    const stats = lstatSync(path);
    return {
      path,
      mode: stats.mode & 0o777,
      isSymbolicLink: stats.isSymbolicLink(),
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
    };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const value = error.code;
  return value === code;
}

function assertAbsolutePath(path: string, label: string): string {
  if (!path || path === ":memory:" || path.includes("\0")) {
    throw new Error(`${label} must be a filesystem path`);
  }
  const resolvedPath = resolve(path);
  if (resolvedPath === sep) throw new Error(`${label} must name a file, not the filesystem root`);
  return resolvedPath;
}

function assertNoSymlink(path: string, label: string, allowMissing = true): FileRecord | null {
  const record = recordFile(path);
  if (!record) {
    if (!allowMissing) throw new Error(`${label} does not exist: ${path}`);
    return null;
  }
  if (record.isSymbolicLink) throw new Error(`${label} must not be a symbolic link: ${path}`);
  return record;
}

function assertDatabasePath(path: string, allowMissing: boolean): string {
  const databasePath = assertAbsolutePath(path, "Database path");
  const record = assertNoSymlink(databasePath, "Database", allowMissing);
  if (record && !record.isFile)
    throw new Error(`Database path must be a regular file: ${databasePath}`);
  for (const sidecar of SIDECAR_SUFFIXES) {
    const sidecarPath = `${databasePath}${sidecar}`;
    const sidecarRecord = recordFile(sidecarPath);
    if (sidecarRecord?.isSymbolicLink) {
      throw new Error(`Database sidecar must not be a symbolic link: ${sidecarPath}`);
    }
  }
  return databasePath;
}

function ensurePrivateFile(path: string, label: string): void {
  const record = assertNoSymlink(path, label, false);
  if (!record || !record.isFile) throw new Error(`${label} must be a regular file: ${path}`);
  chmodSync(path, DATABASE_MODE);
  const mode = statSync(path).mode & 0o777;
  if (mode !== DATABASE_MODE) throw new Error(`${label} must have mode 0600: ${path}`);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  const record = recordFile(path);
  if (!record || record.isSymbolicLink || !record.isDirectory) {
    throw new Error(`Backup directory must be a real directory: ${path}`);
  }
  chmodSync(path, DIRECTORY_MODE);
}

function isWithin(path: string, parent: string): boolean {
  const child = resolve(path);
  const root = resolve(parent);
  return child === root || child.startsWith(`${root}${sep}`);
}

function assertDestinationPath(
  databasePath: string,
  projectRoot: string,
  destination: string,
): string {
  const backupPath = assertAbsolutePath(destination, "Backup destination");
  if (
    backupPath === databasePath ||
    SIDECAR_SUFFIXES.some((suffix) => backupPath === `${databasePath}${suffix}`)
  ) {
    throw new Error("Backup destination must not be the live database or its WAL sidecar");
  }
  const replicaPath = join(projectRoot, ".prime-board");
  if (isWithin(backupPath, replicaPath)) {
    throw new Error("Backup destination must not be inside the project replica");
  }
  const existing = recordFile(backupPath);
  if (existing) throw new Error(`Backup destination already exists: ${backupPath}`);
  const metadata = recordFile(`${backupPath}.json`);
  if (metadata) throw new Error(`Backup metadata destination already exists: ${backupPath}.json`);
  return backupPath;
}

function projectHash(projectRoot: string): string {
  return createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 16);
}

function projectSlug(projectRoot: string): string {
  return (
    basename(resolve(projectRoot))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-") || "project"
  );
}

function generatedDestination(options: BackupOptions, now: Date = new Date()): string {
  const home = resolve(options.homeDirectory ?? homedir());
  const directory = join(
    home,
    ".prime-board",
    "backups",
    `${projectSlug(options.projectRoot)}-${projectHash(options.projectRoot)}`,
  );
  const timestamp = now.toISOString().replaceAll(/[-:.TZ]/g, "");
  return join(directory, `${timestamp}-${randomUUID()}.sqlite`);
}

function atomicWrite(path: string, data: Uint8Array, mode = DATABASE_MODE): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", mode);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, mode);
    // linkSync publishes without replacing a path that appeared after validation.
    // The temporary file is in the same directory, so this remains atomic. Some
    // Windows filesystems reject hard links, so use rename only for that case.
    try {
      linkSync(temporaryPath, path);
      rmSync(temporaryPath, { force: true });
    } catch (error) {
      if (!isErrno(error, "EPERM") && !isErrno(error, "EXDEV")) throw error;
      if (existsSync(path)) throw new Error(`Atomic destination already exists: ${path}`);
      renameSync(temporaryPath, path);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0)
    throw new Error(`Invalid backup metadata field: ${name}`);
  return field;
}

function numberField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`Invalid backup metadata field: ${name}`);
  }
  return field;
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  const field = value[name];
  if (typeof field !== "boolean") throw new Error(`Invalid backup metadata field: ${name}`);
  return field;
}

function readIntegrity(db: Database): void {
  const integrityRecord = objectRecord(db.query("PRAGMA integrity_check").get());
  if (integrityRecord?.integrity_check !== "ok") {
    throw new Error("SQLite integrity check failed");
  }
  if (db.query("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("SQLite foreign-key check failed");
  }
}

function readSchemaVersion(db: Database): number {
  const table = objectRecord(
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations'").get(),
  );
  if (!table) return 0;
  const row = objectRecord(
    db.query("SELECT COALESCE(MAX(version), 0) AS version FROM _migrations").get(),
  );
  const value = row?.version;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readJournalMode(db: Database): string {
  const row = objectRecord(db.query("PRAGMA journal_mode").get());
  const value = row?.journal_mode;
  if (typeof value !== "string" || value.length === 0)
    throw new Error("SQLite journal mode is unavailable");
  return value.toLowerCase();
}

function inspectSnapshot(bytes: Buffer): DatabaseSnapshot {
  if (bytes.byteLength < 100 || bytes.subarray(0, 16).toString("ascii") !== "SQLite format 3\x00") {
    throw new Error("SQLite backup did not produce a database image");
  }
  const db = Database.deserialize(bytes, { readonly: true, strict: true });
  try {
    readIntegrity(db);
    return { bytes, schemaVersion: readSchemaVersion(db), journalMode: readJournalMode(db) };
  } finally {
    db.close();
  }
}

function serializeDatabase(databasePath: string, temporaryPath: string): DatabaseSnapshot {
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    const journalMode = readJournalMode(db);
    db.run("VACUUM INTO ?", [temporaryPath]);
    chmodSync(temporaryPath, DATABASE_MODE);
    ensurePrivateFile(temporaryPath, "SQLite snapshot");
    const bytes = readFileSync(temporaryPath);
    const inspected = inspectSnapshot(bytes);
    return { ...inspected, journalMode };
  } finally {
    db.close();
    rmSync(temporaryPath, { force: true });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function metadataPathFor(backupPath: string): string {
  return `${backupPath}.json`;
}

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return (
    value === "aix" ||
    value === "android" ||
    value === "darwin" ||
    value === "freebsd" ||
    value === "haiku" ||
    value === "linux" ||
    value === "openbsd" ||
    value === "sunos" ||
    value === "win32"
  );
}

function parseManifest(value: unknown): BackupManifest {
  const record = objectRecord(value);
  if (!record || record.format !== BACKUP_FORMAT)
    throw new Error("Unsupported SQLite backup format");
  const consistency = record.consistency;
  if (consistency !== "sqlite-vacuum-into")
    throw new Error("Backup is not a SQLite VACUUM INTO snapshot");
  const platform = record.platform;
  if (!isNodePlatform(platform)) throw new Error("Invalid backup metadata field: platform");
  return {
    format: BACKUP_FORMAT,
    createdAt: stringField(record, "createdAt"),
    runtimeVersion: stringField(record, "runtimeVersion"),
    bunVersion: stringField(record, "bunVersion"),
    platform,
    architecture: stringField(record, "architecture"),
    projectRoot: stringField(record, "projectRoot"),
    projectHash: stringField(record, "projectHash"),
    databasePath: stringField(record, "databasePath"),
    backupPath: stringField(record, "backupPath"),
    databaseSha256: stringField(record, "databaseSha256"),
    databaseBytes: numberField(record, "databaseBytes"),
    schemaVersion: numberField(record, "schemaVersion"),
    journalMode: stringField(record, "journalMode"),
    consistency,
    sourceWalPresent: booleanField(record, "sourceWalPresent"),
    sourceShmPresent: booleanField(record, "sourceShmPresent"),
  };
}

function readBackup(backupPathInput: string): {
  path: string;
  manifest: BackupManifest;
  bytes: Buffer;
} {
  const backupPath = assertAbsolutePath(backupPathInput, "Backup path");
  const backupFile = assertNoSymlink(backupPath, "Backup", false);
  if (!backupFile || !backupFile.isFile)
    throw new Error(`Backup must be a regular file: ${backupPath}`);
  const metadataPath = metadataPathFor(backupPath);
  ensurePrivateFile(backupPath, "Backup");
  ensurePrivateFile(metadataPath, "Backup metadata");
  const metadata = parseManifest(JSON.parse(readFileSync(metadataPath, "utf8")));
  if (!samePath(metadata.backupPath, backupPath)) {
    throw new Error(`Backup metadata path does not match the backup: ${backupPath}`);
  }
  if (metadata.projectHash !== projectHash(metadata.projectRoot)) {
    throw new Error(`Backup project identity is invalid: ${backupPath}`);
  }
  const bytes = readFileSync(backupPath);
  if (metadata.databaseBytes !== bytes.byteLength || metadata.databaseSha256 !== sha256(bytes)) {
    throw new Error(`Backup checksum mismatch: ${backupPath}`);
  }
  const snapshot = inspectSnapshot(bytes);
  if (snapshot.schemaVersion !== metadata.schemaVersion) {
    throw new Error(`Backup metadata does not match the SQLite image: ${backupPath}`);
  }
  return { path: backupPath, manifest: metadata, bytes };
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function quarantinePath(databasePath: string, suffix: string): string {
  return `${databasePath}.${suffix}-${process.pid}-${randomUUID()}`;
}

function renameIfPresent(source: string, destination: string): boolean {
  if (!recordFile(source)) return false;
  renameSync(source, destination);
  return true;
}

function removeIfPresent(path: string): void {
  const record = recordFile(path);
  if (!record) return;
  if (record.isSymbolicLink) throw new Error(`Refusing to remove symbolic link: ${path}`);
  rmSync(path, { force: true });
}

function verifyDatabaseFile(path: string, expectedSha256?: string): void {
  ensurePrivateFile(path, "Restored database");
  const bytes = readFileSync(path);
  if (expectedSha256 && sha256(bytes) !== expectedSha256) {
    throw new Error(`Restored database checksum mismatch: ${path}`);
  }
  const snapshot = inspectSnapshot(bytes);
  if (snapshot.bytes.byteLength !== bytes.byteLength)
    throw new Error(`Restored database is unstable: ${path}`);
}

export function createSqliteBackup(options: BackupOptions): BackupResult {
  const databasePath = assertDatabasePath(options.databasePath, false);
  const projectRoot = assertAbsolutePath(options.projectRoot, "Project root");
  const projectRecord = assertNoSymlink(projectRoot, "Project root", false);
  if (!projectRecord || !projectRecord.isDirectory)
    throw new Error(`Project root must be a directory: ${projectRoot}`);
  const destination = assertDestinationPath(
    databasePath,
    projectRoot,
    options.destination ?? generatedDestination(options),
  );
  const destinationDirectory = dirname(destination);
  ensurePrivateDirectory(destinationDirectory);

  ensurePrivateFile(databasePath, "Database");
  const sourceWalPresent = existsSync(`${databasePath}-wal`);
  const sourceShmPresent = existsSync(`${databasePath}-shm`);
  const snapshot = serializeDatabase(databasePath, quarantinePath(destination, "snapshot"));
  const databaseSha256 = sha256(snapshot.bytes);
  const metadata: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    runtimeVersion: options.runtimeVersion ?? RUNTIME_VERSION,
    bunVersion: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    projectRoot,
    projectHash: projectHash(projectRoot),
    databasePath,
    backupPath: destination,
    databaseSha256,
    databaseBytes: snapshot.bytes.byteLength,
    schemaVersion: snapshot.schemaVersion,
    journalMode: snapshot.journalMode,
    consistency: "sqlite-vacuum-into",
    sourceWalPresent,
    sourceShmPresent,
  };

  atomicWrite(destination, snapshot.bytes);
  try {
    atomicWrite(
      metadataPathFor(destination),
      Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    );
    ensurePrivateFile(destination, "Backup");
    ensurePrivateFile(metadataPathFor(destination), "Backup metadata");
  } catch (error) {
    removeIfPresent(destination);
    removeIfPresent(metadataPathFor(destination));
    throw error;
  }
  return {
    backupPath: destination,
    metadataPath: metadataPathFor(destination),
    manifest: metadata,
  };
}

export function createSqliteBackupIfPresent(options: BackupOptions): BackupResult | null {
  const databasePath = assertDatabasePath(options.databasePath, true);
  if (!existsSync(databasePath)) return null;
  return createSqliteBackup({ ...options, databasePath });
}

export function readSqliteBackup(backupPath: string): BackupResult {
  const backup = readBackup(backupPath);
  return {
    backupPath: backup.path,
    metadataPath: metadataPathFor(backup.path),
    manifest: backup.manifest,
  };
}

export function restoreSqliteBackup(options: RestoreOptions): RestoreResult {
  const backup = readBackup(options.backupPath);
  const databasePath = assertDatabasePath(options.databasePath, true);
  const projectRoot = assertAbsolutePath(options.projectRoot, "Project root");
  if (!samePath(backup.manifest.projectRoot, projectRoot)) {
    throw new Error(`Backup belongs to another project: ${backup.manifest.projectRoot}`);
  }
  if (
    options.expectedDatabasePath &&
    !samePath(backup.manifest.databasePath, options.expectedDatabasePath)
  ) {
    throw new Error(`Backup belongs to another database: ${backup.manifest.databasePath}`);
  }
  if (!samePath(backup.manifest.databasePath, databasePath)) {
    throw new Error(`Backup database path does not match target: ${backup.manifest.databasePath}`);
  }
  const targetDirectory = dirname(databasePath);
  ensurePrivateDirectory(targetDirectory);
  const temporaryPath = quarantinePath(databasePath, "restore-staged");
  const originalPath = quarantinePath(databasePath, "restore-original");
  const originalSidecars = new Map<BackupSidecar, string>();
  let originalDatabaseMoved = false;
  let staged = false;
  let targetInstalled = false;
  try {
    atomicWrite(temporaryPath, backup.bytes);
    verifyDatabaseFile(temporaryPath, backup.manifest.databaseSha256);
    staged = true;

    originalDatabaseMoved = renameIfPresent(databasePath, originalPath);
    for (const sidecar of SIDECAR_SUFFIXES) {
      const source = `${databasePath}${sidecar}`;
      const destination = `${originalPath}${sidecar}`;
      if (renameIfPresent(source, destination)) originalSidecars.set(sidecar, destination);
    }
    renameSync(temporaryPath, databasePath);
    staged = false;
    targetInstalled = true;
    verifyDatabaseFile(databasePath, backup.manifest.databaseSha256);

    try {
      if (originalDatabaseMoved) removeIfPresent(originalPath);
      for (const sidecarPath of originalSidecars.values()) removeIfPresent(sidecarPath);
    } catch {
      // The verified target is usable. Keep a previous copy when cleanup is not possible.
    }
    return {
      backupPath: backup.path,
      databasePath,
      databaseSha256: backup.manifest.databaseSha256,
      previousDatabasePath: originalDatabaseMoved ? originalPath : null,
    };
  } catch (error) {
    if (staged) removeIfPresent(temporaryPath);
    if (targetInstalled) {
      removeIfPresent(databasePath);
      for (const sidecar of SIDECAR_SUFFIXES) removeIfPresent(`${databasePath}${sidecar}`);
    }
    if (originalDatabaseMoved) renameSync(originalPath, databasePath);
    for (const [sidecar, sidecarPath] of originalSidecars) {
      renameSync(sidecarPath, `${databasePath}${sidecar}`);
    }
    throw error;
  }
}

export function backupMetadataPath(backupPath: string): string {
  return metadataPathFor(assertAbsolutePath(backupPath, "Backup path"));
}
