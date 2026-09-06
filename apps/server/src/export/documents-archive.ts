// Archivo externo de Documents retirados.
//
// El archivo no forma parte de la Repository Replica. Su destino debe ser
// proporcionado por el operador fuera del repositorio y queda protegido como
// un archivo privado. El formato admite varias fuentes (SQLite, PostgreSQL y
// una captura histórica de la réplica) para que una actualización y un rebuild
// puedan usar el mismo destino sin sobrescribir evidencia.
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const DOCUMENT_ARCHIVE_FORMAT = "prime-board.documents-archive" as const;
export const DOCUMENT_ARCHIVE_VERSION = 1 as const;

export type DocumentArchiveSource = "sqlite" | "postgres" | "replica";
export type DocumentArchiveRecord = Record<string, unknown>;

interface DocumentArchiveSourceData {
  readonly count: number;
  readonly sha256: string;
  readonly documents: readonly DocumentArchiveRecord[];
}

interface DocumentArchiveFile {
  readonly format: typeof DOCUMENT_ARCHIVE_FORMAT;
  readonly version: typeof DOCUMENT_ARCHIVE_VERSION;
  readonly createdAt: string;
  readonly count: number;
  readonly sha256: string;
  readonly sources: Readonly<Record<string, DocumentArchiveSourceData>>;
}

export interface DocumentArchiveResult {
  readonly path: string;
  readonly source: string;
  readonly sourceCount: number;
  readonly count: number;
  readonly sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(jsonSafe(value), null, 2)}\n`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizedDocuments(rows: readonly unknown[]): DocumentArchiveRecord[] {
  return rows.map((row) => {
    if (!isRecord(row)) throw new Error("Document archive rows must be objects");
    return jsonSafe(row) as DocumentArchiveRecord;
  });
}

function sourceDigest(documents: readonly DocumentArchiveRecord[]): string {
  return digest(documents);
}

function sourceSummary(documents: readonly DocumentArchiveRecord[]): DocumentArchiveSourceData {
  return {
    count: documents.length,
    sha256: sourceDigest(documents),
    documents,
  };
}

function manifestFor(sources: Readonly<Record<string, DocumentArchiveSourceData>>): {
  count: number;
  sha256: string;
} {
  const summary = Object.fromEntries(
    Object.entries(sources)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, value]) => [source, { count: value.count, sha256: value.sha256 }]),
  );
  return {
    count: Object.values(sources).reduce((total, source) => total + source.count, 0),
    sha256: digest(summary),
  };
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isMissingPath(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function existingPath(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return resolve(realpathSync(candidate));
}

function detectRepositoryRoot(): string | undefined {
  const configured = process.env.PRIME_BOARD_REPO?.trim();
  if (configured) return configured;
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: process.cwd() });
    if (result.exitCode !== 0) return undefined;
    const root = result.stdout.toString().trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function validateArchiveDestination(outputPath: string, repoRoot?: string): string {
  const trimmed = outputPath.trim();
  if (!trimmed) throw new Error("Document archive output path is required");
  const path = resolve(trimmed);
  const parent = existingPath(dirname(path));
  // A path inside any `.prime-board` directory could be committed by mistake.
  if (path.split(sep).includes(".prime-board") || parent.split(sep).includes(".prime-board")) {
    throw new Error("Document archive must be outside the .prime-board directory");
  }
  const repository = repoRoot?.trim() || detectRepositoryRoot();
  if (repository) {
    const repositoryPath = resolve(realpathSync(repository));
    // Check both the lexical destination and its resolved parent. The latter
    // catches a new file below a symlinked directory inside the repository.
    if (pathInside(repositoryPath, path) || pathInside(repositoryPath, parent)) {
      throw new Error("Document archive must be outside the repository");
    }
  }
  let outputStat: ReturnType<typeof lstatSync> | null = null;
  try {
    outputStat = lstatSync(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  if (outputStat?.isSymbolicLink()) {
    throw new Error("Document archive output must not be a symbolic link");
  }
  return path;
}

function assertPrivateArchive(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Document archive must be a regular file with permissions 0600");
  }
}

function parseSourceData(value: unknown, source: string): DocumentArchiveSourceData {
  if (!isRecord(value)) throw new Error(`Invalid document archive source: ${source}`);
  const count = value.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid document archive source: ${source}`);
  }
  if (typeof value.sha256 !== "string" || !Array.isArray(value.documents)) {
    throw new Error(`Invalid document archive source: ${source}`);
  }
  const documents = normalizedDocuments(value.documents);
  if (documents.length !== count || sourceDigest(documents) !== value.sha256) {
    throw new Error(`Document archive checksum mismatch for source: ${source}`);
  }
  return {
    count,
    sha256: value.sha256,
    documents,
  };
}

function parseArchive(value: unknown): DocumentArchiveFile {
  if (
    !isRecord(value) ||
    value.format !== DOCUMENT_ARCHIVE_FORMAT ||
    value.version !== DOCUMENT_ARCHIVE_VERSION ||
    typeof value.createdAt !== "string" ||
    !isRecord(value.sources)
  ) {
    throw new Error("Invalid document archive manifest");
  }
  const sources: Record<string, DocumentArchiveSourceData> = {};
  for (const [source, sourceValue] of Object.entries(value.sources)) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(source)) {
      throw new Error(`Invalid document archive source: ${source}`);
    }
    sources[source] = parseSourceData(sourceValue, source);
  }
  const manifest = manifestFor(sources);
  if (value.count !== manifest.count || value.sha256 !== manifest.sha256) {
    throw new Error("Document archive manifest checksum mismatch");
  }
  return {
    format: DOCUMENT_ARCHIVE_FORMAT,
    version: DOCUMENT_ARCHIVE_VERSION,
    createdAt: value.createdAt,
    count: manifest.count,
    sha256: manifest.sha256,
    sources,
  };
}

function readArchive(path: string): DocumentArchiveFile {
  try {
    assertPrivateArchive(path);
    return parseArchive(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Cannot read document archive ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeArchive(path: string, archive: DocumentArchiveFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Do not weaken an existing operator-owned directory, but always protect the
  // archive file itself. A temporary path makes the manifest visible atomically.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, stableJson(archive), { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  chmodSync(path, 0o600);
}

/**
 * Comprueba que una fuente ya archivada coincide exactamente con las filas
 * actuales. No escribe ni crea el archivo; se usa como puerta antes de una
 * migración destructiva.
 */
export function verifyDocumentRows(
  rows: readonly DocumentArchiveRecord[],
  archivePath: string,
  source: string,
  repoRoot?: string,
): DocumentArchiveResult {
  if (!/^[a-z][a-z0-9_-]*$/u.test(source)) {
    throw new Error(`Invalid document archive source: ${source}`);
  }
  const path = validateArchiveDestination(archivePath, repoRoot);
  if (!existsSync(path)) {
    throw new Error(`Document archive does not exist: ${path}`);
  }
  const archive = readArchive(path);
  const previous = archive.sources[source];
  const documents = normalizedDocuments(rows);
  if (
    !previous ||
    previous.count !== documents.length ||
    previous.sha256 !== sourceDigest(documents)
  ) {
    throw new Error(`Document archive source ${source} does not match the current Documents`);
  }
  return {
    path,
    source,
    sourceCount: previous.count,
    count: archive.count,
    sha256: archive.sha256,
  };
}

/**
 * Agrega una fuente al archivo privado y verifica su checksum antes de
 * devolver. Un mismo source ya archivado solo se acepta si es idéntico.
 */
export function archiveDocumentRows(
  rows: readonly DocumentArchiveRecord[],
  outputPath: string,
  source: string,
  repoRoot?: string,
): DocumentArchiveResult {
  if (!/^[a-z][a-z0-9_-]*$/u.test(source)) {
    throw new Error(`Invalid document archive source: ${source}`);
  }
  const path = validateArchiveDestination(outputPath, repoRoot);
  const documents = normalizedDocuments(rows);
  let archive: DocumentArchiveFile;
  if (existsSync(path)) {
    archive = readArchive(path);
    const previous = archive.sources[source];
    if (previous) {
      if (previous.count !== documents.length || previous.sha256 !== sourceDigest(documents)) {
        throw new Error(`Document archive source ${source} does not match the existing archive`);
      }
      // The digest is checked above; retain the existing canonical data and
      // avoid changing its creation timestamp on retries.
      return {
        path,
        source,
        sourceCount: previous.count,
        count: archive.count,
        sha256: archive.sha256,
      };
    }
    const sources = { ...archive.sources, [source]: sourceSummary(documents) };
    const manifest = manifestFor(sources);
    archive = {
      ...archive,
      count: manifest.count,
      sha256: manifest.sha256,
      sources,
    };
    writeArchive(path, archive);
  } else {
    const sources = { [source]: sourceSummary(documents) };
    const manifest = manifestFor(sources);
    archive = {
      format: DOCUMENT_ARCHIVE_FORMAT,
      version: DOCUMENT_ARCHIVE_VERSION,
      createdAt: new Date().toISOString(),
      count: manifest.count,
      sha256: manifest.sha256,
      sources,
    };
    writeArchive(path, archive);
  }
  // Re-read the file. This catches an unexpected filesystem race or malformed
  // output before the caller proceeds with a destructive migration.
  const verified = readArchive(path);
  const sourceData = verified.sources[source];
  if (!sourceData) throw new Error(`Document archive source ${source} was not written`);
  return {
    path,
    source,
    sourceCount: sourceData.count,
    count: verified.count,
    sha256: verified.sha256,
  };
}

/** Valida una captura JSON de la réplica sin modificarla. */
export function readDocumentSnapshot(path: string): DocumentArchiveRecord[] {
  let value: unknown;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error("Documents snapshot must not be a symbolic link");
    }
    if (!stat.isFile()) {
      throw new Error("Documents snapshot must be a regular file");
    }
    // O_NOFOLLOW closes the check/read race: a replacement symlink cannot make
    // this read leave the repository after lstatSync has succeeded.
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedStat = fstatSync(descriptor);
      if (!openedStat.isFile()) {
        throw new Error("Documents snapshot must be a regular file");
      }
      value = JSON.parse(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const message =
      errorCode(error) === "ELOOP"
        ? "Documents snapshot must not be a symbolic link"
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Cannot read Documents snapshot ${path}: ${message}`);
  }
  if (!Array.isArray(value)) throw new Error(`Documents snapshot must be an array: ${path}`);
  return normalizedDocuments(value);
}

/** Archiva el snapshot histórico sin borrarlo del repositorio. */
export function archiveDocumentSnapshot(
  snapshotPath: string,
  outputPath: string,
  source: DocumentArchiveSource | string = "replica",
  repoRoot?: string,
): DocumentArchiveResult {
  return archiveDocumentRows(readDocumentSnapshot(snapshotPath), outputPath, source, repoRoot);
}
