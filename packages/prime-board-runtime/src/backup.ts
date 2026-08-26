import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
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
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { RUNTIME_VERSION } from "./version.ts";

export { RUNTIME_VERSION };
export const BACKUP_FORMAT = 1;

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

/** Rechaza enlaces simbólicos en cada componente existente, no solo en la hoja. */
function isAllowedSystemSymlink(path: string): boolean {
  return process.platform === "darwin" && path === "/var";
}

function assertNoSymlinkParents(path: string, label: string, allowMissingLeaf = true): string {
  const resolvedPath = assertAbsolutePath(path, label);
  const root = parse(resolvedPath).root;
  const segments = relative(root, resolvedPath).split(sep).filter(Boolean);
  let current = root;
  let missing = false;
  for (const segment of segments) {
    current = join(current, segment);
    const record = recordFile(current);
    if (!record) {
      missing = true;
      continue;
    }
    if (record.isSymbolicLink) {
      // macOS expone el árbol temporal del sistema mediante /var. Conserva este
      // alias estable, pero rechaza padres simbólicos controlados por el proyecto.
      if (!isAllowedSystemSymlink(current)) {
        throw new Error(`${label} must not use a symbolic-link parent: ${current}`);
      }
    }
    if (!record.isSymbolicLink && missing && !record.isDirectory) {
      throw new Error(`${label} parent must be a directory: ${current}`);
    }
    if (!record.isSymbolicLink && current !== resolvedPath && !record.isDirectory) {
      throw new Error(`${label} parent must be a directory: ${current}`);
    }
    missing = false;
  }
  if (!allowMissingLeaf && !recordFile(resolvedPath)) {
    throw new Error(`${label} does not exist: ${resolvedPath}`);
  }
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

function isProjectReplicaDirectory(path: string, projectRoot: string): boolean {
  if (samePath(path, join(projectRoot, ".prime-board"))) return true;

  // El runtime también guarda backups y locks debajo de ~/.prime-board. No
  // confundas esa raíz de estado con una réplica del repositorio. Un marcador
  // Git o los directorios de réplica identifican un .prime-board del proyecto.
  const owner = dirname(path);
  if (recordFile(join(owner, ".git"))) return true;
  return ["meta", "issues", "log"].some((name) => {
    const record = recordFile(join(path, name));
    return record?.isDirectory === true;
  });
}

function pathHasReplicaParent(path: string, projectRoot: string): boolean {
  let current = dirname(path);
  while (true) {
    if (basename(current) === ".prime-board" && isProjectReplicaDirectory(current, projectRoot)) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function assertDatabasePath(path: string, allowMissing: boolean): string {
  const databasePath = assertNoSymlinkParents(path, "Database path", allowMissing);
  const record = assertNoSymlink(databasePath, "Database", allowMissing);
  if (record && !record.isFile)
    throw new Error(`Database path must be a regular file: ${databasePath}`);
  for (const sidecar of SIDECAR_SUFFIXES) {
    const sidecarPath = `${databasePath}${sidecar}`;
    const sidecarRecord = recordFile(sidecarPath);
    if (sidecarRecord?.isSymbolicLink) {
      throw new Error(`Database sidecar must not be a symbolic link: ${sidecarPath}`);
    }
    if (sidecarRecord && !sidecarRecord.isFile) {
      throw new Error(`Database sidecar must be a regular file: ${sidecarPath}`);
    }
  }
  return databasePath;
}

function ensurePrivateFile(path: string, label: string): void {
  assertNoSymlinkParents(path, label, false);
  const record = assertNoSymlink(path, label, false);
  if (!record || !record.isFile) throw new Error(`${label} must be a regular file: ${path}`);
  chmodSync(path, DATABASE_MODE);
  const mode = statSync(path).mode & 0o777;
  if (mode !== DATABASE_MODE) throw new Error(`${label} must have mode 0600: ${path}`);
  // Persiste el modo y el contenido antes de publicar la ruta a los consumidores.
  let descriptor: number | null = null;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function ensurePrivateDirectory(path: string): void {
  const directory = assertNoSymlinkParents(path, "Private directory");
  const root = parse(directory).root;
  const segments = relative(root, directory).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let record = recordFile(current);
    let created = false;
    if (!record) {
      mkdirSync(current, { mode: DIRECTORY_MODE });
      record = recordFile(current);
      created = true;
    }
    if (
      !record ||
      (record.isSymbolicLink && !isAllowedSystemSymlink(current)) ||
      (!record.isSymbolicLink && !record.isDirectory)
    ) {
      throw new Error(`Backup directory must be a real directory: ${current}`);
    }
    if (created || current === directory) {
      if (!isAllowedSystemSymlink(current)) chmodSync(current, DIRECTORY_MODE);
    }
    const verified = recordFile(current);
    if (
      !verified ||
      (verified.isSymbolicLink && !isAllowedSystemSymlink(current)) ||
      (!verified.isSymbolicLink && !verified.isDirectory)
    ) {
      throw new Error(`Backup directory changed during creation: ${current}`);
    }
  }
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
  const backupPath = assertNoSymlinkParents(destination, "Backup destination");
  if (
    backupPath === databasePath ||
    SIDECAR_SUFFIXES.some((suffix) => backupPath === `${databasePath}${suffix}`)
  ) {
    throw new Error("Backup destination must not be the live database or its WAL sidecar");
  }
  const replicaPath = join(projectRoot, ".prime-board");
  if (pathHasReplicaParent(backupPath, projectRoot) || isWithin(backupPath, replicaPath)) {
    throw new Error("Backup destination must not be inside a project replica");
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
    // Comprueba otra vez antes de abrir el archivo temporal. El archivo está
    // en el directorio de destino ya creado.
    assertNoSymlinkParents(path, "Atomic destination");
    descriptor = openSync(temporaryPath, "wx", mode);
    assertNoSymlinkParents(temporaryPath, "Atomic temporary file", false);
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
    syncDirectory(dirname(path));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (
      recordFile(temporaryPath) &&
      assertNoSymlinkParents(temporaryPath, "Atomic temporary file")
    ) {
      rmSync(temporaryPath, { force: true });
    }
  }
}

/** Reemplaza un archivo regular de forma atómica y conserva el journal entre fases. */
function atomicReplace(path: string, data: Uint8Array, mode = DATABASE_MODE): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | null = null;
  try {
    assertNoSymlinkParents(path, "Atomic replacement destination");
    descriptor = openSync(temporaryPath, "wx", mode);
    assertNoSymlinkParents(temporaryPath, "Atomic replacement temporary file", false);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, mode);
    const existing = recordFile(path);
    if (existing?.isSymbolicLink || (existing && !existing.isFile)) {
      throw new Error(`Atomic replacement destination must be a regular file: ${path}`);
    }
    renameSync(temporaryPath, path);
    syncDirectory(dirname(path));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (
      recordFile(temporaryPath) &&
      assertNoSymlinkParents(temporaryPath, "Atomic replacement temporary file")
    ) {
      rmSync(temporaryPath, { force: true });
    }
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    // Windows no admite fsync sobre handles de directorio. El contenido y el
    // orden de rename siguen verificados, pero la barrera del directorio no está disponible.
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function durableRename(source: string, destination: string, directory: string): void {
  assertNoSymlinkParents(source, "Durable rename source", false);
  assertNoSymlinkParents(destination, "Durable rename destination");
  assertNoSymlinkParents(directory, "Durable rename directory", false);
  renameSync(source, destination);
  syncDirectory(directory);
}

function durableRemove(path: string, directory: string): void {
  assertNoSymlinkParents(path, "Durable removal path");
  assertNoSymlinkParents(directory, "Durable removal directory", false);
  removeIfPresent(path);
  syncDirectory(directory);
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
  const backupPath = assertNoSymlinkParents(backupPathInput, "Backup path", false);
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
  const manifestProjectRoot = assertNoSymlinkParents(
    metadata.projectRoot,
    "Backup project root",
    false,
  );
  if (metadata.projectHash !== projectHash(manifestProjectRoot)) {
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
  assertNoSymlinkParents(source, "Restore source");
  assertNoSymlinkParents(destination, "Restore quarantine destination");
  const record = recordFile(source);
  if (!record) return false;
  if (record.isSymbolicLink || !record.isFile) {
    throw new Error(`Restore source must be a regular file: ${source}`);
  }
  renameSync(source, destination);
  const moved = recordFile(destination);
  if (!moved || moved.isSymbolicLink || !moved.isFile) {
    throw new Error(`Restore source changed during quarantine: ${source}`);
  }
  return true;
}

function removeIfPresent(path: string): void {
  assertNoSymlinkParents(path, "Removal path");
  const record = recordFile(path);
  if (!record) return;
  if (record.isSymbolicLink) throw new Error(`Refusing to remove symbolic link: ${path}`);
  rmSync(path, { force: true });
}

type RestorePhase = "prepared" | "database-quarantined" | "target-installed";

interface RestoreJournal {
  version: 1;
  phase: RestorePhase;
  databasePath: string;
  directory: string;
  stagedPath: string;
  originalPath: string;
  originalSidecars: Record<BackupSidecar, string>;
  backupPath: string;
  expectedSha256: string;
}

function restoreJournalPath(databasePath: string): string {
  return `${databasePath}.restore.json`;
}

function quarantinePathsAreSafe(journal: RestoreJournal): void {
  const candidates = [
    journal.stagedPath,
    journal.originalPath,
    journal.originalSidecars["-wal"],
    journal.originalSidecars["-shm"],
  ];
  for (const path of candidates) {
    if (!samePath(dirname(path), journal.directory)) {
      throw new Error(`Restore journal path escapes the database directory: ${path}`);
    }
    if (!basename(path).startsWith(`${basename(journal.databasePath)}.restore-`)) {
      throw new Error(`Restore journal path is not a quarantine path: ${path}`);
    }
    assertNoSymlinkParents(path, "Restore quarantine path");
    const record = recordFile(path);
    if (record && (!record.isFile || record.isSymbolicLink)) {
      throw new Error(`Restore quarantine path must be a regular file: ${path}`);
    }
  }
}

function parseRestoreJournal(value: unknown, databasePath: string): RestoreJournal {
  const record = objectRecord(value);
  if (!record || record.version !== 1) throw new Error("Unsupported SQLite restore journal");
  const phase = record.phase;
  if (phase !== "prepared" && phase !== "database-quarantined" && phase !== "target-installed") {
    throw new Error("Invalid SQLite restore journal phase");
  }
  const directory = assertNoSymlinkParents(
    stringField(record, "directory"),
    "Restore journal directory",
    false,
  );
  const journal: RestoreJournal = {
    version: 1,
    phase,
    databasePath: assertNoSymlinkParents(
      stringField(record, "databasePath"),
      "Restore journal database path",
    ),
    directory,
    stagedPath: assertAbsolutePath(stringField(record, "stagedPath"), "Restore staged path"),
    originalPath: assertAbsolutePath(stringField(record, "originalPath"), "Restore original path"),
    originalSidecars: {
      "-wal": assertAbsolutePath(
        stringField(objectRecord(record.originalSidecars) ?? {}, "-wal"),
        "Restore WAL quarantine path",
      ),
      "-shm": assertAbsolutePath(
        stringField(objectRecord(record.originalSidecars) ?? {}, "-shm"),
        "Restore SHM quarantine path",
      ),
    },
    backupPath: assertAbsolutePath(stringField(record, "backupPath"), "Restore backup path"),
    expectedSha256: stringField(record, "expectedSha256"),
  };
  if (
    !samePath(journal.databasePath, databasePath) ||
    !samePath(journal.directory, dirname(databasePath))
  ) {
    throw new Error("SQLite restore journal does not match the database path");
  }
  quarantinePathsAreSafe(journal);
  return journal;
}

function writeRestoreJournal(journal: RestoreJournal): void {
  const path = restoreJournalPath(journal.databasePath);
  atomicReplace(path, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8"));
  ensurePrivateFile(path, "Restore journal");
}

function readRestoreJournal(databasePath: string): RestoreJournal | null {
  const path = restoreJournalPath(databasePath);
  const record = recordFile(path);
  if (!record) return null;
  if (record.isSymbolicLink || !record.isFile) {
    throw new Error(`Restore journal must be a regular file: ${path}`);
  }
  ensurePrivateFile(path, "Restore journal");
  return parseRestoreJournal(JSON.parse(readFileSync(path, "utf8")), databasePath);
}

function removeRestoreJournal(databasePath: string): void {
  const path = restoreJournalPath(databasePath);
  if (!recordFile(path)) return;
  durableRemove(path, dirname(databasePath));
}

function removeLiveSidecar(databasePath: string, sidecar: BackupSidecar, directory: string): void {
  const path = `${databasePath}${sidecar}`;
  const record = recordFile(path);
  if (record?.isSymbolicLink)
    throw new Error(`Database sidecar must not be a symbolic link: ${path}`);
  if (record && !record.isFile) throw new Error(`Database sidecar must be a regular file: ${path}`);
  if (record) durableRemove(path, directory);
}

function cleanRestoreQuarantines(journal: RestoreJournal): void {
  durableRemove(journal.stagedPath, journal.directory);
  durableRemove(journal.originalPath, journal.directory);
  durableRemove(journal.originalSidecars["-wal"], journal.directory);
  durableRemove(journal.originalSidecars["-shm"], journal.directory);
}

function restoreOriginalFromJournal(journal: RestoreJournal): void {
  const directory = journal.directory;
  const target = journal.databasePath;
  const original = recordFile(journal.originalPath);
  if (!original)
    throw new Error(`Restore journal has no original database: ${journal.originalPath}`);
  if (recordFile(target)) durableRemove(target, directory);
  for (const sidecar of SIDECAR_SUFFIXES) {
    const quarantined = journal.originalSidecars[sidecar];
    if (recordFile(quarantined)) {
      removeLiveSidecar(target, sidecar, directory);
      durableRename(quarantined, `${target}${sidecar}`, directory);
    }
  }
  durableRename(journal.originalPath, target, directory);
  verifyLiveDatabaseFile(target);
  durableRemove(journal.stagedPath, directory);
  removeRestoreJournal(target);
}

function finishStagedRestore(journal: RestoreJournal): void {
  const target = journal.databasePath;
  const directory = journal.directory;
  if (recordFile(target)) durableRemove(target, directory);
  for (const sidecar of SIDECAR_SUFFIXES) removeLiveSidecar(target, sidecar, directory);
  if (!recordFile(journal.stagedPath)) {
    throw new Error(`Restore journal has no staged database: ${journal.stagedPath}`);
  }
  durableRename(journal.stagedPath, target, directory);
  verifyDatabaseFile(target, journal.expectedSha256);
  durableRemove(journal.originalPath, directory);
  durableRemove(journal.originalSidecars["-wal"], directory);
  durableRemove(journal.originalSidecars["-shm"], directory);
  removeRestoreJournal(target);
}

/** Completa o revierte un restore interrumpido por un fallo de proceso o host. */
export function recoverSqliteRestore(databasePathInput: string): void {
  const databasePath = assertDatabasePath(databasePathInput, true);
  const journal = readRestoreJournal(databasePath);
  if (!journal) return;

  let targetIsValid = false;
  const target = recordFile(databasePath);
  if (target) {
    if (target.isSymbolicLink || !target.isFile) {
      throw new Error(`Database path must be a regular file: ${databasePath}`);
    }
    try {
      verifyDatabaseFile(databasePath, journal.expectedSha256);
      targetIsValid = true;
    } catch {
      targetIsValid = false;
    }
  }
  if (targetIsValid) {
    cleanRestoreQuarantines(journal);
    removeRestoreJournal(databasePath);
    return;
  }
  if (recordFile(journal.originalPath)) {
    restoreOriginalFromJournal(journal);
    return;
  }
  finishStagedRestore(journal);
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

/** Valida un archivo SQLite activo junto con sus sidecars WAL/SHM. */
function verifyLiveDatabaseFile(path: string): void {
  ensurePrivateFile(path, "Restored database");
  const db = new Database(path, { readonly: true, strict: true });
  try {
    readIntegrity(db);
  } finally {
    db.close();
  }
}

export function createSqliteBackup(options: BackupOptions): BackupResult {
  const projectRoot = assertNoSymlinkParents(options.projectRoot, "Project root", false);
  const projectRecord = assertNoSymlink(projectRoot, "Project root", false);
  if (!projectRecord || !projectRecord.isDirectory)
    throw new Error(`Project root must be a directory: ${projectRoot}`);
  const databasePath = assertDatabasePath(options.databasePath, false);
  if (pathHasReplicaParent(databasePath, projectRoot)) {
    throw new Error("Database path must not be inside a project replica");
  }
  recoverSqliteRestore(databasePath);
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
  const runtimeVersion = options.runtimeVersion ?? RUNTIME_VERSION;
  if (runtimeVersion !== RUNTIME_VERSION) {
    throw new Error(`Runtime version must match the package version: ${RUNTIME_VERSION}`);
  }
  const metadata: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    runtimeVersion,
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
  const projectRoot = assertNoSymlinkParents(options.projectRoot, "Project root", false);
  const databasePath = assertDatabasePath(options.databasePath, true);
  if (pathHasReplicaParent(databasePath, projectRoot)) {
    throw new Error("Database path must not be inside a project replica");
  }
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
  const databasePath = assertDatabasePath(options.databasePath, true);
  const projectRoot = assertNoSymlinkParents(options.projectRoot, "Project root", false);
  if (pathHasReplicaParent(databasePath, projectRoot)) {
    throw new Error("Database path must not be inside a project replica");
  }
  const projectRecord = assertNoSymlink(projectRoot, "Project root", false);
  if (!projectRecord || !projectRecord.isDirectory) {
    throw new Error(`Project root must be a directory: ${projectRoot}`);
  }
  recoverSqliteRestore(databasePath);
  const backup = readBackup(options.backupPath);
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
  const originalSidecars = {
    "-wal": `${originalPath}-wal`,
    "-shm": `${originalPath}-shm`,
  } satisfies Record<BackupSidecar, string>;
  const journal: RestoreJournal = {
    version: 1,
    phase: "prepared",
    databasePath,
    directory: targetDirectory,
    stagedPath: temporaryPath,
    originalPath,
    originalSidecars,
    backupPath: backup.path,
    expectedSha256: backup.manifest.databaseSha256,
  };
  try {
    atomicWrite(temporaryPath, backup.bytes);
    verifyDatabaseFile(temporaryPath, backup.manifest.databaseSha256);
    writeRestoreJournal(journal);

    if (renameIfPresent(databasePath, originalPath)) {
      syncDirectory(targetDirectory);
      journal.phase = "database-quarantined";
      writeRestoreJournal(journal);
    }
    for (const sidecar of SIDECAR_SUFFIXES) {
      const source = `${databasePath}${sidecar}`;
      const destination = originalSidecars[sidecar];
      if (renameIfPresent(source, destination)) {
        syncDirectory(targetDirectory);
        writeRestoreJournal(journal);
      }
    }
    durableRename(temporaryPath, databasePath, targetDirectory);
    journal.phase = "target-installed";
    writeRestoreJournal(journal);
    verifyDatabaseFile(databasePath, backup.manifest.databaseSha256);
    const previousDatabasePath = recordFile(originalPath) ? originalPath : null;
    cleanRestoreQuarantines(journal);
    removeRestoreJournal(databasePath);
    return {
      backupPath: backup.path,
      databasePath,
      databaseSha256: backup.manifest.databaseSha256,
      previousDatabasePath,
    };
  } catch (error) {
    try {
      recoverSqliteRestore(databasePath);
    } catch (recoveryError) {
      const cause = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      throw new Error(`SQLite restore failed and recovery is pending: ${cause}`, {
        cause: recoveryError,
      });
    }
    throw error;
  }
}

export function backupMetadataPath(backupPath: string): string {
  return metadataPathFor(assertNoSymlinkParents(backupPath, "Backup path"));
}
