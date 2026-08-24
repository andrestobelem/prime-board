import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

const CREDENTIAL_DIRECTORY = ".prime-board/credentials";

function projectKey(projectRoot: string | null, databasePath: string): string {
  // Debe coincidir con projectCredentialPath() de Prime Agent.
  const scope = projectRoot ? resolve(projectRoot) : `database:${resolve(databasePath)}`;
  return createHash("sha256").update(scope).digest("hex").slice(0, 16);
}

/**
 * Cuando existe un repo se usa el mismo hash que el runtime de Prime Agent.
 * El fallback usa la identidad de la base y del backend cuando no hay PRIME_BOARD_REPO.
 */
export function bootstrapCredentialPath(
  projectRoot: string | null,
  databasePath: string,
  home = homedir(),
): string {
  const homeRoot = resolve(home);
  const credentialsRoot = resolve(homeRoot, CREDENTIAL_DIRECTORY);
  const project = projectRoot ? resolve(projectRoot) : null;
  assertNoProjectSymlink(credentialsRoot, project);
  if (project && (credentialsRoot === project || credentialsRoot.startsWith(`${project}${sep}`))) {
    throw new Error("Bootstrap credentials must be stored outside the project");
  }
  assertNoSymlinkAncestors(credentialsRoot, homeRoot);
  assertExternalCredentialRoot(credentialsRoot, project);
  const fileName = project
    ? `${projectKey(project, databasePath)}.json`
    : `bootstrap-${projectKey(null, databasePath)}.json`;
  return join(credentialsRoot, fileName);
}

export function namedCredentialPath(
  projectRoot: string | null,
  databasePath: string,
  name: string,
  home = homedir(),
): string {
  const label = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!label) throw new Error("Credential name cannot be empty");
  const base = bootstrapCredentialPath(projectRoot, databasePath, home);
  return join(dirname(base), `${basename(base, ".json")}-${label}.json`);
}

function physicalPath(path: string): string {
  let current = resolve(path);
  while (true) {
    try {
      return realpathSync(current);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertNoProjectSymlink(path: string, project: string | null): void {
  const absolutePath = resolve(path);
  const pathRoot = parse(absolutePath).root;
  const physicalProject = project ? physicalPath(project) : null;
  let currentPath = pathRoot;

  for (const component of absolutePath.slice(pathRoot.length).split(sep)) {
    if (!component) continue;
    currentPath = join(currentPath, component);
    try {
      if (!lstatSync(currentPath).isSymbolicLink()) continue;
      const target = readlinkSync(currentPath);
      const targetPath = resolve(dirname(currentPath), target);
      const physicalTarget = physicalPath(targetPath);
      if (
        physicalProject &&
        (physicalTarget === physicalProject ||
          physicalTarget.startsWith(`${physicalProject}${sep}`))
      ) {
        throw new Error(`Credential path cannot contain a symlink: ${currentPath}`);
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
}

function assertNoSymlinkAncestors(path: string, basePath: string): void {
  const absolutePath = resolve(path);
  const absoluteBasePath = resolve(basePath);
  if (absolutePath !== absoluteBasePath && !absolutePath.startsWith(`${absoluteBasePath}${sep}`)) {
    throw new Error("Credential path must be below its base directory");
  }

  let currentPath = absoluteBasePath;
  try {
    if (lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`Credential path cannot contain a symlink: ${currentPath}`);
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return;
  }

  const relativePath = absolutePath.slice(absoluteBasePath.length);
  for (const component of relativePath.split(sep)) {
    if (!component) continue;
    currentPath = join(currentPath, component);
    try {
      if (lstatSync(currentPath).isSymbolicLink()) {
        throw new Error(`Credential path cannot contain a symlink: ${currentPath}`);
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      // Si falta un ancestro, también faltan los ancestros restantes.
      break;
    }
  }
}

function assertExternalCredentialRoot(credentialsRoot: string, project: string | null): void {
  if (!project) return;
  const physicalRoot = physicalPath(credentialsRoot);
  const physicalProject = physicalPath(project);
  if (physicalRoot === physicalProject || physicalRoot.startsWith(`${physicalProject}${sep}`)) {
    throw new Error("Bootstrap credentials must be stored outside the project");
  }
}

function writeCredential(path: string, apiKey: string): string {
  if (!apiKey.trim()) throw new Error("Bootstrap credential cannot be empty");
  const directory = dirname(path);
  const homeRoot = dirname(dirname(directory));
  assertNoSymlinkAncestors(directory, homeRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Comprueba de nuevo después de mkdir. Esto rechaza un symlink creado durante
  // la creación del árbol, antes de seguirlo en una escritura posterior.
  assertNoSymlinkAncestors(directory, homeRoot);
  chmodSync(directory, 0o700);

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ apiKey: apiKey.trim() })}\n`, "utf8");
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
    return path;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

/**
 * Ejecutar esta comprobación antes de sembrar la base evita dejar una base
 * inicializada sin una ruta válida para su credencial.
 */
export function prepareBootstrapCredentialPath(
  projectRoot: string | null,
  databasePath: string,
  home = homedir(),
): string {
  const path = bootstrapCredentialPath(projectRoot, databasePath, home);
  const directory = dirname(path);
  const homeRoot = dirname(dirname(directory));
  assertNoSymlinkAncestors(directory, homeRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(directory, homeRoot);
  chmodSync(directory, 0o700);
  const probePath = `${path}.${process.pid}.${randomUUID()}.probe`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(probePath, "wx", 0o600);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(probePath)) rmSync(probePath, { force: true });
  }
  return path;
}

export function storeBootstrapCredential(
  projectRoot: string | null,
  databasePath: string,
  apiKey: string,
  home = homedir(),
): string {
  return writeCredential(bootstrapCredentialPath(projectRoot, databasePath, home), apiKey);
}

export function storeNamedCredential(
  projectRoot: string | null,
  databasePath: string,
  name: string,
  apiKey: string,
  home = homedir(),
): string {
  return writeCredential(namedCredentialPath(projectRoot, databasePath, name, home), apiKey);
}
